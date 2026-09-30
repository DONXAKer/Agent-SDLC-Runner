import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const totalCases = latest.cases.length;
const availableCases = latest.cases.filter((testCase) => testCase.inputStatus === 'available').length;
const missingCases = latest.cases
  .filter((testCase) => testCase.inputStatus !== 'available')
  .map((testCase) => testCase.id);

const rows = [...records.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([model, { name, report }]) => {
    const available = report.cases.filter((testCase) => testCase.inputStatus === 'available');
    const sampled = available.filter((testCase) => testCase.samples?.length > 0);
    const samples = sampled.flatMap((testCase) => testCase.samples);
    const timeouts = samples.filter((sample) => sample.timedOut).length;
    const verifyCases = report.cases.filter((testCase) => ['V01', 'V02'].includes(testCase.id));
    const verifySamples = verifyCases.flatMap((testCase) => testCase.samples ?? []);
    const verifyCaught = verifySamples.filter((sample) => sample.seedCaught === true).length;
    const preflightCode = report.preflight?.exitCode;
    const preflight = preflightCode === 0
      ? 'PASS'
      : preflightCode === 3221226505
        ? `CRASH ${preflightCode}`
        : `FAIL ${preflightCode ?? 'unknown'}`;
    const semantic = samples.length === 0 ? 'not run' : 'not assessed';
    const link = `../bench/results/${name.replace(/\.json$/u, '.report.md')}`;

    return `| [${model}](${link}) | ${preflight} | ${sampled.length}/${available.length} | ${timeouts} | ${verifySamples.length === 0 ? '—' : `${verifyCaught}/${verifySamples.length}`} | ${semantic} |`;
  });

const content = [
  '# Статус диагностики локальных моделей',
  '',
  `Срез: ${latestDate.slice(0, 10)} · доступно кейсов: ${availableCases}/${totalCases} · нет входных снимков: ${missingCases.length ? missingCases.join(', ') : 'нет'}.`,
  '',
  '| Модель | Preflight | Кейсы | Таймауты | Verify-дефекты пойманы | Смысловая оценка |',
  '|---|---:|---:|---:|---:|---|',
  ...rows,
  '',
].join('\n');

if (!existsSync(dirname(outputPath))) throw new Error(`Missing docs directory for ${outputPath}`);
writeFileSync(outputPath, content, 'utf8');
process.stdout.write(`Updated ${outputPath} with ${rows.length} model profiles.\n`);
