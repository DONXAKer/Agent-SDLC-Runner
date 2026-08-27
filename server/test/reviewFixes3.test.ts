/**
 * Находки третьего ревью: ложный зелёный ансамбля, ложный красный обязательного гейта,
 * права субагента и разбор unified diff.
 *
 * Каждый кейс здесь охраняет конкретный воспроизведённый дефект, а не «правильность
 * вообще»: без них исправление держится на памяти, а память у следующей правки короткая.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { worstClaimStatus, worstGateStatus } from '@sdlc-runner/shared';

import { fileStats, parseDiff, patchSize } from '../src/diff/parse.ts';
import { diffCloseness } from '../src/run/diffDistance.ts';
import { diffLines, invariantViolations } from '../src/gates/builtin/logic.ts';
import { disableMarkersFor, syntaxCheckerFor, testDeclarationsFor } from '../src/gates/ecosystems/index.ts';
import { parseAgentFile } from '../src/exec/subagents.ts';
import { parseIterations } from '../src/run/iterationsLog.ts';
import { collectVerdictInput } from '../src/verdict/collect.ts';
import { parseGates } from '../src/gates/gatesFile.ts';

describe('разбор unified diff: содержимое строки не заголовок файла', () => {
  // Воспроизведение: патч ОДНОГО файла, где добавленная строка кода сама начинается с
  // `++`. Прежний разбор читал её как `+++ файл` и рапортовал «Файлов: 2».
  const plusPlus = [
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,3 @@',
    ' const x = 1;',
    '+++i;',
    '+const y = 2;',
    '',
  ].join('\n');

  it('строка кода, начинающаяся с ++, не считается вторым файлом', () => {
    deepStrictEqual(patchSize(plusPlus), { files: 1, lines: 2 });
  });

  it('строка кода, начинающаяся с --, не обрывает hunk', () => {
    const patch = (tail: string): string =>
      ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +1,3 @@', ' const x = 1;', '+--- разделитель', tail, ''].join('\n');
    // Два патча различаются ТОЛЬКО последней строкой, идущей после `--- `-строки тела.
    // Прежний разбор терял её вместе с остатком hunk'а и объявлял патчи одинаковыми.
    strictEqual(diffCloseness(patch('+const y = 2;'), patch('+const z = 999;')), 0);
  });

  it('удалённый файл попадает в список: у него нет стороны +++', () => {
    const del = ['--- a/src/gone.ts', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-const x = 1;', ''].join('\n');
    deepStrictEqual(parseDiff(del).files, ['src/gone.ts']);
  });

  it('сокращённые счётчики hunk не склеивают соседние hunk-и', () => {
    // Счётчики в заголовке обещают больше строк, чем есть в теле. `@@` обязан оборвать
    // тело безусловно — иначе второй hunk уехал бы внутрь первого.
    const p = [
      '+++ b/src/a.ts',
      '@@ -1,9 +1,9 @@',
      ' a',
      '@@ -20,9 +21,9 @@',
      ' b',
      '',
    ].join('\n');
    strictEqual(parseDiff(p).hunks.length, 2);
  });
});

describe('fileStats: счётчики на файл — тем же разбором, что и весь остальной diff', () => {
  it('adds/dels не путают строку кода, начинающуюся с ++/--, с заголовком', () => {
    // Регрессия: клиент раньше считал эти же +N/−M своей копией по префиксу и терял обе
    // строки. Здесь единственный источник счётчиков — сервер, разбором по счётчикам hunk'а.
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' const x = 1;',
      '+++i;',
      '-- было',
      '',
    ].join('\n');
    deepStrictEqual(fileStats(patch), [{ path: 'src/a.ts', adds: 1, dels: 1 }]);
  });

  it('несколько файлов в одном патче считаются раздельно', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,2 +1 @@',
      ' x',
      '-y',
      '',
    ].join('\n');
    deepStrictEqual(fileStats(patch), [
      { path: 'a.ts', adds: 1, dels: 0 },
      { path: 'b.ts', adds: 0, dels: 1 },
    ]);
  });
});

describe('diffLines: строка тела с ведущим тире не читается как заголовок', () => {
  it('удалённая строка, чьё содержимое само начинается с «-», остаётся видимой', () => {
    // Раньше `diffLines` отличала заголовок от тела тем же префиксным способом, что и
    // все прежние копии разбора diff: удалённая строка «-1» превращается в diff-строку
    // «--1» и совпадает с `^(---|diff |...)`-фильтром — терялась целиком.
    const diff = ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,1 +0,0 @@', '--1', ''].join('\n');
    deepStrictEqual(diffLines(diff), [{ file: 'src/a.ts', text: '--1', added: false }]);
  });
});

describe('анти-обход тест-гейта: маркеры привязаны к языку', () => {
  const diff = (file: string, ...body: string[]): string =>
    [`--- a/${file}`, `+++ b/${file}`, `@@ -1,${body.filter((l) => !l.startsWith('+')).length} +1,${body.filter((l) => !l.startsWith('-')).length} @@`, ...body, ''].join('\n');

  it('обычный TypeScript не роняет обязательный гейт', () => {
    // Воспроизведение дефекта: ruby приносил маркеры `skip `/`it `, они склеивались по
    // всем экосистемам и сравнивались подстрокой — `let skip = …` и удаление строк со
    // словами `limit`/`unit` роняли гейт, делая зелёный вердикт недостижимым.
    const v = invariantViolations(
      diff('src/other.ts', ' const a = 1;', '+let skip = shouldSkip(x);', '+form.submit();', '-const limit = 5;', '-const unit = 2;'),
      [],
    );
    deepStrictEqual(v, []);
  });

  it('настоящее отключение теста ловится по-прежнему', () => {
    const v = invariantViolations(diff('src/a.test.ts', '+it.skip("падает", () => {});'), []);
    deepStrictEqual(v.map((x) => x.kind), ['test-disabled']);
  });

  it('маркеры ruby действуют в ruby и не действуют в TypeScript', () => {
    ok(disableMarkersFor('app/a_spec.rb').includes('skip '));
    strictEqual(disableMarkersFor('src/a.ts').includes('skip '), false);
    strictEqual(testDeclarationsFor('src/a.ts').includes('it '), false);
  });

  it('node --check не назначается на TypeScript, который он не разбирает', () => {
    strictEqual(syntaxCheckerFor('src/a.ts'), null);
    strictEqual(syntaxCheckerFor('src/a.mjs')?.id, 'node');
  });
});

describe('права субагента', () => {
  it('отсутствие строки tools означает наследование, а не ноль инструментов', () => {
    // `tools: []` здесь давало субагента без единого инструмента, который тем не менее
    // завершался «успешно» и зажигал гейт «Ревью независимым агентом».
    strictEqual(parseAgentFile('---\nname: r\n---\nтело').tools, null);
    deepStrictEqual(parseAgentFile('---\nname: r\ntools: Read, Grep\n---\nтело').tools, ['Read', 'Grep']);
    // Пустой список остаётся отличим от отсутствия поля.
    deepStrictEqual(parseAgentFile('---\nname: r\ntools:\n---\nтело').tools, null);
  });
});

describe('свод отчётов ансамбля: ✅ только если так сказали все', () => {
  const GATES = [
    '# Набор гейтов: demo',
    '',
    '## Набор',
    '',
    '| Гейт | Вкл | Где отчитывается | Чем реализован |',
    '|---|---|---|---|',
    '| Сборка | да — минимум | этап 6 | `npm run build` |',
    '',
  ].join('\n');

  const report = (status: string): string =>
    [
      '## §6 Гейты',
      '',
      '| Гейт | Статус |',
      '|---|---|',
      `| Сборка | ${status} |`,
      '',
    ].join('\n');

  it('красный одного рецензента не стирается зелёным другого', () => {
    const gates = parseGates(GATES);
    ok(gates !== null);
    // Порядок обратный «красный первым»: побеждать должен худший статус, а не последний
    // записавший. Именно так дефект и выглядел — второй маршрут перезаписывал файл.
    const { input } = collectVerdictInput({
      gates,
      gateResults: [],
      reports: [report('✅'), report('❌')],
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    strictEqual(input.gates.find((g) => g.name === 'Сборка')?.status, '❌');
  });

  it('правило худшего статуса одно и то же для гейтов и пунктов приёмки', () => {
    strictEqual(worstGateStatus('✅', '⏭'), '⏭');
    strictEqual(worstGateStatus('⏭', '❌'), '❌');
    strictEqual(worstClaimStatus('✅', '⚠'), '⚠');
    strictEqual(worstClaimStatus('⚠', '❌'), '❌');
    strictEqual(worstClaimStatus('✅', '✅'), '✅');
  });
});

describe('журнал итераций читается обратно', () => {
  it('история попыток восстанавливается из файла на диске', () => {
    // Без этого панель попыток после перезапуска сервиса показывала «попытка 3» и пустой
    // список: номер попытки виток восстанавливал, а историю — нет.
    const md = [
      '| Когда | Chunk | Попытка | Исход | Файлов | Строк | Совпадение с прошлым | Причины | Заметка |',
      '|---|---|---|---|---|---|---|---|---|',
      '| 2026-01-01 00:00 | 1 | 1 | ❌ retry | 2 | 7 | 95% | пункт A не закрыт; ❌ Сборка |  |',
      '| 2026-01-01 01:00 | 1 | 2 | ✅ passed | 1 | 3 | — | — |  |',
      '',
    ].join('\n');

    const rows = parseIterations(md);
    strictEqual(rows.length, 2);
    strictEqual(rows[0]?.passed, false);
    strictEqual(rows[0]?.action, 'retry');
    strictEqual(rows[0]?.closeness, 0.95);
    deepStrictEqual(rows[0]?.reasons, ['пункт A не закрыт', '❌ Сборка']);
    strictEqual(rows[1]?.passed, true);
    strictEqual(rows[1]?.closeness, null);
    deepStrictEqual(rows[1]?.reasons, []);
  });

  it('пустой и битый журнал не роняют чтение', () => {
    deepStrictEqual(parseIterations(''), []);
    deepStrictEqual(parseIterations('просто текст без таблицы'), []);
  });
});
