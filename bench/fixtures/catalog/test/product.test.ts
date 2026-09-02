/**
 * Тесты товара: конструктор и его проверки.
 *
 * Записи собираются конструктором, а не литералом: литерал закрепляет в тесте имена полей
 * формата, а формат принадлежит README и store.ts. Тесту здесь важно другое — что запись
 * собралась и что мусор в неё не попадает.
 */

import { strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { product } from '../src/index.ts';

describe('товар', () => {
  it('собирается из артикула, названия и цены', () => {
    const p = product('A-1', 'Шуруп 4×40', 100);
    strictEqual(p.title, 'Шуруп 4×40');
    strictEqual(p.priceK, 100);
  });

  it('пустой артикул отвергается', () => {
    throws(() => product('', 'Шуруп 4×40', 100), RangeError);
    throws(() => product('   ', 'Шуруп 4×40', 100), RangeError);
  });

  it('цена — целые копейки, не меньше нуля', () => {
    throws(() => product('A-1', 'Шуруп 4×40', 10.5), RangeError);
    throws(() => product('A-1', 'Шуруп 4×40', -1), RangeError);
    strictEqual(product('A-1', 'Образец', 0).priceK, 0);
  });
});
