/**
 * Таблицы состояния этапа на карточке дашборда: витки на диске и записи драйвера стенда.
 * Вторая — порт `bench/src/report.ts::statusOf`, и разметка исходов здесь та же.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STAGE_ORDER } from '@sdlc-runner/shared';
import type { StageId } from '@sdlc-runner/shared';

import type { EntryProblem } from '../src/run/stages/entry.ts';
import { benchStage, lastRecord, resolveStages } from '../src/dashboard/stageState.ts';
import type { BenchStageRecord, StageFacts } from '../src/dashboard/stageState.ts';

function facts(over: Partial<Record<StageId, Partial<StageFacts>>>, blockers: Partial<Record<StageId, EntryProblem[]>> = {}): StageFacts[] {
  return STAGE_ORDER.map((id) => ({
    id,
    running: false,
    produced: false,
    skipReason: null,
    failedNote: null,
    placeholders: 0,
    blockers: () => blockers[id] ?? [],
    ...over[id],
  }));
}

const states = (r: ReturnType<typeof resolveStages>): string => r.map((s) => `${s.id[0]}:${s.state}`).join(' ');

describe('resolveStages', () => {
  it('приоритет: выполняется → пройден → пропущен → провален', () => {
    const r = resolveStages(
      facts({
        intent: { produced: true },
        explore: { produced: true, failedNote: 'старый провал' },
        ask: { skipReason: 'вопросов нет' },
        plan: { failedNote: 'артефакт не заполнен' },
        chunk: { running: true, failedNote: 'прошлый' },
      }),
    );
    strictEqual(states(r), 'i:done e:done a:skipped p:failed c:running v:notStarted h:notStarted');
    strictEqual(r[2]?.note, 'вопросов нет');
  });

  it('«заблокирован» — только фронт витка, дальше — «не начат»', () => {
    const blocker = { text: 'нет intent.md', blamed: null };
    const r = resolveStages(facts({}, { intent: [blocker], explore: [blocker], plan: [blocker] }));
    strictEqual(states(r), 'i:blocked e:notStarted a:notStarted p:notStarted c:notStarted v:notStarted h:notStarted');
    strictEqual(r[0]?.note, 'нет intent.md');
  });

  it('фронт — после последнего тронутого этапа; виновник получает заметку', () => {
    const r = resolveStages(
      facts(
        { intent: { produced: true }, plan: { produced: true } },
        { ask: [{ text: 'x', blamed: null }], chunk: [{ text: 'files_to_touch пуст', blamed: 'plan' }] },
      ),
    );
    strictEqual(states(r), 'i:done e:notStarted a:notStarted p:done c:blocked v:notStarted h:notStarted');
    strictEqual(r[4]?.blamed, 'plan');
    strictEqual(r[3]?.note, 'вход этапа «chunk» не принял его артефакт');
  });

  it('пока этап идёт, фронт не блокируется', () => {
    const r = resolveStages(facts({ intent: { running: true } }, { explore: [{ text: 'x', blamed: 'intent' }] }));
    strictEqual(r[1]?.state, 'notStarted');
  });

  it('незаполненный артефакт — провал, если дальше ничего не пройдено; иначе пройден с заметкой', () => {
    const alone = resolveStages(facts({ intent: { placeholders: 3 } }));
    strictEqual(alone[0]?.state, 'failed');
    const passed = resolveStages(facts({ intent: { placeholders: 3 }, explore: { produced: true } }));
    strictEqual(passed[0]?.state, 'done');
    strictEqual(passed[0]?.note, 'пройден, в артефакте осталось ‹…› × 3');
  });
});

function rec(stage: StageId, over: Partial<BenchStageRecord> = {}): BenchStageRecord {
  return { stage, chunk: 1, attempt: 1, ok: true, note: '', blockers: [], timedOut: false, skipped: false, ...over };
}

describe('benchStage', () => {
  it('исходы записи драйвера — как в отчёте стенда', () => {
    const records = [
      rec('intent'),
      rec('explore', { closedBy: 'runtime' }),
      rec('ask', { skipped: true, note: 'вопросов нет' }),
      rec('plan'),
      rec('chunk', { ok: false, note: 'артефакт не заполнен' }),
      rec('verify', { blockers: ['нет патча'], blamedStage: 'chunk', ok: false }),
      rec('handoff', { timedOut: true, ok: false }),
    ];
    const all = { kind: 'all' } as const;
    deepStrictEqual(
      STAGE_ORDER.map((s) => benchStage(records, all, s).state),
      ['done', 'done', 'skipped', 'done', 'failed', 'blocked', 'failed'],
    );
    strictEqual(benchStage(records, all, 'explore').note, 'ok (рантайм) — закрыл рантайм, не заявка модели');
    strictEqual(benchStage(records, all, 'verify').blamed, 'chunk');
    strictEqual(benchStage(records, all, 'handoff').note, 'таймаут');
  });

  it('этап-виновник помечается ok⚠', () => {
    const records = [rec('plan'), rec('chunk', { blockers: ['files_to_touch пуст'], blamedStage: 'plan', ok: false })];
    strictEqual(benchStage(records, { kind: 'all' }, 'plan').note, 'ok⚠ — артефакт завалил вход следующего этапа');
  });

  it('замер со снимка: этапы до замеряемого пройдены «из снимка», после — не начаты', () => {
    const mode = { kind: 'stage', stage: 'chunk' } as const;
    const records = [rec('chunk')];
    strictEqual(benchStage(records, mode, 'plan').note, 'из снимка');
    strictEqual(benchStage(records, mode, 'plan').state, 'done');
    strictEqual(benchStage(records, mode, 'handoff').state, 'notStarted');
  });

  it('повторы chunk↔verify: судит последняя запись', () => {
    const records = [rec('verify', { ok: false, note: 'красный' }), rec('chunk', { attempt: 2 }), rec('verify', { attempt: 2 })];
    strictEqual(lastRecord(records, 'verify')?.attempt, 2);
    strictEqual(benchStage(records, { kind: 'all' }, 'verify').state, 'done');
  });
});
