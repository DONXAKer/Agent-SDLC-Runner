/**
 * Регрессии на находки ВТОРОГО ревью — того, что проверяло правки первого.
 *
 * Отдельный файл, потому что это отдельный урок: половина дефектов здесь внесена
 * исправлениями, а не исходным кодом. Правка, сделанная «на всякий случай строже»,
 * закрыла зелёный вердикт наглухо; правка, сделанная «на всякий случай шире», открыла
 * ложный зелёный с другой стороны. Каждый тест ниже фиксирует ту границу, за которую
 * ни в ту, ни в другую сторону выходить нельзя.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { GateRunResult, PolicyContext } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import {
  DECISION,
  isSignedByHuman,
  nameOnlyProblem,
  readDecision,
} from '../src/artifacts/artifact.ts';
import { executeTool, type ToolContext } from '../src/exec/tools/index.ts';
import { configProblems, openDebt, parseCommand, parseGates } from '../src/gates/gatesFile.ts';
import { evaluate, writeTargetPaths, writeTargetsOf } from '../src/policy/index.ts';
import { collectVerdictInput, readReport } from '../src/verdict/collect.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-fixes2-')));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  projectRoot: root,
  stage: 'chunk',
  sdlcDir: '.sdlc/demo',
  planFiles: ['src/Foo.java'],
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  mcpTools: [],
  ...over,
});

// ---------------------------------------------------------------------------
// Подпись человека
// ---------------------------------------------------------------------------

describe('подпись человека', () => {
  // Инициалы — обычная форма подписи, а планка «слово от двух букв» их отвергала:
  // одобренный план ронялся на предусловии следующего этапа.
  it('инициалы считаются именем', () => {
    ok(isSignedByHuman('А. Г. · 2026-08-16'));
    ok(isSignedByHuman('A.G. 16.08.2026'));
    ok(!isSignedByHuman('· 2026-08-16'), 'одна дата подписью не является');
  });

  // Планка неприменимости — имя, и только имя: так велит форма методологии. Но пустота
  // и незаполненная форма именем не считаются.
  it('планка «только имя» отличает имя от пустоты и формы', () => {
    strictEqual(nameOnlyProblem('Иван'), null);
    ok(nameOnlyProblem('‹имя›') !== null);
    ok(nameOnlyProblem('   ') !== null);
  });

  // «Одобрение через ExitPlanMode» проверялось ДО отрицания и отложенности, и строка
  // «ожидается одобрение плана через ExitPlanMode» читалась как состоявшееся решение.
  it('ожидание одобрения через ExitPlanMode решением не считается', () => {
    const pending = '- **Подтвердил:** ожидается одобрение плана через ExitPlanMode';
    strictEqual(readDecision(pending, DECISION.confirmed).state, 'placeholder');

    const declined = '- **Подтвердил:** не использовано одобрение плана через ExitPlanMode';
    strictEqual(readDecision(declined, DECISION.confirmed).state, 'declined');

    const granted = '- **Подтвердил:** использовано одобрение плана через ExitPlanMode этой сессии';
    strictEqual(readDecision(granted, DECISION.confirmed).state, 'granted');
  });
});

// ---------------------------------------------------------------------------
// Разбор отчёта приёмки
// ---------------------------------------------------------------------------

describe('разбор отчёта приёмки', () => {
  const report = (section: string): string =>
    ['## 2. Ревью', '', section, '', '## 3. План'].join('\n');

  // Голое равенство было слишком узко: человек пишет «н/п — не применимо», а не «н/п».
  it('маркер пустоты с пояснением остаётся пустотой', () => {
    const f = readReport(report('- Подтверждённое расхождение: н/п — не применимо'));
    strictEqual(f.confirmedReviewFindings, 0);
  });

  // Но префиксное сравнение было слишком широко: содержательная находка, начинающаяся
  // с тех же слов, выбрасывалась вместе с заглушками, и красный вердикт зеленел.
  it('находка, начинающаяся со слова-маркера, остаётся находкой', () => {
    const f = readReport(report('- Подтверждённое расхождение: нет отката миграции при падении деплоя'));
    strictEqual(f.confirmedReviewFindings, 1);
  });

  // Склейка вложенного списка превращала «нет» + пояснение в непустое значение и роняла
  // вердикт по несуществующему расхождению.
  it('пояснение под словом «нет» находкой не становится', () => {
    const f = readReport(
      report(['- Подтверждённое расхождение: нет', '  - (проверены все пункты приёмки)'].join('\n')),
    );
    strictEqual(f.confirmedReviewFindings, 0);
  });

  // Но если в самой строке значения нет, вложенный список И ЕСТЬ перечень находок.
  it('перечень под пустой строкой читается как находки', () => {
    const f = readReport(
      report(['- Подтверждённое расхождение:', '  - счётчик считает с нуля'].join('\n')),
    );
    strictEqual(f.confirmedReviewFindings, 1);
  });
});

// ---------------------------------------------------------------------------
// Набор гейтов
// ---------------------------------------------------------------------------

describe('набор гейтов', () => {
  // Эвристика «команда — это глагол с аргументами либо путь» отвергала `make`, `pytest`,
  // `tox`, `npm` — самые обычные записи набора: гейт уходил во встроенную реализацию мимо
  // того, чем проект реально собирается.
  it('ячейка целиком из одной обратной кавычки — это команда', () => {
    strictEqual(parseCommand('`make`'), 'make');
    strictEqual(parseCommand('  `pytest`  '), 'pytest');
    strictEqual(parseCommand('`npm test`'), 'npm test');
  });

  // И при этом проза с процитированным именем командой по-прежнему не считается: пока
  // считалась, рантайм запускал `files_to_touch` и красил scope-гейт в ❌ каждый виток.
  it('проза с процитированным именем командой не считается', () => {
    strictEqual(parseCommand('скрипт сверки diff с `files_to_touch`'), null);
    strictEqual(parseCommand('‹чем; пути `.sdlc/**` исключены›'), null);
  });

  const gatesText = (rows: string[]): string =>
    [
      '## Набор',
      '',
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Сборка | да — минимум | этап 6 | `make` |',
      '| Тесты | да — минимум | этап 6 | `pytest` |',
      '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт сверки |',
      '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
      '| Ревью независимым агентом | да — минимум | этап 6 | субагент |',
      ...rows,
    ].join('\n');

  // Распознанный, но никем не собираемый этап — молчаливое отключение: отчёт приёмки
  // собирает этапы 1/2/4/5/6, handoff — этап 7, а «этап 3» не спросит никто.
  it('гейт, отчитывающийся на неспрашиваемом этапе, назван проблемой набора', () => {
    const g = parseGates(gatesText(['| Секреты в diff | да | этап 3 | скрипт |']));
    const problems = configProblems(g);
    strictEqual(problems.length, 1, problems.join(' | '));
    ok(/этап 3/.test(problems[0] ?? ''), problems[0]);
  });

  it('этап 7 и «вне витка» проблемой не считаются', () => {
    const g = parseGates(
      gatesText([
        '| Проверка предусловий публикации | да | этап 7 | скрипт |',
        '| Калибровка посевом | да | вне витка | посев |',
      ]),
    );
    strictEqual(configProblems(g).length, 0, configProblems(g).join(' | '));
  });

  // Сверка долга шла голым `toLowerCase()`: строка с «ё» или обратными кавычками не
  // находилась к своему гейту, и закрытый долг числился открытым.
  it('строка долга находится к гейту по тому же ключу, что и всё остальное', () => {
    const g = parseGates(
      [
        gatesText(['| `Секреты в diff` | нет | этап 6 | н/п — долг |']),
        '',
        '## Долг',
        '',
        '| Гейт | Где | Как закрывается | Дата | Кто |',
        '|---|---|---|---|---|',
        '| Секреты в  diff | ревью | проверяет руками | 2026-08-16 | Иван |',
      ].join('\n'),
    );
    strictEqual(openDebt(g).length, 0, openDebt(g).join(' | '));
  });
});

// ---------------------------------------------------------------------------
// Вердикт: чей статус побеждает
// ---------------------------------------------------------------------------

describe('вердикт при расхождении отчёта и прогона', () => {
  const gates = parseGates(
    [
      '## Набор',
      '',
      '| Гейт | Вкл | Где отчитывается | Чем реализован |',
      '|---|---|---|---|',
      '| Сборка | да — минимум | этап 6 | `make` |',
      '| Тесты | да — минимум | этап 6 | `pytest` |',
      '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт |',
      '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
      '| Ревью независимым агентом | да — минимум | этап 6 | субагент |',
    ].join('\n'),
  );

  const run = (status: GateRunResult['status']): GateRunResult => ({
    name: 'Ревью независимым агентом',
    status,
    command: null,
    exitCode: null,
    lastLine: '',
    durationMs: 0, envBlocked: false
  });

  const reportWith = (status: string): string =>
    [
      '## Гейты',
      '',
      '| Гейт | Статус | Результат |',
      '|---|---|---|',
      `| Ревью независимым агентом | ${status} | — |`,
    ].join('\n');

  const statusOf = (reported: string, actual: GateRunResult['status']): string | undefined =>
    collectVerdictInput({
      gates,
      gateResults: [run(actual)],
      runtimeAuthoritativeWhenGreen: ['ревью независимым агентом'],
      reports: [reportWith(reported)],
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    }).input.gates.find((g) => g.name === 'Ревью независимым агентом')?.status;

  // «Не запускался» опровергается фактом запуска, а не наоборот: рантайм видел вызов
  // субагента своими глазами. Пока действовало правило «худший из двух», гейт минимума
  // не мог стать зелёным ни на одной попытке, и зелёный вердикт был недостижим вообще.
  it('состоявшийся прогон рецензента перебивает ⏭ отчёта', () => {
    strictEqual(statusOf('⏭', '✅'), '✅');
  });

  // Но красный отчёта побеждает по-прежнему: рецензент, нашедший дефект, — не тот
  // источник, который стоит переспоривать.
  it('❌ отчёта не перекрашивается зелёным прогоном', () => {
    strictEqual(statusOf('❌', '✅'), '❌');
  });

  // r23: рантайм СВОИМИ РУКАМИ прогнал scope-гейт и получил код 0, а рецензент вписал
  // ❌, списав находку из отчёта предыдущей попытки. Виток, у которого сошлось всё,
  // оставался красным по выдумке — при том что защита от ложного ЗЕЛЁНОГО тут ни при чём.
  it('исполненный рантаймом зелёный гейт не краснеет от выдумки отчёта (r23)', () => {
    const res = collectVerdictInput({
      gates,
      gateResults: [
        { name: 'Scope: файлы вне плана', status: '✅', command: null, exitCode: 0, lastLine: 'все изменения в пределах files_to_touch', durationMs: 5, envBlocked: false },
      ],
      runtimeAuthoritativeWhenGreen: ['ревью независимым агентом'],
      reports: [['## Гейты', '', '| Гейт | Статус |', '|---|---|', '| Scope: файлы вне плана | ❌ |'].join('\n')],
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    strictEqual(res.input.gates.find((g) => g.name === 'Scope: файлы вне плана')?.status, '✅');
    strictEqual(res.disagreements.length, 0, 'красной причиной это быть не должно');
    strictEqual(res.reportQuality.length, 1, 'но качество отчёта обязано быть названо');
  });

  // r31: три сэмпла подряд с кодом 9/9 покраснели на «артефакт этапа 5 устарел» — только
  // потому, что слабый рецензент не написал «Сверка с деревом: да». Условие роняет
  // вердикт, а держалось на прозе; теперь патч сверяет сам рантайм.
  it('факт сверки патча с деревом побеждает прозу отчёта в обе стороны (r31)', () => {
    const report = (sync: string): string =>
      ['- **Сверка с деревом:** ' + sync, '', '## Гейты', '', '| Гейт | Статус |', '|---|---|', '| Сборка | ✅ |'].join('\n');
    const call = (sync: string, fact: boolean | null): boolean =>
      collectVerdictInput({
        gates,
        gateResults: [],
        reports: [report(sync)],
        diffMatchesTreeFact: fact,
        attempt: 1,
        attemptBudget: 3,
        noProgress: false,
      }).input.diffMatchesTree;

    strictEqual(call('нет', true), true, 'рантайм сверил — патч совпадает, проза не спорит');
    strictEqual(call('да', false), false, 'рантайм сверил — патч устарел, заявление отчёта не спасает');
    strictEqual(call('да', null), true, 'сверки не было — действует прежнее правило');
  });

  // r35: рецензент заполнил разделы 4 и 5 доказательствами ОТСУТСТВИЯ находок —
  // «нарушен: нет», «нарушен: нет (реализация верна)», «Сборка проходит: … — ✅».
  // Каждая такая строка числилась находкой и роняла вердикт.
  it('доказательство отсутствия находки находкой не считается (r35)', () => {
    const report = [
      '## 4. Инварианты',
      '- Инвариант А — нарушен: нет',
      '- Инвариант Б — нарушен: нет (реализация верна)',
      '- Инвариант В — нарушен: политика обойдена через sh -c',
      '',
      '## 5. Регрессии',
      '- Сборка проходит: `node scripts/build-check.mjs` — ✅',
      '- Нет регрессий',
      '- `tariffs.ts:172`: вычитание вместо сложения — тест упал',
      '',
      '## Гейты',
      '',
      '| Гейт | Статус |',
      '|---|---|',
      '| Сборка | ✅ |',
    ].join('\n');
    const res = collectVerdictInput({
      gates,
      gateResults: [],
      reports: [report],
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    deepStrictEqual(res.input.brokenInvariants, ['политика обойдена через sh -c']);
    strictEqual(res.input.regressions.length, 1, JSON.stringify(res.input.regressions));
    ok(res.input.regressions[0]!.includes('вычитание вместо сложения'));
  });

  it('на прочих гейтах правило прежнее — худший из двух', () => {
    const st = collectVerdictInput({
      gates,
      gateResults: [
        { name: 'Сборка', status: '❌', command: null, exitCode: 1, lastLine: '', durationMs: 0, envBlocked: false },
      ],
      runtimeAuthoritativeWhenGreen: ['ревью независимым агентом'],
      reports: [['## Гейты', '', '| Гейт | Статус |', '|---|---|', '| Сборка | ✅ |'].join('\n')],
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    }).input.gates.find((g) => g.name === 'Сборка')?.status;
    strictEqual(st, '❌');
  });
});

// ---------------------------------------------------------------------------
// Политика и гейт одобрений
// ---------------------------------------------------------------------------

describe('политика поиска', () => {
  // Шаблон `Grep` — это регулярное выражение по СОДЕРЖИМОМУ, и мерить его предикатом
  // пути нельзя: после замены `\` на `/` обычное `\d+` выглядело как абсолютный путь, и
  // рядовой поиск получал отказ политики, снять который оператор не может.
  it('обычные регулярные выражения в Grep не отвергаются как пути', () => {
    ok(evaluate({ kind: 'grep', pattern: '\\d+', path: null }, ctx()).ok);
    ok(evaluate({ kind: 'grep', pattern: '\\bimport\\b', path: null }, ctx()).ok);
    ok(evaluate({ kind: 'grep', pattern: 'C:\\\\Users', path: null }, ctx()).ok);
  });

  // А у `Glob` шаблон — это путь, и выход за проект в нём по-прежнему отклоняется.
  it('шаблон Glob за пределы проекта по-прежнему отклоняется', () => {
    const v = evaluate({ kind: 'glob', pattern: '../../.ssh/*', path: null }, ctx());
    strictEqual(v.ok, false);
    ok(!v.ok && v.policy === 'pathScope', JSON.stringify(v));
  });

  // Каталог поиска у Grep ограничивает поле `path` — оно и проверяется.
  it('каталог поиска у Grep проверяется', () => {
    strictEqual(evaluate({ kind: 'grep', pattern: 'foo', path: '../../..' }, ctx()).ok, false);
  });
});

describe('гейт одобрений', () => {
  // Правка оператора трактовалась как ПОЛНЫЙ вход: поправив путь у `Write`, оператор
  // отправлял исполнителю вызов без `content` — одобренная правка стирала файл.
  it('правка накладывается на исходные аргументы, а не заменяет их', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    const pending = gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'e1',
      toolName: 'Write',
      rawInput: { file_path: 'src/Foo.java', content: 'важное содержимое' },
      call: { kind: 'write', path: 'src/Foo.java', content: 'важное содержимое' },
      ctx: ctx(),
    });

    // Оператор поправил только путь.
    strictEqual(
      gate.resolve('r1', 'e1', {
        allowed: true,
        updatedInput: { file_path: 'src/Foo.java' },
        by: 'operator',
      }),
      true,
    );

    const d = await pending;
    ok(d.allowed);
    const merged = (d.allowed ? d.updatedInput : null) as Record<string, unknown>;
    strictEqual(merged['content'], 'важное содержимое', 'содержимое не должно потеряться');
  });

  // Цели записи для ПРОВЕРКИ и для показа человеку — разные строки: во второй приклеено
  // «(переменная не развёрнута)», и путь с этим хвостом на диске не находится.
  it('пути для проверки отделены от подписей для оператора', () => {
    const call = { kind: 'bash' as const, command: 'echo x > $OUT/report.txt' };
    const shown = writeTargetsOf(call, ctx()) ?? [];
    const checked = writeTargetPaths(call, ctx()) ?? [];
    strictEqual(checked.length, shown.length);
    ok(
      shown.some((s) => /переменная не развёрнута/.test(s)),
      shown.join(' | '),
    );
    ok(
      checked.every((p) => !/переменная не развёрнута/.test(p)),
      checked.join(' | '),
    );
  });
});

// ---------------------------------------------------------------------------
// Инструменты
// ---------------------------------------------------------------------------

describe('инструменты: неполнота названа вслух', () => {
  const toolCtx: ToolContext = {
    projectRoot: root,
    maxResultBytes: 100_000,
    readRangeRequiredAboveBytes: 1_000_000,
    timeoutMs: 5_000,
    signal: AbortSignal.abort(),
  };

  // Обрыв обхода назывался только при пустом результате. Пока он молчал на непустом,
  // «поиск не уложился» выглядел для модели исчерпывающим ответом, и она делала вывод
  // «больше вхождений нет» по недосмотренному дереву.
  it('прерванный поиск сообщает о неполноте, а не отвечает «совпадений нет»', async () => {
    writeFileSync(join(root, 'haystack.txt'), 'иголка\n');
    const r = await executeTool({ kind: 'grep', pattern: 'иголка', path: null }, toolCtx);
    ok(/НЕ полностью|прерван/.test(r.text), r.text);
  });
});
