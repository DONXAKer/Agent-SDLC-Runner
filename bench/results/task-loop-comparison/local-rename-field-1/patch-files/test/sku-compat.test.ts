/**
 * Совместимость переименования артикула `code` → `sku`.
 *
 * Старые файлы писали артикул под именем `code`; новые — под `sku`. Контракт: старое имя
 * читается, новое пишется (дубля `code` в выводе нет), при обоих именах побеждает `sku`.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parse, product, serialize } from '../src/index.ts';

const screw = product('A-1', 'Шуруп 4×40', 100);

describe('совместимость code → sku', () => {
  it('старая строка с именем code читается', () => {
    deepStrictEqual(parse('{"code":"A-1","title":"Шуруп 4×40","priceK":100}'), screw);
  });

  it('новая строка с именем sku читается', () => {
    deepStrictEqual(parse('{"sku":"A-1","title":"Шуруп 4×40","priceK":100}'), screw);
  });

  it('serialize пишет sku, а ключа code в выводе нет', () => {
    const line = serialize(screw);
    strictEqual(line, '{"sku":"A-1","title":"Шуруп 4×40","priceK":100}');
    ok(!line.includes('code'));
  });

  it('при обоих именах побеждает sku', () => {
    deepStrictEqual(
      parse('{"code":"STALE","sku":"A-1","title":"Шуруп 4×40","priceK":100}'),
      screw,
    );
  });

  it('строка без обоих имён артикула отвергается', () => {
    throws(() => parse('{"title":"Шуруп 4×40","priceK":100}'), TypeError);
  });
});
