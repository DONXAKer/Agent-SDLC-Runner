/**
 * Совместимость переименования поля `code` → `sku`.
 *
 * Контракт совместимости: старое имя читается (файлы, заведённые до переименования, и
 * отредактированные вручную), новое пишется (ключи `code` в выводе нет вовсе — ни как поля,
 * ни как дубля), при обоих именах в одной строке побеждает `sku`.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parse, product, serialize } from '../src/index.ts';

const screw = product('A-1', 'Шуруп 4×40', 100);

describe('совместимость: code → sku', () => {
  it('старое имя `code` читается', () => {
    deepStrictEqual(parse('{"code":"A-1","title":"Шуруп 4×40","priceK":100}'), screw);
  });

  it('новое имя `sku` пишется, ключа `code` в выводе нет', () => {
    const line = serialize(screw);
    strictEqual(line, '{"sku":"A-1","title":"Шуруп 4×40","priceK":100}');
    ok(!line.includes('"code"'), 'в выводе serialize не должно быть ни поля, ни дубля code');
  });

  it('при обоих именах в строке побеждает `sku`', () => {
    deepStrictEqual(
      parse('{"code":"СТАРЫЙ","sku":"NOVY","title":"Шуруп 4×40","priceK":100}'),
      product('NOVY', 'Шуруп 4×40', 100),
    );
    deepStrictEqual(
      parse('{"sku":"NOVY","code":"СТАРЫЙ","title":"Шуруп 4×40","priceK":100}'),
      product('NOVY', 'Шуруп 4×40', 100),
    );
  });

  it('строка без артикула под любым именем отвергается', () => {
    throws(() => parse('{"title":"Шуруп 4×40","priceK":100}'), TypeError);
  });

  it('round-trip: то, что пишет serialize, читает parse', () => {
    deepStrictEqual(parse(serialize(screw)), screw);
  });
});
