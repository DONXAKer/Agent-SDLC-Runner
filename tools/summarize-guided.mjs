import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { guidedSuiteSuccess } from './guided-suite-success.ts';

const manifestPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node tools/summarize-guided.mjs <suite.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const latest = new Map(manifest.runs.map(run => [run.caseIndex, run]));
const groups = new Map();
const rows = [];
const median = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
for (const [caseIndex, entry] of manifest.cases.entries()) {
  const run = latest.get(caseIndex);
  const key = `${entry.model}/v${entry.version}`;
  if (!groups.has(key)) groups.set(key, { model: entry.model, version: entry.version, cases: 0, completed: 0, successes: 0, failures: 0,
    environment: 0, incomplete: 0, minutes: [], tokens: [], stageStops: {}, failuresByKind: {}, terminalFailuresByKind: {}, workloadTokens: {}, mutationRuns: 0, beforeMutationTokens: [] });
  const group = groups.get(key); group.cases++;
  if (!run || !['success', 'failed'].includes(run.status)) { group.incomplete++; continue; }
  let result;
  try { result = JSON.parse(readFileSync(join(dirname(manifestPath), '..', `${run.slug}.json`), 'utf8')); }
  catch { group.incomplete++; continue; }
  const failedStage = result.driver?.stages?.findLast(stage => !stage.ok);
  const environment = Boolean(failedStage?.envFailure || ['stage-env-repeat', 'blocked-env-repeat', 'stage-timeout', 'run-timeout'].includes(result.driver?.stopped));
  group.completed++;
  if (environment) group.environment++;
  else if (run.success === true && guidedSuiteSuccess(result)) group.successes++;
  else group.failures++;
  if (Number.isFinite(run.minutes)) group.minutes.push(run.minutes);
  if (Number.isFinite(run.tokens)) group.tokens.push(run.tokens);
  const stop = failedStage?.stage ?? result.driver?.stopped ?? 'unknown';
  if (run.success !== true) group.stageStops[stop] = (group.stageStops[stop] ?? 0) + 1;
  if (failedStage?.failure?.kind) group.terminalFailuresByKind[failedStage.failure.kind] = (group.terminalFailuresByKind[failedStage.failure.kind] ?? 0) + 1;
  const workload = result.guided?.workload;
  for (const [kind, count] of Object.entries(workload?.failures ?? {})) group.failuresByKind[kind] = (group.failuresByKind[kind] ?? 0) + count;
  for (const [purpose, value] of Object.entries(workload?.byPurpose ?? {})) group.workloadTokens[purpose] = (group.workloadTokens[purpose] ?? 0) + value.inputTokens + value.outputTokens;
  if (workload?.firstMutation) { group.mutationRuns++; group.beforeMutationTokens.push(workload.firstMutation.inputTokens + workload.firstMutation.outputTokens); }
  rows.push({ ...entry, slug: run.slug, status: environment ? 'environment' : run.success === true && guidedSuiteSuccess(result) ? 'success' : 'failed',
    stopped: stop, note: failedStage?.note ?? null, failure: failedStage?.failure ?? null, hidden: result.hidden,
    minutes: run.minutes, tokens: run.tokens, firstMutation: workload?.firstMutation ?? null, workload: workload ?? null });
}
const summary = { id: manifest.id, status: manifest.status, codeHash: manifest.codeHash, environment: manifest.environment ?? null,
  planned: manifest.cases.length, completed: rows.length, rows,
  models: [...groups.values()].map(({ minutes, tokens, beforeMutationTokens, ...group }) => ({ ...group,
    medianMinutes: median(minutes), medianTokens: median(tokens), medianTokensBeforeMutation: median(beforeMutationTokens) })) };
const directory = dirname(manifestPath);
writeFileSync(join(directory, 'analysis.json'), JSON.stringify(summary, null, 2) + '\n');
const escape = value => String(value ?? '—').replace(/[\r\n|]+/gu, ' ').slice(0, 700);
const markdown = [`# ${manifest.id}`, '', `Статус: ${manifest.status}; завершено ${rows.length}/${manifest.cases.length}; код: ${manifest.codeHash}.`, '',
  'Успех: handoff, зелёный вердикт, все hidden-тесты и проверки честности. Незавершённые и средовые отказы не считаются содержательными ошибками модели.', '',
  '| Модель | Версия | Успехи | Ошибки задачи | Среда | Незавершено | Медиана минут | Медиана токенов | Прогоны с правкой |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ...summary.models.map(row => `| ${escape(row.model)} | ${row.version} | ${row.successes} | ${row.failures} | ${row.environment} | ${row.incomplete} | ${row.medianMinutes?.toFixed(2) ?? '—'} | ${row.medianTokens ?? '—'} | ${row.mutationRuns} |`), '',
  '| Кейс | Модель | Задача | Версия | Статус | Остановка | Диагноз |', '|---|---|---|---:|---|---|---|',
  ...rows.map(row => `| ${escape(row.slug)} | ${escape(row.model)} | ${escape(row.task)} | ${row.version} | ${row.status} | ${escape(row.stopped)} | ${escape(row.note)} |`), '',
  'Результат smoke с одним повтором не доказывает надёжность или улучшение относительно прежней версии.', ''].join('\n');
writeFileSync(join(directory, 'analysis.md'), markdown);
console.log(JSON.stringify({ manifest: manifestPath, status: summary.status, completed: summary.completed, planned: summary.planned,
  models: summary.models.map(({ model, version, successes, failures, environment, incomplete, stageStops }) => ({ model, version, successes, failures, environment, incomplete, stageStops })) }, null, 2));
