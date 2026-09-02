/**
 * Тесты слотов: пересечение полуинтервалов.
 *
 * Отдельно проверяется касание концами — это тот случай, из-за которого интервал и сделан
 * полуоткрытым: соседние слоты сетки обязаны не пересекаться.
 */

import { strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { overlaps } from '../src/index.ts';
import type { Slot } from '../src/index.ts';

const morning: Slot = { startIso: '2026-03-20T05:00:00Z', endIso: '2026-03-20T07:00:00Z' };
const late: Slot = { startIso: '2026-03-20T06:00:00Z', endIso: '2026-03-20T08:00:00Z' };
const next: Slot = { startIso: '2026-03-20T07:00:00Z', endIso: '2026-03-20T09:00:00Z' };
const inside: Slot = { startIso: '2026-03-20T05:30:00Z', endIso: '2026-03-20T06:30:00Z' };

describe('пересечение слотов', () => {
  it('частично перекрывающиеся слоты пересекаются в обе стороны', () => {
    strictEqual(overlaps(morning, late), true);
    strictEqual(overlaps(late, morning), true);
  });

  it('соседние слоты сетки, касающиеся концами, не пересекаются', () => {
    strictEqual(overlaps(morning, next), false);
    strictEqual(overlaps(next, morning), false);
  });

  it('вложенный слот пересекается с объемлющим', () => {
    strictEqual(overlaps(morning, inside), true);
    strictEqual(overlaps(inside, morning), true);
  });

  it('слот с нечитаемым моментом отвергается, а не считается свободным', () => {
    throws(() => overlaps(morning, { startIso: 'вчера', endIso: '2026-03-20T09:00:00Z' }), RangeError);
  });
});
