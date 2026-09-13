/**
 * `fillTurnsFor` — потолок ходов дозаполнения (`Run.fillFormFields`) от реального числа
 * незакрытых мест, не плоская константа. Живой замер `gemma-4-e4b`/`security-bait`
 * (2026-09-13): 17 мест, плоский потолок 12 — добор остановился на 11/17, не дойдя до
 * каждого поля хотя бы раз.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fillTurnsFor } from '../src/run/Run.ts';

describe('fillTurnsFor', () => {
  it('маленький журнал (единицы мест) — пол 12, как раньше', () => {
    strictEqual(fillTurnsFor(0), 12);
    strictEqual(fillTurnsFor(3), 12);
  });

  it('большой отчёт (17 мест) — потолок растёт с запасом под добор списков', () => {
    strictEqual(fillTurnsFor(17), 23);
  });

  it('потолок не растёт бесконечно — есть верхняя граница', () => {
    strictEqual(fillTurnsFor(1000), 60);
  });
});
