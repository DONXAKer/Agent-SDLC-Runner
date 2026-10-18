/**
 * Совместимость имени артикула: переименование `code` → `sku`.
 *
 * Старая строка читается, новая пишется, при обоих именах побеждает `sku`. Это контракт
 * совместимости по README — внешние службы читают файлы, написанные до переименования.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parse, product, serialize } from '../src/index.ts';

describe('совместимость артикула (code → sku)', () => {
  it('старая строка с `code` читается', () => {
    const p = parse('{"code":"A-1","title":"Шуруп 4×40","priceK":100}');
    deepStrictEqual(p, product('A-1', 'Шуруп 4×40', 100));
  });

  it('новая строка с `sku` читается', () => {
    const p = parse('{"sku":"A-1","title":"Шуруп 4×40","priceK":100}');
    deepStrictEqual(p, product('A-1', 'Шуруп 4×40', 100));
  });

  it('serialize пишет `sku`, ключа `code` в строке нет', () => {
    const line = serialize(product('A-1', 'Шуруп 4×40', 100));
    ok(line.startsWith('{"sku":'));
    ok(!line.includes('code'));
    strictEqual(line, '{"sku":"A-1","title":"Шуруп 4×40","priceK":100}');
  });

  it('при обоих именах побеждает `sku`', () => {
    const p = parse('{"code":"СТАРОЕ","sku":"A-1","title":"Шуруп 4×40","priceK":100}');
    strictEqual(p.sku, 'A-1');
  });

  it('строка без артикула ни под каким именем отвергается', () => {
    throws(() => parse('{"title":"Шуруп 4×40","priceK":100}'), TypeError);
  });

  it('round-trip: то, что пишет serialize, читает parse', () => {
    const p = product('B-2', 'Гайка М4', 250);
    deepStrictEqual(parse(serialize(p)), p);
  });
});
