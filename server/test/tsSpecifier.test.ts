/**
 * `resolveTsSpecifier` — общий резолвер кандидатов расширения для гейта «Импорты» и
 * Write/Edit-времени резолвера (`exec/tools/index.ts`).
 *
 * Найдено code-review-all (2026-09-11): специфайер с расширением `.js`, указывающий на
 * реально существующий `.ts`-файл (`./money.js` при наличии `money.ts`), не резолвился —
 * цикл пробовал ДОПИСАТЬ расширение к «.js» (`money.js.ts`), а не ЗАМЕНИТЬ его. Гейт
 * «Импорты» молча пропускал ровно тот класс дефекта, для которого заведён.
 */

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveTsSpecifier } from '../src/fs/tsSpecifier.ts';

function root(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-tsspec-')));
}

describe('resolveTsSpecifier', () => {
  it('точное имя с расширением — exact', () => {
    const dir = root();
    writeFileSync(join(dir, 'money.ts'), 'export const x = 1;\n');
    const r = resolveTsSpecifier(join(dir, 'money.ts'));
    ok(r !== null);
    strictEqual(r.exact, true);
  });

  it('без расширения — достройка до .ts, не exact', () => {
    const dir = root();
    writeFileSync(join(dir, 'money.ts'), 'export const x = 1;\n');
    const r = resolveTsSpecifier(join(dir, 'money'));
    ok(r !== null);
    strictEqual(r.exact, false);
    strictEqual(r.path, join(dir, 'money.ts'));
  });

  it('index.ts каталога — достройка, не exact', () => {
    const dir = root();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'index.ts'), 'export const x = 1;\n');
    const r = resolveTsSpecifier(join(dir, 'sub'));
    ok(r !== null);
    strictEqual(r.path, join(dir, 'sub', 'index.ts'));
  });

  it('.js-специфайер к реально существующему .ts — резолвится заменой расширения, не exact', () => {
    const dir = root();
    writeFileSync(join(dir, 'money.ts'), 'export const x = 1;\n');
    const r = resolveTsSpecifier(join(dir, 'money.js'));
    ok(r !== null, 'специфайер .js к существующему .ts обязан резолвиться');
    strictEqual(r.exact, false);
    strictEqual(r.path, join(dir, 'money.ts'));
  });

  it('.mjs/.cjs/.jsx — та же замена', () => {
    const dir = root();
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    writeFileSync(join(dir, 'b.tsx'), 'export const x = 1;\n');
    strictEqual(resolveTsSpecifier(join(dir, 'a.mjs'))?.path, join(dir, 'a.ts'));
    strictEqual(resolveTsSpecifier(join(dir, 'a.cjs'))?.path, join(dir, 'a.ts'));
    strictEqual(resolveTsSpecifier(join(dir, 'b.jsx'))?.path, join(dir, 'b.tsx'));
  });

  it('.js-специфайер, у которого реально есть .js-файл — берётся он, а не .ts-эквивалент', () => {
    const dir = root();
    writeFileSync(join(dir, 'plain.js'), 'module.exports = {};\n');
    const r = resolveTsSpecifier(join(dir, 'plain.js'));
    ok(r !== null);
    strictEqual(r.exact, true);
    strictEqual(r.path, join(dir, 'plain.js'));
  });

  it('ничего не подходит — null, а не угаданный чужой файл', () => {
    const dir = root();
    strictEqual(resolveTsSpecifier(join(dir, 'ghost.js')), null);
    strictEqual(resolveTsSpecifier(join(dir, 'ghost')), null);
  });
});
