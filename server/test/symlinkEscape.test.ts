/**
 * Проверка побега через symlink — единственная проверка политики, которой нужен диск.
 *
 * Здесь она проверяется в обе стороны, и вторая сторона важна не меньше первой:
 *
 * - **Ловит.** `vendor -> ../secrets` делает `vendor/id_rsa` лексически внутренним, и все
 *   четыре чистые проверки политики его пропускают.
 * - **Не ловит лишнего.** Отказ по этой причине выглядит как обвинение в подмене пути.
 *   Два случая давали его на пустом месте: корень проекта, сам являющийся симлинком (на
 *   macOS это норма — `/tmp` → `/private/tmp`), и несуществующий или относительный корень,
 *   из-за которого подъём по предкам уходил выше проекта и упирался в рабочий каталог
 *   серверного процесса. Во втором случае отвергалось КАЖДОЕ чтение.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { symlinkEscape } from '../src/approval/symlink.ts';

/** Дерево: `proj/` рядом с `secrets/`, и `proj/vendor` — ссылка на `secrets/`. */
const base = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-symlink-')));
after(() => rmSync(base, { recursive: true, force: true }));

const root = join(base, 'proj');
const secrets = join(base, 'secrets');
mkdirSync(root);
mkdirSync(join(root, 'src'), { recursive: true });
mkdirSync(secrets);
writeFileSync(join(secrets, 'id_rsa'), 'ключ');
writeFileSync(join(root, 'src', 'a.ts'), 'const a = 1;\n');
symlinkSync(secrets, join(root, 'vendor'));

/** Тот же проект, но открытый через ссылку на его корень. */
const linkedRoot = join(base, 'link');
symlinkSync(root, linkedRoot);

describe('побег через symlink ловится', () => {
  it('ссылка на каталог вне проекта — отказ с названной причиной', () => {
    const r = symlinkEscape(root, 'vendor/id_rsa', []);
    ok(r !== null, 'подменённый каталог пропущен');
    ok(r.includes('символическую ссылку'), r);
  });

  it('файла может ещё не быть: канонизируется ближайший существующий предок', () => {
    // Запись в новый файл внутри подменённого каталога — тот же побег.
    ok(symlinkEscape(root, 'vendor/authorized_keys', []) !== null);
  });
});

describe('ложных отказов нет', () => {
  it('обычный путь внутри проекта проходит', () => {
    strictEqual(symlinkEscape(root, 'src/a.ts', []), null);
  });

  it('ещё не созданный файл внутри проекта проходит', () => {
    strictEqual(symlinkEscape(root, 'src/новый.ts', []), null);
  });

  it('корень проекта сам симлинк — это не побег', () => {
    // На macOS корень через `/tmp` или `/var` — обычное дело. Без канонизации ГРАНИЦЫ
    // каждый путь внутри такого проекта выглядел выходом наружу.
    strictEqual(symlinkEscape(linkedRoot, 'src/a.ts', []), null);
  });

  it('через симлинк-корень настоящий побег всё равно виден', () => {
    ok(symlinkEscape(linkedRoot, 'vendor/id_rsa', []) !== null);
  });

  it('несуществующий корень не уводит подъём в каталог процесса', () => {
    // Регрессия: подъём по предкам шёл до корня тома, `D:/work/proj` на POSIX
    // превращался в `.`, тот канонизировался в cwd серверного процесса — и гейт
    // отвергал КАЖДОЕ чтение как побег.
    strictEqual(symlinkEscape('D:/work/proj', 'src/a.ts', []), null);
    strictEqual(symlinkEscape(join(base, 'нет-такого'), 'src/a.ts', []), null);
  });

  it('каталоги, открытые на чтение, тоже сравниваются канонически', () => {
    // Формы методологии лежат вне проекта, и промпт прямым текстом велит их читать.
    strictEqual(symlinkEscape(root, join(secrets, 'id_rsa'), [secrets]), null);
    strictEqual(symlinkEscape(root, 'vendor/id_rsa', [secrets]), null);
  });
});
