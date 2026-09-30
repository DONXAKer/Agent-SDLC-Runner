import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessDiagnosticSample } from './src/diagnosticSample.ts';
import { checkDiagnosticInput } from './src/diagnosticInputs.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultsDir = join(root, 'bench', 'results');
const outputPath = join(root, 'docs', 'model-diagnostic-status.md');
const records = new Map();

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
      try { return assessDiagnosticSample(JSON.parse(readFileSync(path, 'utf8')), sample.slug, sample.exitCode, testCase.stage, testCase.expectedBlocked); }
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
    const semantic = sampled.length === 0 ? 'not run' : 'not assessed';
    const problems = new Map();
    for (const sample of samples) for (const code of sample.problemCodes ?? []) problems.set(code, (problems.get(code) ?? 0) + 1);
    for (const testCase of cases.filter((entry) => entry.inputStatus === 'invalid-snapshot')) problems.set('INPUT_INVALID', (problems.get('INPUT_INVALID') ?? 0) + 1);
    const failedChecks = (report.preflight?.checks ?? []).filter((check) => !check.ok);
    const detail = failedChecks.map((check) => `${check.env ? 'ENV' : 'MODEL'}: ${check.detail}`).join('; ');
    const signals = [...problems].map(([code, count]) => `${code} (${count})`).join('; ') || (preflightCode === 0 ? '—' : detail || 'preflight; см. отчёт');
    const link = `../bench/results/${name.replace(/\.json$/u, '.report.md')}`;

    return `| [${model}](${link}) | ${preflight} | ${sampled.length}/${availableCases} | ${timeouts} | ${verifySamples.length === 0 ? 'не измерено' : `${verifyCaught}/${verifySamples.length}`} | ${signals.replaceAll('|', '\\|').replaceAll('\n', ' ')} | ${semantic} |`;
  });

const content = [
  '# Статус диагностики локальных моделей',
  '',
  `Срез: ${latestDate.slice(0, 10)} · доступно кейсов: ${availableCases}/${totalCases} · нет входных снимков: ${missingCases.length ? missingCases.join(', ') : 'нет'}.`,
  '',
  '| Модель | Preflight | Запущено / доступно | Таймауты | Verify-дефекты пойманы | Проблемы | Смысловая оценка |',
  '|---|---:|---:|---:|---:|---|---|',
  ...rows,
  '',
].join('\n');

if (!existsSync(dirname(outputPath))) throw new Error(`Missing docs directory for ${outputPath}`);
writeFileSync(outputPath, content, 'utf8');
process.stdout.write(`Updated ${outputPath} with ${rows.length} model profiles.\n`);
