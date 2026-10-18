import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { product, parse, serialize, loadAll, saveAll } from '../src/index.ts';
test('read old and new rows; prefer present sku', () => {
  deepStrictEqual(parse('{"code":"old","title":"Book","priceK":120}'), product('old', 'Book', 120));
  deepStrictEqual(parse('{"sku":"new","title":"Book","priceK":120}'), product('new', 'Book', 120));
  deepStrictEqual(parse('{"code":"old","sku":"new","title":"Book","priceK":120}'), product('new', 'Book', 120));
  throws(() => parse('{"code":"old","sku":"","title":"Book","priceK":120}'));
  throws(() => parse('{"code":"old","sku":null,"title":"Book","priceK":120}'));
});
test('write only sku, preserving field order and JSONL roundtrip', () => {
  const record = product('A1', 'Book', 120);
  strictEqual(serialize(record), '{"sku":"A1","title":"Book","priceK":120}');
  deepStrictEqual(Object.keys(record), ['sku', 'title', 'priceK']);
  deepStrictEqual(loadAll(saveAll([record, product('B2', 'Pen', 0)])), [record, product('B2', 'Pen', 0)]);
});
