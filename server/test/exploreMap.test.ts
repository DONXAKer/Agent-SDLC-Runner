import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { it } from 'node:test';
import { isNoExploreMapCorrection, parseExploreMap } from '../src/exec/exploreMap.ts';

const paths = ['src/config.ts', 'src/invoice.ts'] as const;
it('accepts a punctuated no-op response when all map candidates were already classified', () => {
  strictEqual(isNoExploreMapCorrection('нет исправлений.'), true);
  strictEqual(isNoExploreMapCorrection(' Нет исправлений! '), true);
  strictEqual(isNoExploreMapCorrection('нет исправлений для файла'), false);
});
it('реальная строка P01 из diagnostic-config-default-reference', () => {
  const parsed = parseExploreMap('1. src/config.ts: BillingConfig, DEFAULT_CONFIG, resolveConfig | добавить опцию defaultDueDays в BillingConfig, установить её значение по умолчанию в 14 дней', paths);
  strictEqual(parsed.accepted.get(paths[0])?.now, 'BillingConfig, DEFAULT_CONFIG, resolveConfig');
  strictEqual(parsed.accepted.get(paths[0])?.change, 'добавить опцию defaultDueDays в BillingConfig, установить её значение по умолчанию в 14 дней');
});
it('P01: путь с функциями после двоеточия, номер уступает подтверждённому пути', () => {
  const parsed = parseExploreMap('9. `src/invoice.ts`: createInvoice | использовать defaultDueDays\n2. src/config.ts | config | добавить настройку', paths);
  deepStrictEqual([...parsed.accepted.values()], [
    { path: paths[1], now: 'createInvoice', change: 'использовать defaultDueDays' },
    { path: paths[0], now: 'config', change: 'добавить настройку' },
  ]);
  deepStrictEqual(parsed.missing, []);
  deepStrictEqual(parsed.rejected, []);
});
it('неизвестный путь и пустое изменение не подменяются номером или догадкой', () => {
  const parsed = parseExploreMap('1. src/unknown.ts: f | изменить\n2. да | createInvoice |', paths);
  strictEqual(parsed.accepted.size, 0);
  strictEqual(parsed.rejected.length, 2);
  deepStrictEqual(parsed.missing, paths);
});
it('частичный ответ сохраняет принятые строки и называет пропущенные', () => {
  const parsed = parseExploreMap('1. да | config | изменить | дополнить', paths);
  deepStrictEqual(parsed.missing, [paths[1]]);
  strictEqual(parsed.accepted.get(paths[0])?.change, 'изменить | дополнить');
});
it('противоречивые строки одного пути требуют уточнения', () => {
  const parsed = parseExploreMap('1. да | config | изменить\n1. нет', paths);
  strictEqual(parsed.accepted.size, 0);
  strictEqual(parsed.rejected.length, 1);
});
it('отрицание с пустым хвостом разделителей принимается, с содержимым — уточняется', () => {
  const ok = parseExploreMap('1. нет | \n2. нет | |', paths);
  strictEqual(ok.accepted.size, 2);
  strictEqual(ok.rejected.length, 0);
  const bad = parseExploreMap('1. нет | config | изменить', paths);
  strictEqual(bad.accepted.size, 0);
  strictEqual(bad.rejected.length, 1);
  const repeatedNo = parseExploreMap('1. нет | нет | нет', paths);
  strictEqual(repeatedNo.accepted.get(paths[0]), null);
  deepStrictEqual(repeatedNo.rejected, []);
  const explainedNo = parseExploreMap('1. нет | - | файл src/config.ts не относится к задаче', paths);
  strictEqual(explainedNo.accepted.get(paths[0]), null);
  deepStrictEqual(explainedNo.rejected, []);
});
it('именованное отрицание принимает только точный путь; утверждение без изменения уточняется', () => {
  const parsed = parseExploreMap('1. src/invoice.ts — нет\n2. src/unknown.ts — нет\n3. src/config.ts — да', paths);
  strictEqual(parsed.accepted.get(paths[1]), null);
  deepStrictEqual(parsed.missing, [paths[0]]);
  strictEqual(parsed.rejected.length, 2);
});
it('accepts a period in the documented negative answer', () => {
  const parsed = parseExploreMap('1. \u043d\u0435\u0442.', paths);
  strictEqual(parsed.accepted.get(paths[0]), null);
  deepStrictEqual(parsed.missing, [paths[1]]);
  deepStrictEqual(parsed.rejected, []);
});

it('accepts an explicit new-file marker with a prose separator', () => {
  const parsed = parseExploreMap('test/new_test.ts (новый) / новые тесты на перенос брони', paths);
  deepStrictEqual(parsed.newFiles, [{ path: 'test/new_test.ts', what: 'новые тесты на перенос брони' }]);
  deepStrictEqual(parsed.rejected, []);
});
