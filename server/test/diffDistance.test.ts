/**
 * Мера близости двух патчей.
 *
 * Проверяется на реальной форме unified diff, а не на выдуманных строках: смысл меры в
 * том, чтобы отличать сдвиг номеров строк от настоящего изменения, и подтвердить это можно
 * только на настоящих заголовках.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffCloseness } from '../src/run/diffDistance.ts';

const patch = (file: string, ...hunks: string[]): string =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, ...hunks].join('\n');

const hunk = (header: string, ...body: string[]): string => [header, ...body].join('\n');

describe('близость патчей', () => {
  it('побайтово одинаковые патчи дают 1', () => {
    const p = patch('src/a.ts', hunk('@@ -1,3 +1,4 @@', ' const a = 1;', '+const b = 2;'));
    strictEqual(diffCloseness(p, p), 1);
  });

  it('съехавшие номера строк не считаются изменением', () => {
    const before = patch('src/a.ts', hunk('@@ -1,3 +1,4 @@', ' const a = 1;', '+const b = 2;'));
    // Та же правка, но выше по файлу что-то добавили — номера сдвинулись, тело то же.
    const after = patch('src/a.ts', hunk('@@ -40,3 +41,4 @@', ' const a = 1;', '+const b = 2;'));
    strictEqual(diffCloseness(before, after), 1);
  });

  it('хвост заголовка после @@ на меру не влияет', () => {
    const before = patch('src/a.ts', hunk('@@ -1,3 +1,4 @@ function foo()', ' x', '+y'));
    const after = patch('src/a.ts', hunk('@@ -1,3 +1,4 @@ function bar(a: number)', ' x', '+y'));
    strictEqual(diffCloseness(before, after), 1);
  });

  it('перестановка hunks местами не считается изменением', () => {
    const h1 = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    const h2 = hunk('@@ -20,2 +21,3 @@', ' b', '+two');
    strictEqual(diffCloseness(patch('src/a.ts', h1, h2), patch('src/a.ts', h2, h1)), 1);
  });

  it('добавленный новый hunk даёт близость строго меньше 1 только со стороны нового патча', () => {
    const h1 = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    const h2 = hunk('@@ -20,2 +21,3 @@', ' b', '+two');
    // Прежние hunks на месте, к ним добавлен ещё один: всё прошлое нашлось — работа
    // продолжается поверх прежней, а не переделывается.
    strictEqual(diffCloseness(patch('src/a.ts', h1), patch('src/a.ts', h1, h2)), 1);
    // Обратно: прошлый патч был шире, половина его hunks исчезла.
    strictEqual(diffCloseness(patch('src/a.ts', h1, h2), patch('src/a.ts', h1)), 0.5);
  });

  it('полностью другая правка даёт 0', () => {
    const before = patch('src/a.ts', hunk('@@ -1,2 +1,3 @@', ' a', '+one'));
    const after = patch('src/a.ts', hunk('@@ -1,2 +1,3 @@', ' a', '+совсем другое'));
    strictEqual(diffCloseness(before, after), 0);
  });

  it('одинаковое тело в разных файлах общим не считается', () => {
    const h = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    strictEqual(diffCloseness(patch('src/a.ts', h), patch('src/b.ts', h)), 0);
  });

  it('переименование файла считается изменением', () => {
    const h = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    const before = patch('src/old.ts', h);
    const after = [
      'diff --git a/src/old.ts b/src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      h,
    ].join('\n');
    strictEqual(diffCloseness(before, after), 0);
  });

  it('повтор одного и того же hunk не завышает близость', () => {
    const h = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    // В прошлом патче кусок встречался дважды (в двух файлах), в текущем — один раз.
    const before = [patch('src/a.ts', h), patch('src/b.ts', h)].join('\n');
    const after = patch('src/a.ts', h);
    strictEqual(diffCloseness(before, after), 0.5);
  });

  it('вырожденные входы: считать не из чего — null, а не ноль', () => {
    const h = hunk('@@ -1,2 +1,3 @@', ' a', '+one');
    strictEqual(diffCloseness('', patch('src/a.ts', h)), null);
    strictEqual(diffCloseness('   \n\n', patch('src/a.ts', h)), null);
    // Текст без единого `@@` — не unified diff, сравнивать нечего.
    strictEqual(diffCloseness('просто текст', patch('src/a.ts', h)), null);
    // А вот пустой ТЕКУЩИЙ патч при непустом прошлом — это ноль общего, а не «неприменимо».
    strictEqual(diffCloseness(patch('src/a.ts', h), ''), 0);
  });
});
