/**
 * `fillRequestBudget` — бюджет запросов дозаполнения по полям от числа полей бланка, а не
 * от лимита ходов этапа. Серия v7 (2026-09-15): лимит стенда 25 → 40 превратил intent в
 * ровно 40 запросов на каждом прогоне, а 34 поля бланка всё равно не закрывались.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fillRequestBudget } from '../src/exec/FormFillExecutor.ts';

describe('fillRequestBudget', () => {
  it('маленький журнал (единицы полей) — пол 12', () => {
    strictEqual(fillRequestBudget(0), 12);
    strictEqual(fillRequestBudget(3), 12);
  });

  it('бланк intent (34 поля) — поле, половина на второй проход и запас под добор листов', () => {
    strictEqual(fillRequestBudget(34), 57);
  });

  it('бюджет не растёт бесконечно — есть верхняя граница', () => {
    strictEqual(fillRequestBudget(1000), 90);
  });
});
