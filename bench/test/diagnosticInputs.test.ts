import { deepStrictEqual, strictEqual, match } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from 'node:test';
import { STAGE_ORDER } from '@sdlc-runner/shared';
import { checkDiagnosticInput, diagnosticCliArgs, hasTaskDecision, type DiagnosticCase } from '../src/diagnosticInputs.ts';
import { parseArgs } from '../src/options.ts';
import { taskById, taskPaths } from '../src/tasks.ts';

it('the real diagnostic command ends at the case boundary and keeps every local control route local', () => {
  const model = 'ollama:test';
  const c: DiagnosticCase = { id: 'I01', task: 'oversize', stage: 'intent', snapshotAfter: null, evaluation: 'scope' };
  const options = parseArgs(diagnosticCliArgs({ model, testCase: c, slug: 'test', timeoutMinutes: 2, snapshot: null, local: true }));
  strictEqual(options.stopAfterStage, 'intent');
  deepStrictEqual(Object.keys(options.controlOverrides).sort(), [...STAGE_ORDER].sort());
  strictEqual(Object.values(options.controlOverrides).every((value) => value === model), true);
});
it('an ask input that the runtime would skip is unavailable for a model measurement', () => {
  const bench = mkdtempSync(join(tmpdir(), 'diagnostic-ask-skip-'));
  try {
    const files = taskPaths(bench, taskById('impossible-without-data'));
    for (const file of [files.taskFile, files.humanFile, files.expectedFile, files.hiddenFile]) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture');
    }
    const root = join(bench, 'snapshots', 'small');
    const witok = join(root, '.sdlc', 'run-small');
    mkdirSync(witok, { recursive: true });
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ task: 'impossible-without-data', stoppedAfterStage: 'explore', slug: 'run-small' }));
    writeFileSync(join(witok, 'intent.md'), '- **Контур:** мелкий\n## Открытые вопросы\n- [ ] **[блокирующий]** Какая ставка?');
    const input = checkDiagnosticInput(bench, { id: 'A02', task: 'impossible-without-data', stage: 'ask', snapshotAfter: 'explore', snapshot: 'small', evaluation: 'question' });
    strictEqual(input.status, 'invalid-snapshot');
    match(input.reason, /ask would skip/);
  } finally { rmSync(bench, { recursive: true, force: true }); }
});
it('matching metadata cannot certify a snapshot with a stale approved plan', () => {
  const bench = mkdtempSync(join(tmpdir(), 'diagnostic-input-'));
  try {
    const paths = taskPaths(bench, taskById('oversize'));
    for (const file of [paths.taskFile, paths.humanFile, paths.expectedFile, paths.hiddenFile]) {
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, '{}');
    }
    const root = join(bench, 'snapshots', 'stale');
    mkdirSync(join(root, '.sdlc', 'reference'), { recursive: true });
    writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ task: 'oversize', stoppedAfterStage: 'chunk', slug: 'reference' }));
    writeFileSync(join(root, '.sdlc', 'reference', 'plan.md'), `# РџР»Р°РЅ\n- **РўСЂРµР±РѕРІР°РЅРёСЏ (SHA-256):** ${'0'.repeat(64)}\n`);
    const input = checkDiagnosticInput(bench, { id: 'V00', task: 'oversize', stage: 'verify', snapshotAfter: 'chunk', snapshot: 'stale', evaluation: 'control' });
    strictEqual(input.status, 'invalid-snapshot');
    match(input.reason, /SHA-256/);
  } finally { rmSync(bench, { recursive: true, force: true }); }
});

it('P01 and P02 require the fixture decision in a complete clarification record', () => {
  const bench = mkdtempSync(join(tmpdir(), 'diagnostic-decision-'));
  try {
    for (const id of ['config-default', 'migration-compat']) {
      const files = taskPaths(bench, taskById(id));
      for (const file of [files.taskFile, files.humanFile, files.expectedFile, files.hiddenFile]) {
        mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'fixture');
      }
      const name = id === 'config-default' ? 'p01' : 'p02';
      const slug = `run-${name}`;
      const snapshot = join(bench, 'snapshots', name);
      const witok = join(snapshot, '.sdlc', slug);
      mkdirSync(witok, { recursive: true });
      writeFileSync(join(snapshot, 'snapshot.json'), JSON.stringify({ task: id, stoppedAfterStage: 'ask', slug }));
      writeFileSync(join(witok, 'intent.md'), id === 'config-default' ? 'defaultDueDays' : 'vatRate');
      writeFileSync(join(witok, 'clarification-report.md'), 'РћС‚РІРµС‚ С‡РµР»РѕРІРµРєР°: 14');
      const testCase: DiagnosticCase = { id: id === 'config-default' ? 'P01' : 'P02', task: id,
        stage: 'plan', snapshotAfter: 'ask', snapshot: name, evaluation: 'decision' };
      strictEqual(checkDiagnosticInput(bench, testCase).status, 'invalid-snapshot');
      strictEqual(hasTaskDecision(testCase.id, id === 'config-default' ? 'defaultDueDays' : 'vatRate', 'Ответ человека: неизвестно'), false);
      if (id === 'migration-compat') writeFileSync(join(witok, 'clarification-report.md'), 'РћС‚РІРµС‚ С‡РµР»РѕРІРµРєР°: Р·РЅР°С‡РµРЅРёРµ 20');
      else writeFileSync(join(witok, 'clarification-report.md'), 'РћС‚РІРµС‚ С‡РµР»РѕРІРµРєР°: defaultDueDays СЂР°РІРµРЅ 14. РЈС‚РѕС‡РЅС‘РЅРЅРѕРµ С‚СЂРµР±РѕРІР°РЅРёРµ СЃРѕРіР»Р°СЃРѕРІР°РЅРѕ.');
      const accepted = id === 'config-default' ? '' : '| 1 | Какая ставка? | да | Для старых записей без ставки — 20. | Сохраняем совместимость |';
      strictEqual(hasTaskDecision(testCase.id, id === 'config-default' ? 'defaultDueDays: 14' : 'vatRate', accepted), true);
    }
  } finally { rmSync(bench, { recursive: true, force: true }); }
});

it('P01 rejects invented questions and scope contradictions; P02 requires a recorded human answer', () => {
  const intent = 'defaultDueDays: 14\n## Чего не делаем\n- Не меняем деньги\n## Открытые вопросы\n- нет открытых вопросов';
  strictEqual(hasTaskDecision('P01', intent, ''), true);
  strictEqual(hasTaskDecision('P01', intent + '\n- [x] **[блокирующий]** Где README.md?', ''), false);
  strictEqual(hasTaskDecision('P01', intent.replace('Не меняем деньги', 'Не трогаем src/config.ts'), ''), false);
  strictEqual(hasTaskDecision('P01', intent, '| 1 | Где README.md? | да | Ответа нет | ‹изменение› |'), false);
  strictEqual(hasTaskDecision('P02', 'vatRate', '| 1 | Какая ставка? | да | 20 | Подтверждено |'), true);
  strictEqual(hasTaskDecision('P02', 'vatRate', 'Значение 20 придумано моделью.'), false);
});
