/** Curate reference plan inputs from recorded local runs, retaining their source and every edit. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WitokPaths } from '../server/src/artifacts/paths.ts';
import { countPlaceholdersExceptDecisions } from '../server/src/artifacts/artifact.ts';
import { writeIntentSnapshot } from '../server/src/artifacts/intentSections.ts';
import { checkDiagnosticInput, hasTaskDecision, type DiagnosticCase } from './src/diagnosticInputs.ts';
import { treeDigest } from './src/diagnostics.ts';

const bench = fileURLToPath(new URL('./', import.meta.url));
const snapshots = join(bench, 'snapshots');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function replaceOne(text: string, old: string | RegExp, value: string, label: string): string {
  const found = typeof old === 'string' ? text.includes(old) : old.test(text);
  if (!found) throw new Error(`source changed, cannot find ${label}`);
  const result = text.replace(old, value);
  if (result === text) throw new Error(`no edit made for ${label}`);
  return result;
}

function prepare(args: { source: string; name: string; id: 'P01' | 'P02'; task: string;
  edit: (paths: WitokPaths) => string[] }): void {
  const sourceRoot = join(snapshots, args.source);
  const dest = join(snapshots, args.name);
  if (!resolve(dest).toLowerCase().startsWith((resolve(snapshots) + sep).toLowerCase())) {
    throw new Error(`snapshot path escapes benchmark directory: ${dest}`);
  }
  if (existsSync(dest)) {
    const existing = JSON.parse(readFileSync(join(dest, 'snapshot.json'), 'utf8'));
    const input = checkDiagnosticInput(bench, { id: args.id, task: args.task, stage: 'plan',
      snapshotAfter: 'ask', snapshot: args.name, evaluation: 'decision' });
    if (existing.inputPreparation?.source !== args.source || input.status !== 'available') {
      throw new Error(`refusing to replace invalid or unrelated snapshot ${args.name}`);
    }
    console.log(`${args.id}: ${args.name}, already accepted`);
    return;
  }
  const sourceMeta = JSON.parse(readFileSync(join(sourceRoot, 'snapshot.json'), 'utf8'));
  if (sourceMeta.task !== args.task || sourceMeta.stoppedAfterStage !== 'ask') throw new Error('wrong source snapshot');
  cpSync(sourceRoot, dest, { recursive: true });
  const paths = new WitokPaths(dest, sourceMeta.slug);
  try {
    const edits = args.edit(paths);
    const meta = { ...sourceMeta, authorModel: 'reference:curated', createdAt: new Date().toISOString(),
      inputPreparation: { kind: 'reviewed-reference', source: args.source, sourceAuthorModel: sourceMeta.authorModel,
        sourceTreeHash: treeDigest(sourceRoot), edits } };
    writeFileSync(join(dest, 'snapshot.json'), JSON.stringify(meta, null, 2) + '\n');
    const testCase: DiagnosticCase = { id: args.id, task: args.task, stage: 'plan', snapshotAfter: 'ask',
      snapshot: args.name, evaluation: 'decision' };
    const input = checkDiagnosticInput(bench, testCase);
    if (input.status !== 'available') {
      const intent = readFileSync(paths.intent, 'utf8');
      const clarification = existsSync(paths.clarificationReport) ? readFileSync(paths.clarificationReport, 'utf8') : '';
      throw new Error(`${args.name}: ${input.reason}; decision=${hasTaskDecision(args.id, intent, clarification)}, intent-placeholders=${countPlaceholdersExceptDecisions(intent)}, report-placeholders=${countPlaceholdersExceptDecisions(clarification)}`);
    }
    console.log(`${args.id}: ${args.name}, accepted from ${args.source}`);
  } catch (error) {
    rmSync(dest, { recursive: true, force: true });
    throw error;
  }
}

prepare({ source: 'matrix-p01-qwen-v4-after-ask-c1-a1', name: 'config-default-plan-reference-v1',
  id: 'P01', task: 'config-default', edit: (paths) => {
    let intent = readFileSync(paths.intent, 'utf8');
    intent = replaceOne(intent, /^- Не трогаем `src\/config\.ts`[^\r\n]*/m,
      '- Не меняем расчёт денежных сумм и округление в `src/money.ts` и `src/lines.ts`.', 'false exclusion');
    intent = replaceOne(intent, /^- \[x\] \*\*\[блокирующий\]\*\* Какой путь к файлу `README\.md`[^\r\n]*\r?\n/m,
      '', 'false README question');
    intent = replaceOne(intent, /^- src\/money\.ts[^\r\n]*\r?\n/m, '', 'money as a file to edit');
    writeFileSync(paths.intent, intent);
    writeIntentSnapshot(paths.intentSections, intent);
    let explore = readFileSync(paths.explorationReport, 'utf8');
    explore = replaceOne(explore, '| src/money.ts | src/money.ts:Kopeck | добавление поля dueDays в Invoice |',
      '| src/money.ts | Kopeck | без изменений; сохраняем денежные операции |', 'false money change');
    writeFileSync(paths.explorationReport, explore);
    rmSync(paths.clarificationReport, { force: true }); // P01 has no human question; ask is conditional.
    if (countPlaceholdersExceptDecisions(intent) !== 0) throw new Error('P01 intent incomplete');
    return ['intent: correct excluded work, remove false README question and money edit; recapture pre-plan sections',
      'explore: mark money unchanged', 'ask: remove report for a skipped conditional stage', `intentSha256=${sha(intent)}`];
  } });

prepare({ source: 'matrix-p02-ask-v2-after-ask-c1-a1', name: 'migration-compat-plan-reference-v1',
  id: 'P02', task: 'migration-compat', edit: (paths) => {
    let report = readFileSync(paths.clarificationReport, 'utf8');
    report = replaceOne(report, '‹одно предложение о цели›',
      'Добавить vatRate без изменения формата JSONL и сохранить чтение старых записей.', 'report goal');
    report = replaceOne(report, '‹что изменилось в задаче›',
      'Для старых записей без vatRate использовать 20; не наследовать ставку соседней записи.', 'decision effect');
    report = replaceOne(report, '‹уточнённое требование и подход›',
      'При отсутствии vatRate в старой записи подставлять подтверждённое человеком значение 20. Конструктор и чтение старых записей используют одну константу; формат остаётся JSONL.', 'resolved requirement');
    report = replaceOne(report, /^- ‹вопрос› — ‹почему допустимо начинать без ответа›\r?\n/m, '', 'unused deferred example');
    if (countPlaceholdersExceptDecisions(report) !== 0) throw new Error('P02 report incomplete');
    writeFileSync(paths.clarificationReport, report);
    let explore = readFileSync(paths.explorationReport, 'utf8');
    explore = replaceOne(explore, '| test/store.test.ts | parse, serialize | обновить тесты для проверки vatRate в цикле round-trip |',
      '| test/store.test.ts | parse, serialize | проверить совместимость существующих тестов без правок |', 'forbidden test edit');
    writeFileSync(paths.explorationReport, explore);
    return ['ask: fill goal, decision effect and resolved requirement from the recorded human answer; remove unused deferred example',
      'explore: keep test/store.test.ts unchanged per task', `reportSha256=${sha(report)}`];
  } });
