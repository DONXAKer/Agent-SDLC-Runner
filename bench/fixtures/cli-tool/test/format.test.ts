/**
 * Тесты форматтера.
 *
 * Стандарт вывода денег — пробел между разрядами — закреплён здесь: formatQuote верна и
 * проверена на сумме больше тысячи, где группировка видна.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatQuote, formatTable } from '../src/index.ts';

describe('formatTable', () => {
  it('колонки выровнены по самой длинной ячейке, разделитель — два пробела', () => {
    strictEqual(formatTable([['msk', 229], ['center', 1_190]]), 'msk     229\ncenter  1 190');
  });

  it('хвостовых пробелов в строке нет', () => {
    strictEqual(formatTable([['a', 'bb'], ['ccc', 'd']]), 'a    bb\nccc  d');
  });

  it('пустая таблица — пустая строка', () => {
    strictEqual(formatTable([]), '');
  });
});

describe('formatQuote', () => {
  it('целые рубли без копеек', () => {
    strictEqual(formatQuote('msk', 2, 45_800), 'msk, 2 кг: 458 ₽');
  });

  it('разряды отделены пробелом', () => {
    strictEqual(formatQuote('ural', 12, 502_800), 'ural, 12 кг: 5 028 ₽');
  });

  it('копейки печатаются только когда они есть', () => {
    strictEqual(formatQuote('msk', 1, 123_456), 'msk, 1 кг: 1 234,56 ₽');
  });
});
