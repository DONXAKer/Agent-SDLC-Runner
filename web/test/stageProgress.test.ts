/**
 * Индикатор прогресса витка: «пройден» — это факт `produced` от сервера (артефакты на
 * диске), а не вывод из блокеров. Прежняя эвристика «самый дальний этап без блокеров»
 * врала на этапах с общими предусловиями: у ask и plan блокеры пусты сразу после intent,
 * и во время работающей разведки ask красился пройденным, а plan — текущим.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';

import { computeStageStates, suggestedStage } from '../src/lib/stageProgress.ts';
import type { StageProgressInput } from '../src/lib/stageProgress.ts';

const ORDER: StageId[] = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'];

function stages(unblocked: StageId[], produced: StageId[] = []): StageProgressInput[] {
  return ORDER.map((id) => ({
    id,
    blockers: unblocked.includes(id) ? [] : ['нет артефакта предыдущего этапа'],
    produced: produced.includes(id),
  }));
}

describe('состояние этапов из produced и блокеров', () => {
  it('свежий виток: intent доступен, остальные заблокированы, пройденных нет', () => {
    const st = computeStageStates(stages(['intent']), null);
    strictEqual(st.intent, 'available');
    strictEqual(st.explore, 'blocked');
    strictEqual(st.handoff, 'blocked');
    strictEqual(Object.values(st).includes('done'), false);
  });

  it('общие предусловия не красят непройденное: intent сделан, разведка идёт — ask и plan лишь доступны', () => {
    // Ровно тот случай, из-за которого эвристика frontier была выброшена: у ask и plan
    // блокеры пусты сразу после intent, но пройденным из них не является никто.
    const st = computeStageStates(stages(['intent', 'explore', 'ask', 'plan'], ['intent']), 'explore');
    deepStrictEqual(
      ORDER.map((id) => st[id]),
      ['done', 'running', 'available', 'available', 'blocked', 'blocked', 'blocked'],
    );
  });

  it('идущий этап помечается running независимо от produced и блокеров', () => {
    const st = computeStageStates(stages(['intent', 'explore'], ['intent', 'explore']), 'explore');
    strictEqual(st.explore, 'running');
    strictEqual(st.intent, 'done');
  });

  it('перезапуск раннего этапа: running побеждает его же done', () => {
    const st = computeStageStates(stages(['intent', 'explore', 'ask'], ['intent']), 'intent');
    strictEqual(st.intent, 'running');
    strictEqual(st.explore, 'available');
  });

  it('пройденный этап с непустыми блокерами всё равно done: артефакты на месте', () => {
    // Например, chunk снова требует одобрения плана, но его журнал и патч уже написаны.
    const input = stages(['intent', 'explore', 'ask', 'plan', 'verify'], ['intent', 'explore', 'plan', 'chunk']);
    const st = computeStageStates(input, null);
    strictEqual(st.chunk, 'done');
    strictEqual(st.verify, 'available');
  });

  it('ни одного разблокированного и произведённого — все blocked, а не done', () => {
    const st = computeStageStates(stages([]), null);
    for (const id of ORDER) strictEqual(st[id], 'blocked', id);
  });
});

describe('сид выбранного этапа', () => {
  it('идущий этап важнее всего', () => {
    strictEqual(suggestedStage('chunk', stages(['intent', 'explore'])), 'chunk');
  });

  it('стоящий виток встаёт на первый доступный без артефактов — следующий шаг конвейера', () => {
    strictEqual(
      suggestedStage(null, stages(['intent', 'explore', 'ask', 'plan'], ['intent'])),
      'explore',
    );
  });

  it('все доступные уже отработали — самый дальний из них', () => {
    strictEqual(
      suggestedStage(null, stages(['intent', 'explore'], ['intent', 'explore'])),
      'explore',
    );
  });

  it('нечего предложить — null, а не intent по умолчанию', () => {
    strictEqual(suggestedStage(null, stages([])), null);
  });
});
