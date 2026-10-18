import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessDiagnosticSample } from './src/diagnosticSample.ts';
import { checkDiagnosticInput } from './src/diagnosticInputs.ts';
import { ensureBenchStateDir } from './src/stateDir.ts';
import { readSemanticAssessment } from './src/semanticAssessment.ts';
import { modelReadiness } from './src/modelReadiness.ts';
import { digest, treeDigest } from './src/diagnostics.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
ensureBenchStateDir();
const resultsDir = join(root, 'bench', 'results');
const outputPath = join(root, 'docs', 'model-diagnostic-status.md');
const records = new Map();
const currentSourceHash = digest(['server/src', 'shared/src', 'bench/src', '.claude'].map((dir) =>
  `${dir}:${existsSync(join(root, dir)) ? treeDigest(join(root, dir)) : 'absent'}`).join('\n'));
const cycleCatalog = join(root, 'bench/diagnostics/readiness-cycles.json');
const cycleFiles = existsSync(cycleCatalog) ? JSON.parse(readFileSync(cycleCatalog, 'utf8')).results : [];
const cycles = cycleFiles.flatMap((file) => {
  try {
    const raw = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    return [{ raw, accepted: readSemanticAssessment(root, `cycle:${raw.run.task}`, file)?.outcome === 'pass' }];
  } catch { return []; }
});

for (const name of readdirSync(resultsDir).filter((value) => /^diagnostics-.+\.json$/u.test(value))) {
  let report;
  try {
    report = JSON.parse(readFileSync(join(resultsDir, name), 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    continue;
  }
  if (typeof report.model !== 'string' || !Array.isArray(report.cases)) continue;
  const previous = records.get(report.model);
  if (!previous || Date.parse(report.generatedAt) > Date.parse(previous.report.generatedAt)) {
    records.set(report.model, { name, report });
  }
}

if (records.size === 0) throw new Error(`No model diagnostic reports found in ${resultsDir}`);

const latest = [...records.values()]
  .map(({ report }) => report)
  .sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt))
  .at(-1);
const latestDate = latest.generatedAt;
const manifest = JSON.parse(readFileSync(join(root, 'bench/diagnostics/cases.json'), 'utf8'));
const currentCases = manifest.cases.map((testCase) => ({ ...testCase, inputStatus: checkDiagnosticInput(join(root, 'bench'), testCase).status }));
const totalCases = currentCases.length;
const availableCases = currentCases.filter((testCase) => testCase.inputStatus === 'available').length;
const missingCases = currentCases
  .filter((testCase) => testCase.inputStatus !== 'available')
  .map((testCase) => testCase.id);

const rows = [...records.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([model, { name, report }]) => {
    const cases = report.cases.map((testCase) => ({ ...testCase, samples: (testCase.samples ?? []).map((sample) => {
      const path = sample.resultFile ? resolve(root, sample.resultFile) : join(resultsDir, `${sample.slug}.json`);
      if (!existsSync(path)) return sample;
      try { return assessDiagnosticSample(JSON.parse(readFileSync(path, 'utf8')), sample.slug, sample.exitCode, testCase.stage, testCase.expectedBlocked, testCase.expectedSkipped); }
      catch { return { ...sample, problemCodes: ['INVALID_RESULT'] }; }
    }) }));
    const available = cases.filter((testCase) => testCase.inputStatus === 'available');
    const sampled = available.filter((testCase) => testCase.samples?.some((sample) => sample.stageStarted));
    const samples = cases.flatMap((testCase) => testCase.samples);
    const timeouts = samples.filter((sample) => sample.timedOut).length;
    const verifyCases = cases.filter((testCase) => ['V01', 'V02'].includes(testCase.id));
    const verifySamples = verifyCases.flatMap((testCase) => testCase.samples ?? []).filter((sample) => sample.stageStarted && sample.seedCaught !== null);
    const verifyCaught = verifySamples.filter((sample) => sample.seedCaught === true).length;
    const preflightCode = report.preflight?.exitCode;
    const preflight = preflightCode === 0
      ? 'PASS'
      : preflightCode === 3221226505
        ? `CRASH ${preflightCode}`
        : `FAIL ${preflightCode ?? 'unknown'}`;
    const reviews = cases.flatMap((c) => c.samples.map((sample) => readSemanticAssessment(root, c.id,
      sample.resultFile ?? `bench/results/${sample.slug}.json`)));
    const reviewed = reviews.filter(Boolean);
    const semantic = `${reviewed.length}/${samples.length} оценено; ${reviewed.filter((r) => r.outcome === 'pass').length} принято`;
    const problems = new Map();
    for (const sample of samples) for (const code of sample.problemCodes ?? []) problems.set(code, (problems.get(code) ?? 0) + 1);
    for (const testCase of cases.filter((entry) => entry.inputStatus === 'invalid-snapshot')) problems.set('INPUT_INVALID', (problems.get('INPUT_INVALID') ?? 0) + 1);
    const failedChecks = (report.preflight?.checks ?? []).filter((check) => !check.ok);
    const detail = failedChecks.map((check) => `${check.env ? 'ENV' : 'MODEL'}: ${check.detail}`).join('; ');
    const signals = [...problems].map(([code, count]) => `${code} (${count})`).join('; ') || (preflightCode === 0 ? '—' : detail || 'preflight; см. отчёт');
    const link = `../bench/results/${name.replace(/\.json$/u, '.report.md')}`;
    const results = cases.flatMap((c) => c.samples.flatMap((sample) => {
      const file = sample.resultFile ?? `bench/results/${sample.slug}.json`;
      try { return [{ caseId: c.id, raw: JSON.parse(readFileSync(resolve(root, file), 'utf8')),
        accepted: readSemanticAssessment(root, c.id, file)?.outcome === 'pass', problems: sample.problemCodes ?? [] }]; }
      catch { return []; }
    }));
    const readiness = modelReadiness({ model, currentInputs: availableCases, expectedCases: currentCases.map((c) => c.id),
      currentSourceHash, report, results, cycles });

    return `| [${model}](${link}) | ${preflight} | ${sampled.length}/${cases.length} запусков в отчёте; ${availableCases}/${totalCases} доступно сейчас | ${timeouts} | ${verifySamples.length === 0 ? 'не измерено' : `${verifyCaught}/${verifySamples.length}`} | ${signals.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${semantic} | ${readiness.ready ? 'подтверждена' : `нет: ${readiness.reason}`} |`;
  });

const content = [
  '# Статус диагностики локальных моделей',
  '',
  `Срез: ${latestDate.slice(0, 10)} · доступно кейсов: ${availableCases}/${totalCases} · нет входных снимков: ${missingCases.length ? missingCases.join(', ') : 'нет'}.`,
  '',
  '| Модель | Preflight | Покрытие: отчёт; доступные входы сейчас | Таймауты | Verify-дефекты пойманы | Проблемы | Смысловая оценка | Готовность |',
  '|---|---:|---:|---:|---:|---|---|---|',
  ...rows,
  '',
].join('\n');

if (!existsSync(dirname(outputPath))) throw new Error(`Missing docs directory for ${outputPath}`);
writeFileSync(outputPath, content, 'utf8');
process.stdout.write(`Updated ${outputPath} with ${rows.length} model profiles.\n`);
