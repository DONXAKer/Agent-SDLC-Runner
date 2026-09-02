/**
 * Тесты хранения: round-trip записи и файла.
 *
 * Контракт формата здесь проверяется через round-trip (что записали — то и прочитали), а
 * не через сравнение с эталонной строкой: точная строка — предмет таблицы в README, и её
 * сверяют внешние службы на своей стороне. Отказы parse проверяются на литералах строк —
 * это единственные литералы формата в тестах, и они про то, чего в строке НЕ хватает.
 */

import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadAll, parse, product, saveAll, serialize } from '../src/index.ts';

const screw = product('A-1', 'Шуруп 4×40', 100);
const nut = product('B-2', 'Гайка М4', 250);

describe('строка каталога', () => {
  it('serialize → parse возвращает ту же запись', () => {
    deepStrictEqual(parse(serialize(screw)), screw);
  });

  it('строка одна: переносов внутри нет', () => {
    ok(!serialize(screw).includes('\n'));
  });

  it('строка без цены или с дробной ценой отвергается', () => {
    throws(() => parse('{"code":"A-1","title":"Шуруп 4×40"}'), TypeError);
    throws(() => parse('{"code":"A-1","title":"Шуруп 4×40","priceK":10.5}'), RangeError);
  });

  it('не-JSON и не-объект отвергаются', () => {
    throws(() => parse('не json'), SyntaxError);
    throws(() => parse('[1,2,3]'), TypeError);
  });
});

describe('файл каталога', () => {
  it('saveAll → loadAll возвращает те же записи в том же порядке', () => {
    deepStrictEqual(loadAll(saveAll([screw, nut])), [screw, nut]);
  });

  it('каждая строка файла завершена переводом строки', () => {
    strictEqual(saveAll([screw]).endsWith('\n'), true);
  });

  it('пустые строки и хвостовой перевод строки записями не считаются', () => {
    const text = `${saveAll([screw])}\n\n${serialize(nut)}\n`;
    deepStrictEqual(loadAll(text), [screw, nut]);
  });

  it('пустой файл — пустой каталог', () => {
    deepStrictEqual(loadAll(''), []);
  });
});
