/**
 * Тесты таблицы остатков, поиска и отчёта.
 *
 * Проверяется договорённость инвентаризации — «при дубликате действует первая запись» — и
 * то, что отчёт отвечает так же, как поиск. Значения подобраны по строкам таблицы, чьи
 * комментарии называют их дубликатами.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STOCK_TABLE, WAREHOUSES, findEntry, isWarehouse, stockOf, stockReport, totalQty } from '../src/index.ts';

describe('поиск по таблице остатков', () => {
  it('находит запись по складу и коду позиции', () => {
    deepStrictEqual(findEntry('wh-msk', 'BX-770'), { sku: 'BX-770', qty: 12 });
  });

  it('при дубликате действует первая запись', () => {
    deepStrictEqual(findEntry('wh-msk', 'AZ-123'), { sku: 'AZ-123', qty: 40 });
    deepStrictEqual(findEntry('wh-spb', 'BX-770'), { sku: 'BX-770', qty: 64 });
    deepStrictEqual(findEntry('wh-ekb', 'CQ-015'), { sku: 'CQ-015', qty: 18 });
  });

  it('неизвестная позиция — null, а не исключение', () => {
    strictEqual(findEntry('wh-vld', 'BX-770'), null);
    strictEqual(findEntry('wh-msk', 'ZZ-999'), null);
  });

  it('код склада с границы пакета распознаётся', () => {
    strictEqual(isWarehouse('wh-ekb'), true);
    strictEqual(isWarehouse('wh-xxx'), false);
  });

  it('таблица заполнена для каждого склада', () => {
    for (const wh of WAREHOUSES) {
      strictEqual(STOCK_TABLE[wh].length > 0, true, `склад ${wh}`);
    }
  });
});

describe('остатки по складам', () => {
  it('stockOf раскладывает позицию по складам, отсутствие — 0', () => {
    deepStrictEqual(stockOf('BX-770'), { 'wh-msk': 12, 'wh-spb': 64, 'wh-ekb': 0, 'wh-vld': 0 });
  });

  it('totalQty суммирует по всем складам с учётом правила первой записи', () => {
    // AZ-123: 40 + 8 + 22 + 6 = 76; BX-770: 12 + 64 = 76.
    strictEqual(totalQty(['AZ-123', 'BX-770']), 152);
  });

  it('пустой набор — нулевой остаток', () => {
    strictEqual(totalQty([]), 0);
  });
});

describe('отчёт по складу', () => {
  it('одна строка на позицию, при дубликате — количество первой записи', () => {
    deepStrictEqual(stockReport('wh-spb'), [
      { sku: 'AZ-123', qty: 8 },
      { sku: 'BX-770', qty: 64 },
      { sku: 'DM-402', qty: 2 },
      { sku: 'EK-900', qty: 45 },
      { sku: 'HL-031', qty: 16 },
      { sku: 'CQ-015', qty: 4 },
      { sku: 'GH-555', qty: 60 },
      { sku: 'LM-640', qty: 14 },
    ]);
  });
});
