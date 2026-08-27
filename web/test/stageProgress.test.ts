/**
 * Индикатор прогресса витка: состояние этапов выводится из блокеров, а не из ленты
 * событий — лента усечена буфером и сбрасывается при реконнекте (урок `mergePending`).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';

import { computeStageStates, suggestedStage } from '../src/lib/stageProgress.ts';
import type { StageProgressInput } from '../src/lib/stageProgress.ts';

const ORDER: StageId[] = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'];

function stages(unblocked: StageId[]): StageProgressInput[] {
  return ORDER.map((id) => ({
    id,
    blockers: unblocked.includes(id) ? [] : ['нет артефакта предыдущего этапа'],
  }));
}

describe('состояние этапов из блокеров', () => {
  it('свежий виток: intent доступен, остальные заблокированы, пройденных нет', () => {
    const st = computeStageStates(stages(['intent']), null);
    strictEqual(st.intent, 'available');
    strictEqual(st.explore, 'blocked');
    strictEqual(st.handoff, 'blocked');
    strictEqual(Object.values(st).includes('done'), false);
  });

  it('середина витка: всё до самого дальнего разблокированного — пройдено', () => {
    // intent и explore тоже без блокеров (их можно перезапустить) — done они не потому,
    // что заблокированы, а потому, что frontier ушёл дальше.
    const st = computeStageStates(stages(['intent', 'explore', 'ask', 'plan']), null);
    deepStrictEqual(
      ORDER.map((id) => st[id]),
      ['done', 'done', 'done', 'available', 'blocked', 'blocked', 'blocked'],
    );
  });

  it('идущий этап помечается running независимо от блокеров', () => {
    const st = computeStageStates(stages(['intent', 'explore']), 'explore');
    strictEqual(st.explore, 'running');
    strictEqual(st.intent, 'done');
  });

  it('running побеждает и для этапа перед frontier', () => {
    // Перезапуск раннего этапа: frontier стоит дальше, но крутится именно он.
    const st = computeStageStates(stages(['intent', 'explore', 'ask']), 'intent');
    strictEqual(st.intent, 'running');
    strictEqual(st.ask, 'available');
  });

  it('ни одного разблокированного — все blocked, а не done', () => {
    const st = computeStageStates(stages([]), null);
    for (const id of ORDER) strictEqual(st[id], 'blocked', id);
  });

  it('пройденный этап с непустыми блокерами всё равно done: артефакты дальше уже есть', () => {
    // Например, chunk снова требует одобрения плана, но verify разблокирован —
    // значит, chunk свою работу когда-то сделал.
    const input = stages(['intent', 'explore', 'ask', 'plan', 'verify']);
    const st = computeStageStates(input, null);
    strictEqual(st.chunk, 'done');
    strictEqual(st.verify, 'available');
  });
});

describe('сид выбранного этапа', () => {
  it('идущий этап важнее frontier', () => {
    strictEqual(suggestedStage('chunk', stages(['intent', 'explore'])), 'chunk');
  });

  it('стоящий виток встаёт на самый дальний разблокированный', () => {
    strictEqual(suggestedStage(null, stages(['intent', 'explore', 'ask', 'plan'])), 'plan');
  });

  it('нечего предложить — null, а не intent по умолчанию', () => {
    strictEqual(suggestedStage(null, stages([])), null);
  });
});
