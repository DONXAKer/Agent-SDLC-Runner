/**
 * Эвристика дублей хелперов.
 *
 * Главная планка — не «находит», а «не шумит»: гейт, который кричит на каждом витке,
 * приучает себя игнорировать. Поэтому проверяются прежде всего отсечки: общие имена,
 * короткие имена, тесты, тот же файл.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addedFunctionNames, findDuplicates } from '../src/gates/builtin/duplicates.ts';
import type { DiffLine } from '../src/gates/builtin/logic.ts';

const line = (file: string, text: string, added = true): DiffLine => ({ file, text, added });

describe('имена добавленных функций', () => {
  it('берутся из добавленных строк разных языков', () => {
    const names = addedFunctionNames([
      line('src/a.ts', '+export function formatDate(d) {'),
      line('src/b.py', '+def normalize_path(p):'),
      line('src/c.go', '+func ParseConfig(s string) {'),
    ]).map((x) => x.name);
    ok(names.includes('formatDate'));
    ok(names.includes('normalize_path'));
    ok(names.includes('ParseConfig'));
  });

  it('удалённые строки не считаются добавленными объявлениями', () => {
    strictEqual(addedFunctionNames([line('src/a.ts', '-function gone() {', false)]).length, 0);
  });

  it('слишком общие и короткие имена отбрасываются', () => {
    const names = addedFunctionNames([
      line('src/a.ts', '+function run() {'),
      line('src/a.ts', '+function get() {'),
      line('src/a.ts', '+function fn() {'),
    ]);
    strictEqual(names.length, 0);
  });

  it('тестовые файлы не смотрятся: одноимённые хелперы в тестах — норма', () => {
    strictEqual(
      addedFunctionNames([line('test/helper.test.ts', '+function makeFixture() {')]).length,
      0,
    );
  });
});

describe('поиск одноимённых объявлений', () => {
  const files = {
    'src/utils/date.ts': 'export function formatDate(d) { return d; }\n',
    'src/feature/new.ts': 'export function formatDate(d) { return d; }\n',
    'test/date.test.ts': 'function formatDate() {}\n',
  };
  const read = (f: string): string | null => (files as Record<string, string>)[f] ?? null;

  it('находит одноимённое объявление вне тронутых файлов', () => {
    const found = findDuplicates(
      [{ name: 'formatDate', file: 'src/feature/new.ts' }],
      Object.keys(files),
      read,
    );
    strictEqual(found.length, 1);
    strictEqual(found[0]?.existsIn, 'src/utils/date.ts');
  });

  it('сам изменённый файл не считается дублем самому себе', () => {
    const found = findDuplicates(
      [{ name: 'formatDate', file: 'src/utils/date.ts' }],
      ['src/utils/date.ts'],
      read,
    );
    strictEqual(found.length, 0);
  });

  it('совпадение в общем каталоге показывается раньше прочих', () => {
    const all = {
      'src/feature/new.ts': 'function parseRange() {}\n',
      'src/other/x.ts': 'function parseRange() {}\n',
      'shared/utils.ts': 'function parseRange() {}\n',
    };
    const found = findDuplicates(
      [{ name: 'parseRange', file: 'src/feature/new.ts' }],
      Object.keys(all),
      (f) => (all as Record<string, string>)[f] ?? null,
    );
    strictEqual(found[0]?.existsIn, 'shared/utils.ts');
  });

  it('нечитаемый файл не роняет эвристику', () => {
    const found = findDuplicates(
      [{ name: 'formatDate', file: 'src/feature/new.ts' }],
      ['нет-такого.ts', 'src/utils/date.ts'],
      read,
    );
    strictEqual(found.length, 1);
  });

  it('пустой вход — пустой выход, без чтения дерева', () => {
    let reads = 0;
    strictEqual(
      findDuplicates([], ['a.ts'], () => {
        reads++;
        return 'x';
      }).length,
      0,
    );
    strictEqual(reads, 0);
  });
});
