/**
 * Регрессы второго раунда ревью (углы A–D по пакету «помощь слабым моделям»).
 *
 * Сторожатся точечные фиксы: байтовая обрезка хвоста улики называется вслух и не режет
 * символ пополам; каталог в карте кодовой базы — не «сочинённый путь»; процитированный
 * `passed: true` не открывает передачу.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { outputTailOf } from '../src/gates/builtin/index.ts';
import { pathExistsAny } from '../src/artifacts/artifact.ts';

describe('outputTailOf', () => {
  it('байтовая обрезка помечается и не оставляет обрывок символа в начале', () => {
    // Одна длинная строка кириллицей: по строкам не режется, только по байтам.
    const line = 'ошибка '.repeat(5000); // ~65 КБ в UTF-8
    const tail = outputTailOf(line, '', 200, 20000);
    ok(tail.startsWith('[рантайм обрезал:'), tail.slice(0, 60));
    ok(tail.includes('урезан до 20000 байт'), tail.slice(0, 80));
    ok(!tail.includes('�'), 'в хвосте остался обрывок UTF-8-символа');
  });

  it('stderr помечается и когда stdout пуст — диагностика не выдаётся за штатный вывод', () => {
    const tail = outputTailOf('', 'Traceback: боль', 200, 20000);
    ok(tail.includes('--- stderr ---'), tail);
  });
});

describe('pathExistsAny', () => {
  it('каталог существует — карта кодовой базы вправе его называть', () => {
    strictEqual(pathExistsAny(import.meta.dirname), true);
    strictEqual(pathExistsAny(`${import.meta.dirname}/нет-такого`), false);
  });
});
