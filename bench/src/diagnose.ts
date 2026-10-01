/** Run the available stage-isolated diagnostic cases and compare them with a prior report. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, treeDigest } from './diagnostics.ts';
import { assessDiagnosticSample, type DiagnosticSample } from './diagnosticSample.ts';
import { parseArgs as parseBenchArgs } from './options.ts';
import { formatPreflight, preflightExitCode, runPreflight, type PreflightCheck } from './preflight.ts';
import { checkDiagnosticInput, diagnosticCliArgs, type DiagnosticCase } from './diagnosticInputs.ts';
import { ensureBenchStateDir } from './stateDir.ts';

ensureBenchStateDir();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BENCH = join(ROOT, 'bench');
const RESULTS = join(BENCH, 'results');
const manifest = JSON.parse(readFileSync(join(BENCH, 'diagnostics/cases.json'), 'utf8')) as {
  cases: DiagnosticCase[];
};

type Sample = DiagnosticSample;
interface CaseResult extends DiagnosticCase {
  inputStatus: 'available' | 'missing-input' | 'missing-snapshot' | 'invalid-snapshot';
  inputReason: string; samples: Sample[];
}
interface DiagnosticReport {
  version: 1; generatedAt: string; model: string; repeats: number; preflight: { exitCode: number | null; checks: PreflightCheck[] };
  fingerprint: { gitHead: string | null; sourceHash: string; configHash: string; modelConfigHash: string };
  cases: CaseResult[]; problemCoverage: Array<{ problemId: number; cases: string[]; available: number; total: number; status: string }>;
}

function parseArgs(args: string[]): { model: string; repeats: number; only: string | null; timeout: number; compare: string | null } {
  let model = '', repeats = 5, only: string | null = null, timeout = 30, compare: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    const value = (): string => {
      const next = args[++i];
      if (!next || next.startsWith('--')) throw new Error(`${key} requires a value`);
      return next;
    };
    if (key === '--model') model = value();
    else if (key === '--repeat') repeats = Number(value());
    else if (key === '--case') only = value();
    else if (key === '--stage-timeout') timeout = Number(value());
    else if (key === '--compare') compare = value();
    else if (key === '--help') {
      console.log('Usage: npm run bench:diagnose -- --model <id> [--repeat 5] [--case I01] [--stage-timeout 30] [--compare prior-report.json]');
      process.exit(0);
    } else throw new Error(`Unknown option: ${key}`);
  }
  if (!model) throw new Error('--model is required');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeat must be an integer from 1 to 20');
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--stage-timeout must be positive minutes');
  if (only && !manifest.cases.some((c) => c.id === only)) throw new Error(`Unknown diagnostic case: ${only}`);
  return { model, repeats, only, timeout, compare };
}

function checkInput(c: DiagnosticCase): { status: CaseResult['inputStatus']; reason: string; snapshot: string | null } {
  return checkDiagnosticInput(BENCH, c);
}

function run(args: string[], timeoutMs: number): number | null {
  const proc = spawnSync(process.execPath, ['bench/src/cli.ts', ...args], {
    cwd: ROOT, stdio: 'inherit', timeout: timeoutMs, windowsHide: true,
  });
  if (proc.error) console.error(`Could not start benchmark: ${proc.error.message}`);
  if (proc.signal) console.error(`Benchmark stopped by ${proc.signal}`);
  return proc.status;
}

function sample(slug: string, exitCode: number | null, stage: string, expectedBlocked = false, expectedSkipped = false): Sample {
  const file = join(RESULTS, `${slug}.json`);
  if (!existsSync(file)) return { slug, exitCode, outcome: exitCode === null ? 'execution-error' : 'no-result', semanticAssessment: 'not-assessed', problemCodes: [exitCode === null ? 'EXECUTION_ERROR' : 'NO_RESULT'] };
  try {
    const r = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    return {
      ...assessDiagnosticSample(r, slug, exitCode, stage, expectedBlocked, expectedSkipped),
      resultFile: relative(ROOT, file).replaceAll('\\', '/'),
    };
  } catch (e) {
    return { slug, exitCode, outcome: 'invalid-result', semanticAssessment: 'not-assessed', reason: String(e), problemCodes: ['INVALID_RESULT'] };
  }
}

function recommendations(report: DiagnosticReport): string[] {
  const out: string[] = [];
  const completed = report.cases.flatMap((c) => c.samples).filter((s) => s.stageStarted);
  if (report.preflight.exitCode !== 0) out.push('Исправить среду или конфигурацию по preflight; результаты модельных кейсов не запускались.');
  if (report.cases.some((c) => c.inputStatus !== 'available')) out.push('Подготовить и проверить отсутствующие снимки, чтобы расширить покрытие известных проблем.');
  if (completed.some((s) => s.timedOut)) out.push('Проверить лимит времени на этапах с timeout; сравнить с более высоким лимитом на том же кейсе.');
  if (completed.some((s) => s.outcome === 'stage-failed')) out.push('Разобрать отчёты провалившихся кейсов; менять один параметр за сравнительный запуск.');
  if (completed.some((s) => s.seedCaught === false)) out.push('Для verify проверить обзор diff, передачу посева и инструкции reviewer; сверить находку с чистым контролем V00.');
  if (completed.length && completed.every((s) => s.semanticAssessment === 'not-assessed')) out.push('Смысловая оценка не выполнена: проверить артефакты по чеклистам кейсов перед выводом о качестве.');
  if (out.length === 0) out.push('Механических сигналов для настройки не найдено; оценить содержимое артефактов и сохранить результат как базовый замер.');
  return out;
}

function markdown(r: DiagnosticReport): string {
  const median = (values: number[]): number | null => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : null;
  };
  const rows = r.cases.map((c) => {
    const done = c.samples.filter((s) => s.stageStarted).length;
    const caught = c.samples.filter((s) => s.seedCaught === true).length;
    const failed = c.samples.filter((s) => (s.problemCodes?.length ?? 0) > 0).length;
    const duration = median(c.samples.map((s) => s.durationMs).filter((v): v is number => v !== undefined));
    const tokens = median(c.samples.map((s) => s.tokens).filter((v): v is number => v !== undefined));
    const measured = `t=${duration === null ? '—' : `${Math.round(duration / 1000)}s`}, tokens=${tokens === null ? '—' : tokens}`;
    const status = c.samples.length ? [...new Set(c.samples.flatMap((s) => s.problemCodes ?? []))].join(', ') || 'completed'
      : `${c.inputStatus}: ${c.inputReason}`;
    return `| ${c.id} | ${c.task} / ${c.stage} | ${c.inputStatus} | ${done}/${r.repeats} | ${c.seed ? `${caught}/${done} caught` : `${failed} run findings`}; ${status.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${measured} | not assessed |`;
  });
  const coverage = r.problemCoverage.map((p) => `| ${p.problemId} | ${p.cases.join(', ') || '—'} | ${p.available}/${p.total} | ${p.status} |`);
  return [`# Model diagnostics: ${r.model}`, '', `Generated: ${r.generatedAt}`, `Preflight exit code: ${r.preflight.exitCode ?? 'execution error'}`, ...r.preflight.checks.filter((check) => !check.ok).map((check) => `Preflight problem (${check.env ? 'environment' : 'model'}): ${check.name}: ${check.detail}`), `Source: ${r.fingerprint.sourceHash}`, `Config: ${r.fingerprint.configHash}`, '', '| Case | Task / stage | Input | Started | Mechanical result | Median time / tokens | Semantic review |', '|---|---|---|---:|---|---:|---|', ...rows, '', '## Known problem coverage', '', '| Problem | Cases | Available inputs | Status |', '|---:|---|---:|---|', ...coverage, '', '## Suggestions', '', ...recommendations(r).map((x) => `- ${x}`), '', 'Semantic quality must be reviewed against each case rubric; completion and runtime gates do not establish correctness.', ''].join('\n');
}

function compare(current: DiagnosticReport, priorPath: string): string[] {
  const old = JSON.parse(readFileSync(resolve(priorPath), 'utf8')) as DiagnosticReport;
  const notes: string[] = [];
  const compatible = old.model === current.model && old.fingerprint.sourceHash === current.fingerprint.sourceHash && old.fingerprint.modelConfigHash === current.fingerprint.modelConfigHash;
  notes.push(compatible ? 'Модель и исходники совпадают.' : 'Сравнение ограничено: модель, исходники или настройки модели различаются.');
  const byId = new Map(old.cases.map((c) => [c.id, c]));
  for (const c of current.cases) {
    const prev = byId.get(c.id);
    if (!prev || prev.inputStatus !== 'available' || c.inputStatus !== 'available') continue;
    const beforeSample = prev.samples.find((s) => s.passport);
    const afterSample = c.samples.find((s) => s.passport);
    const sameInput = beforeSample?.passport?.inputHash === afterSample?.passport?.inputHash;
    const sameRuntime = beforeSample?.passport?.sourceHash === afterSample?.passport?.sourceHash && beforeSample?.passport?.configHash === afterSample?.passport?.configHash;
    const countMeasured = (samples: Sample[]): number => samples.filter((s) => s.stageStarted === true).length;
    const before = countMeasured(prev.samples);
    const after = countMeasured(c.samples);
    const status = compatible && sameInput && sameRuntime ? 'сопоставимо' : 'условия различаются';
    notes.push(`${c.id}: измерено ${before}/${old.repeats} → ${after}/${current.repeats} (${status}); проверь артефакты по рубрике.`);
  }
  return notes;
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const modelConfig = readFileSync(join(ROOT, 'config/models.json'), 'utf8');
  const modelDefinitions = (JSON.parse(modelConfig) as { models: Array<{ id: string; [key: string]: unknown }> }).models;
  const modelDefinition = modelDefinitions.find((entry) => entry.id === opts.model);
  if (!modelDefinition) throw new Error(`Unknown model in config/models.json: ${opts.model}`);
  let gitHead: string | null = null;
  try { gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null; } catch { /* optional */ }
  const cases: CaseResult[] = manifest.cases.filter((c) => !opts.only || c.id === opts.only).map((c) => {
    const input = checkInput(c);
    return { ...c, ...{ inputStatus: input.status, inputReason: input.reason, samples: [] } };
  });
  const preflight = await runPreflight(parseBenchArgs(['--model', opts.model, '--preflight', '--quiet']));
  const preflightCode = preflightExitCode(preflight);
  console.log(formatPreflight(preflight));
  const fingerprint = {
    gitHead,
    sourceHash: digest(['server/src', 'shared/src', 'bench/src', '.claude'].map((d) => `${d}:${existsSync(join(ROOT, d)) ? treeDigest(join(ROOT, d)) : 'absent'}`).join('\n')),
    configHash: digest(modelConfig),
    modelConfigHash: digest(JSON.stringify(modelDefinition)),
  };
  if (preflightCode === 0) {
    for (const c of cases) {
      const input = checkInput(c);
      c.inputStatus = input.status;
      c.inputReason = input.reason;
      if (input.status !== 'available') continue;
      for (let i = 1; i <= opts.repeats; i++) {
        const slug = `diag-${opts.model.replace(/[^a-zA-Z0-9_-]/g, '-')}-${c.id.toLowerCase()}-${Date.now()}-${i}`;
        const cliArgs = diagnosticCliArgs({ model: opts.model, testCase: c, slug,
          timeoutMinutes: opts.timeout, snapshot: input.snapshot,
          local: modelDefinition.provider === 'ollama' || modelDefinition.provider === 'lmstudio' });
        const code = run(cliArgs, opts.timeout * 60_000 + 60_000);
        c.samples.push(sample(slug, code, c.stage, c.expectedBlocked, c.expectedSkipped));
      }
    }
  }
  const report: DiagnosticReport = {
    version: 1, generatedAt: new Date().toISOString(), model: opts.model, repeats: opts.repeats,
    preflight: { exitCode: preflightCode, checks: preflight.checks }, fingerprint, cases,
    problemCoverage: Array.from({ length: 26 }, (_, i) => i + 1).map((problemId) => {
      const linked = cases.filter((c) => c.problemIds?.includes(problemId));
      const available = linked.filter((c) => c.inputStatus === 'available').length;
      const nonModel = (problemId >= 16 && problemId <= 20) || problemId === 23 || problemId === 24;
      return {
        problemId, cases: linked.map((c) => c.id), available, total: linked.length,
        status: nonModel ? 'outside model diagnosis' : linked.length === 0 ? 'unmapped' : available === linked.length ? 'inputs available' : 'partial or unavailable inputs',
      };
    }),
  };
  const slug = `diagnostics-${opts.model.replace(/[^a-zA-Z0-9_-]/g, '-')}-${Date.now()}`;
  const jsonPath = join(RESULTS, `${slug}.json`);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const md = [markdown(report), ...(opts.compare ? ['', '## Comparison', '', ...compare(report, opts.compare).map((x) => `- ${x}`), ''] : [])].join('\n');
  writeFileSync(join(RESULTS, `${slug}.report.md`), md, 'utf8');
  console.log(`Diagnostic report: ${jsonPath}`);
  console.log(md);
  if (preflightCode !== 0) return preflightCode ?? 2;
  if (cases.some((c) => c.inputStatus !== 'available')) return 2;
  return cases.some((c) => c.samples.some((s) => (s.problemCodes?.length ?? 0) > 0)) ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }).catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; });
