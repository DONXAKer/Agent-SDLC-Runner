/**
 * Чей расход копится в бюджетный гард (`RunOptions.budgetStages`).
 *
 * Дефект, ради которого правило заведено, пойман живым прогоном 2026-09-07: на стенде
 * измерялась ЛОКАЛЬНАЯ модель на этапе 5, у неё `costUsd === null` — то есть она не
 * потратила ничего, — а виток встал на «бюджет прогона исчерпан: $8.1476 из $5.0000».
 * Потолок выбрал контрольный рецензент на opus, идущий по чужому маршруту. Замер
 * бесплатной модели был недостижим по построению при умолчании `--budget 5`.
 *
 * Это тот же принцип, что уже введён для щупов бенчмарка: судить измеряемую модель, а не
 * всё, что случилось в витке.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StageId } from '@sdlc-runner/shared';

import { countsTowardBudget, SpentLedger } from '../src/run/spentLedger.ts';

const STAGES: StageId[] = ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'];

describe('чей расход копится в бюджет', () => {
  it('прод (`null`) — любой этап, бюджет стережёт деньги проекта целиком', () => {
    for (const stage of STAGES) {
      ok(countsTowardBudget(null, stage), stage);
    }
  });

  it('стенд — считается только измеряемый этап', () => {
    const measured = new Set<StageId>(['chunk']);
    strictEqual(countsTowardBudget(measured, 'chunk'), true);
    strictEqual(countsTowardBudget(measured, 'verify'), false);
    strictEqual(countsTowardBudget(measured, 'plan'), false);
  });

  it('пустое множество — не копится ничего: `--dry-run` без модели не рубится бюджетом', () => {
    strictEqual(countsTowardBudget(new Set<StageId>(), 'chunk'), false);
  });

  it('режим `--all` — измеряемых этапов много, verify всё равно чужой', () => {
    // Ровно раскладка `--all`: измеряемая модель везде, КРОМЕ verify (правило рецензента).
    const measured = new Set<StageId>(['intent', 'explore', 'ask', 'plan', 'chunk', 'handoff']);
    strictEqual(countsTowardBudget(measured, 'chunk'), true);
    strictEqual(countsTowardBudget(measured, 'verify'), false);
  });

  it('воспроизведение дефекта: расход чужого verify не закрывает виток', () => {
    // Числа из живого прогона `bench-gptoss-2gpu`: контрольный opus на verify — $8.1476,
    // измеряемая локальная модель — `null` (цены нет). Потолок $5.
    const ledger = new SpentLedger();
    const measured = new Set<StageId>(['chunk']);

    for (const [stage, cost] of [
      ['chunk', null],
      ['verify', 8.1476],
    ] as const) {
      if (countsTowardBudget(measured, stage)) ledger.add('USD', cost);
    }

    strictEqual(ledger.spent('USD'), 0, 'в бюджет попал расход не измеряемого этапа');
    ok(ledger.spent('USD') < 5, 'виток обязан продолжиться: измеряемая модель бесплатна');
  });

  it('без сужения тот же прогон рубится — то есть кейс выше действительно про правку', () => {
    const ledger = new SpentLedger();
    for (const [stage, cost] of [
      ['chunk', null],
      ['verify', 8.1476],
    ] as const) {
      if (countsTowardBudget(null, stage)) ledger.add('USD', cost);
    }
    ok(ledger.spent('USD') >= 5, 'до правки бюджет выбирал чужой контрольный маршрут');
  });

  it('сужение не мешает раздельному учёту валют', () => {
    // Смешанный профиль: измеряемый этап на рублёвом агрегаторе, чужой — на долларовом.
    const ledger = new SpentLedger();
    const measured = new Set<StageId>(['chunk']);
    if (countsTowardBudget(measured, 'chunk')) ledger.add('RUB', 41.2);
    if (countsTowardBudget(measured, 'verify')) ledger.add('USD', 8.1476);
    strictEqual(ledger.spent('RUB'), 41.2);
    strictEqual(ledger.spent('USD'), 0);
  });
});
