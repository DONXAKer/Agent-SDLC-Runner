/**
 * Тесты выборки партии.
 *
 * Базовая позиция A-1 обязана попадать на контроль: по ней сверяют остальные, и партия без
 * неё считается непроверенной.
 */

import { ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CATALOG, pickBatch } from '../src/index.ts';

describe('выборка партии на контроль', () => {
  it('три позиции без повторов, среди них базовая A-1', () => {
    const batch = pickBatch(CATALOG, 3);
    strictEqual(batch.length, 3);
    strictEqual(new Set(batch).size, 3);
    ok(batch.includes('A-1'), `в партии ${batch.join(', ')} нет базовой позиции A-1`);
  });

  it('партия размером с каталог — весь каталог, каждая позиция по разу', () => {
    const batch = pickBatch(CATALOG, CATALOG.length);
    strictEqual(new Set(batch).size, CATALOG.length);
    for (const sku of CATALOG) ok(batch.includes(sku), `в партии нет ${sku}`);
  });

  it('партия больше каталога не набирается', () => {
    throws(() => pickBatch(CATALOG, CATALOG.length + 1), RangeError);
  });
});
