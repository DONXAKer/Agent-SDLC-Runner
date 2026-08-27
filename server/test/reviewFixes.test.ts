/**
 * Регрессии на находки ревью.
 *
 * По одному тесту на исправленный дефект. Файл отдельный намеренно: это не проверка
 * задуманного поведения, а список граблей, на которые рантайм уже наступал, — и
 * единственная гарантия, что он не наступит на них снова.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Decision, NormalizedCall, PolicyContext, PreparedPrompt } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { DECISION, countPlaceholders, readDecision } from '../src/artifacts/artifact.ts';
import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import { normalize } from '../src/exec/normalize.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { executeTool, type ToolContext } from '../src/exec/tools/index.ts';
import { configProblems, parseCommand, parseGates, unimplementedGates } from '../src/gates/gatesFile.ts';
import { evaluate } from '../src/policy/index.ts';
import type { ChatProvider, ChatTurn } from '../src/provider/ChatProvider.ts';
import { toolCallFromText } from '../src/provider/OpenAiCompatProvider.ts';
import { readReport } from '../src/verdict/collect.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-fixes-')));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  projectRoot: root,
  stage: 'chunk',
  sdlcDir: '.sdlc/demo',
  planFiles: ['src/Foo.java'],
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  ...over,
});

const toolCtx: ToolContext = {
  projectRoot: root,
  maxResultBytes: 200,
  readRangeRequiredAboveBytes: 1_000_000,
  timeoutMs: 20_000,
  signal: new AbortController().signal,
};

// ---------------------------------------------------------------------------

describe('пол безопасности', () => {
  it('Edit подставляет текст замены дословно, без раскрытия $-групп', async () => {
    writeFileSync(join(root, 'price.ts'), 'const price = cost;\n');
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'price.ts',
        edits: [{ oldStr: 'cost', newStr: "'$1.99'", replaceAll: false }],
      },
      toolCtx,
    );
    ok(r.ok, r.text);
    strictEqual(readFileSync(join(root, 'price.ts'), 'utf8'), "const price = '$1.99';\n");
  });

  it('ошибка файловой системы возвращается модели, а не рушит этап', async () => {
    const r = await executeTool({ kind: 'read', path: '.', range: null }, toolCtx);
    strictEqual(r.ok, false);
    ok(/не удалась|файла нет/i.test(r.text), r.text);
  });

  it('шаблон поиска за пределы проекта отклоняется политикой', () => {
    for (const pattern of ['C:/Users/Root/.claude/*.json', '../../*', '/etc/*']) {
      const v = evaluate({ kind: 'glob', pattern, path: null }, ctx());
      ok(!v.ok, `шаблон «${pattern}» обязан быть отклонён`);
    }
    ok(evaluate({ kind: 'glob', pattern: 'src/**/*.ts', path: null }, ctx()).ok);
  });

  it('правка аргументов оператором проходит политику заново', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    const pending = gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'edit-1',
      toolName: 'Write',
      rawInput: { file_path: 'src/Foo.java', content: 'x' },
      call: { kind: 'write', path: 'src/Foo.java', content: 'x' },
      ctx: ctx(),
    });

    // Оператор одобряет, но подменяет путь на файл вне плана.
    const accepted = gate.resolve('r1', 'edit-1', {
      allowed: true,
      updatedInput: { file_path: 'src/Other.java', content: 'x' },
      by: 'operator',
    });
    strictEqual(accepted, true);

    const decision = await pending;
    strictEqual(decision.allowed, false, 'правленый вызов обязан проверяться политикой');
    ok(!decision.allowed && /planScope/.test(decision.reason), 'причина отказа должна быть названа');
  });

  it('запись в набор гейтов на этапе 7 не отклоняется как «вне плана»', () => {
    const handoff = ctx({
      stage: 'handoff',
      protectedArtifacts: ['.sdlc/demo/plan.md', '.sdlc/demo/intent.md'],
    });
    ok(evaluate({ kind: 'write', path: '.sdlc/gates.md', content: 'долг' }, handoff).ok);
  });

  it('защищённый артефакт по-прежнему закрыт', () => {
    const guarded = ctx({ protectedArtifacts: ['.sdlc/gates.md'] });
    ok(!evaluate({ kind: 'write', path: '.sdlc/gates.md', content: 'x' }, guarded).ok);
  });
});

// ---------------------------------------------------------------------------

describe('нормализация', () => {
  // «До конца файла» записано `null`, а не `Number.MAX_SAFE_INTEGER`: большое число
  // утекало в карточку одобрения («строки 200–9007199254740991») и делало чтение целиком
  // неотличимым от настоящего диапазона — предохранитель на большом файле обходился
  // одним `offset`.
  it('offset без limit читает до конца файла, а не одну строку', () => {
    const call = normalize('Read', { file_path: 'a.ts', offset: 200 });
    ok(call.kind === 'read' && call.range !== null);
    strictEqual(call.kind === 'read' ? call.range?.from : 0, 200);
    strictEqual(call.kind === 'read' ? call.range?.to : 0, null, 'верхней границы нет');
  });

  it('пачка правок с битым элементом отвергается целиком', () => {
    const call = normalize('MultiEdit', {
      file_path: 'a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', newstring: 'd' },
      ],
    });
    strictEqual(call.kind, 'unknown', 'частично применённый набор правок недопустим');
  });
});

// ---------------------------------------------------------------------------

describe('инструменты цикла', () => {
  it('результат режется по байтам, а не по символам', async () => {
    writeFileSync(join(root, 'ru.txt'), 'я'.repeat(500));
    const r = await executeTool({ kind: 'read', path: 'ru.txt', range: null }, toolCtx);
    ok(Buffer.byteLength(r.text, 'utf8') <= toolCtx.maxResultBytes + 200, 'потолок считается в байтах');
  });

  // Прервать бэктрекинг внутри одного `test` нечем: замерено 146 секунд на строке в 80
  // символов, и всё это время стоит весь процесс. Поэтому такой шаблон не запускается.
  // Отказ стоит в ПОЛИТИКЕ, а не в реализации инструмента: второй флоу исполняет
  // Grep своим кодом, и правило, спрятанное в `exec/tools`, его не защищает.
  it('шаблон с вложенным повторением отвергается политикой', () => {
    const started = Date.now();
    const v = evaluate({ kind: 'grep', pattern: '(a+)+$', path: 'bait.txt' }, ctx());
    strictEqual(v.ok, false);
    ok(!v.ok && v.policy === 'denyList', JSON.stringify(v));
    ok(!v.ok && /вложенное повторение/.test(v.reason), JSON.stringify(v));
    ok(Date.now() - started < 5_000, 'отказ обязан быть мгновенным');
  });

  it('обычные шаблоны поиска работают', async () => {
    writeFileSync(join(root, 'find-me.txt'), 'первая строка\nвторая строка\n');
    const r = await executeTool({ kind: 'grep', pattern: 'вторая', path: 'find-me.txt' }, toolCtx);
    ok(r.ok, r.text);
    ok(r.text.includes('find-me.txt:2:'), r.text);
  });
});

// ---------------------------------------------------------------------------

describe('провайдер', () => {
  it('вызов после прозы с фигурной скобкой распознаётся', () => {
    const text =
      'Формат такой: { "tool": "имя" }. Теперь вызываю: {"tool":"Read","arguments":{"file_path":"a.ts"}}';
    const call = toolCallFromText(text, new Set(['Read']));
    strictEqual(call?.name, 'Read');
    deepStrictEqual(call?.arguments, { file_path: 'a.ts' });
  });

  it('длинный ответ без вызова разбирается быстро', () => {
    const noise = Array.from({ length: 400 }, (_, i) => `{ "k${i}": ${i} }`).join(' ');
    const started = Date.now();
    strictEqual(toolCallFromText(noise, new Set(['Read'])), null);
    ok(Date.now() - started < 2_000, 'разбор не должен быть квадратичным');
  });
});

// ---------------------------------------------------------------------------

const PROMPT: PreparedPrompt = {
  presetNote: null,
  system: 'системный блок',
  user: 'задача',
  tools: [],
  editedByOperator: false,
};

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: PROMPT,
    cwd: root,
    model: 'test',
    allowedTools: ['Read'],
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 10,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  };
}

function hooks(): ExecHooks & { warns: string[] } {
  const warns: string[] = [];
  return Object.assign(
    {
      onText: () => {},
      onThinking: () => {},
      onToolRequest: () =>
        Promise.resolve<Decision>({ allowed: true, updatedInput: null, by: 'auto' }),
      onToolResult: () => {},
      onAskHuman: () => Promise.resolve({}),
      onUsage: () => {},
      onWarn: (m: string) => warns.push(m),
    } satisfies ExecHooks,
    { warns },
  );
}

function fixedProvider(turn: Partial<ChatTurn>): ChatProvider {
  return {
    name: 'fake',
    chat: () =>
      Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'end_turn',
        usage: emptyUsage(),
        ...turn,
      }),
  };
}

const executor = (p: ChatProvider): LoopExecutor =>
  new LoopExecutor({
    provider: p,
    maxResultBytes: 5_000,
    readRangeRequiredAboveBytes: 1_000_000,
    bashTimeoutMs: 10_000,
    temperature: null,
  });

const readCall = (path: string): ChatTurn['toolCalls'][number] => ({
  id: 'c1',
  name: 'Read',
  arguments: { file_path: path },
  rawArguments: JSON.stringify({ file_path: path }),
});

describe('цикл tool-use', () => {
  it('ход без вызовов с неизвестной причиной завершения успехом не считается', async () => {
    const r = await executor(fixedProvider({ finishReason: 'other' })).run(request(), hooks());
    strictEqual(r.ok, false, 'этап, где модель ничего не сделала, не «выполнен»');
  });

  it('обрезанный лимитом ход с вызовом не исполняется', async () => {
    const h = hooks();
    const r = await executor(
      fixedProvider({ toolCalls: [readCall('a.ts')], finishReason: 'max_tokens' }),
    ).run(request(), h);
    strictEqual(r.ok, false);
    ok(/обрезан/.test(r.note), r.note);
  });

  it('обрыв по зацикливанию наступает на третьем вызове, как обещано', async () => {
    let calls = 0;
    const p: ChatProvider = {
      name: 'fake',
      chat: () => {
        calls++;
        return Promise.resolve({
          text: '',
          toolCalls: [readCall('a.ts')],
          finishReason: 'tool_use' as const,
          usage: emptyUsage(),
        });
      },
    };
    const r = await executor(p).run(request(), hooks());
    strictEqual(r.ok, false);
    ok(/3 раза/.test(r.note), r.note);
    strictEqual(calls, 3, 'лишнего обращения к серверу быть не должно');
  });

  it('исчерпанный бюджет прогона останавливает цикл', async () => {
    const p: ChatProvider = {
      name: 'fake',
      chat: () =>
        Promise.resolve({
          text: '',
          toolCalls: [readCall('a.ts')],
          finishReason: 'tool_use' as const,
          usage: { ...emptyUsage(), costUsd: 5 },
        }),
    };
    const h = hooks();
    const r = await executor(p).run(request({ maxBudgetUsd: 1 }), h);
    strictEqual(r.ok, false);
    ok(/бюджет/.test(r.note), r.note);
  });
});

// ---------------------------------------------------------------------------

describe('набор гейтов', () => {
  it('проза с процитированным именем командой не считается', () => {
    strictEqual(parseCommand('скрипт сверки diff с `files_to_touch`; пути `.sdlc/**` исключены'), null);
    strictEqual(parseCommand('чек-лист скилла; результат — `readiness.md`'), null);
    strictEqual(parseCommand('`./gradlew build -x test`'), './gradlew build -x test');
    strictEqual(parseCommand('`npm test`'), 'npm test');
  });

  it('«да.» и «да, минимум» включают гейт', () => {
    const g = parseGates(
      [
        '## Набор',
        '',
        '| Гейт | Вкл | Где отчитывается | Чем реализован |',
        '|---|---|---|---|',
        '| Сборка | да. | этап 6 | `npm run build` |',
        '| Тесты | да, минимум | этап 6 | `npm test` |',
      ].join('\n'),
    );
    deepStrictEqual(
      g.rows.map((r) => r.enabled),
      [true, true],
    );
  });

  it('нераспознанная колонка «Где отчитывается» больше не молчит', () => {
    const g = parseGates(
      [
        '## Набор',
        '',
        '| Гейт | Вкл | Где отчитывается | Чем реализован |',
        '|---|---|---|---|',
        '| Сборка | да — минимум | этап 6 | `npm run build` |',
        '| Тесты | да — минимум | на этапе 6 | `npm test` |',
        '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт |',
        '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
        '| Ревью независимым агентом | да — минимум | этап 6 | агент |',
      ].join('\n'),
    );
    ok(
      configProblems(g).some((p) => /Тесты/.test(p) && /Где отчитывается/.test(p)),
      configProblems(g).join('; '),
    );
  });

  it('две строки с одним именем названы, а не схлопнуты молча', () => {
    const g = parseGates(
      [
        '## Набор',
        '',
        '| Гейт | Вкл | Где отчитывается | Чем реализован |',
        '|---|---|---|---|',
        '| Тесты | да | этап 6 | `npm test` |',
        '| тесты | да | этап 6 | `npm run test:e2e` |',
      ].join('\n'),
    );
    ok(configProblems(g).some((p) => /одним именем/.test(p)), configProblems(g).join('; '));
  });

  it('гейт этапа 6 без команды и без встроенной реализации назван до прогона, не после', () => {
    const g = parseGates(
      [
        '## Набор',
        '',
        '| Гейт | Вкл | Где отчитывается | Чем реализован |',
        '|---|---|---|---|',
        '| Сборка | да — минимум | этап 6 | `npm run build` |',
        '| Тесты | да — минимум | этап 6 | `npm test` |',
        '| Scope: файлы вне плана | да — минимум | этап 6 | скрипт |',
        '| Анти-обход тест-гейта | да — минимум | этап 6 | скрипт |',
        '| Ревью независимым агентом | да — минимум | этап 6 | агент |',
        '| Свой гейт | да | этап 6 | проза без обратных кавычек |',
      ].join('\n'),
    );
    const isBuiltin = (name: string): boolean => /^(сборка|тесты)$/.test(name.toLowerCase());
    const problems = unimplementedGates(g, isBuiltin);
    ok(problems.some((p) => /Свой гейт/.test(p)), problems.join('; '));
    // «Сборка»/«Тесты» дали команду в кавычках — не попадают в список независимо от isBuiltin.
    ok(!problems.some((p) => /«Сборка»/.test(p) || /«Тесты»/.test(p)), problems.join('; '));
  });

  it('гейт с командой в кавычках не считается неисполнимым, даже если isBuiltin(name) вернул false', () => {
    const g = parseGates(
      [
        '## Набор',
        '',
        '| Гейт | Вкл | Где отчитывается | Чем реализован |',
        '|---|---|---|---|',
        '| Сборка | да — минимум | этап 6 | `npm run build` |',
      ].join('\n'),
    );
    strictEqual(unimplementedGates(g, () => false).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('вердикт и отчёт', () => {
  it('нераспознанный отчёт даёт красный вердикт, а не зелёный', () => {
    const v = computeVerdict({
      gates: [],
      claims: [],
      confirmedReviewFindings: 0,
      enabledGatesMissingFromReport: [],
      openDebtRows: [],
      brokenInvariants: [],
      regressions: [],
      plannedPathsUntouched: [],
      diffMatchesTree: true,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    });
    strictEqual(v.passed, false);
    ok(v.reasons.some((r) => /не прочитан/.test(r)), v.reasons.join('; '));
  });

  it('находка, начинающаяся со слова «нет», не считается пустотой', () => {
    const f = readReport('## 5. Регрессии\n\n- нет отката миграции при падении деплоя\n');
    deepStrictEqual(f.regressions, ['нет отката миграции при падении деплоя']);
  });

  it('настоящая заглушка по-прежнему считается пустотой', () => {
    strictEqual(readReport('## 5. Регрессии\n\n- нет\n').regressions.length, 0);
    strictEqual(readReport('## 5. Регрессии\n\n- н/п\n').regressions.length, 0);
  });

  it('находки ревью вложенным списком считаются', () => {
    const f = readReport(
      [
        '## 2. Ревью: что искали опровергнуть',
        '',
        '- Подтверждённое расхождение:',
        '  - Foo.java:42 условие инвертировано',
        '  - Bar.ts:10 потерян await',
      ].join('\n'),
    );
    strictEqual(f.confirmedReviewFindings, 1, 'блок находок обязан быть непустым');
  });
});

// ---------------------------------------------------------------------------

describe('артефакты', () => {
  it('ветка формы «одобрение через ExitPlanMode» читается как решение', () => {
    const t = '- **Подтвердил:** использовано одобрение плана через ExitPlanMode этой сессии';
    strictEqual(readDecision(t, DECISION.confirmed).state, 'granted');
  });

  // Плейсхолдер — ТОЛЬКО типографские скобки. ASCII-вариант пробовался и оказался хуже
  // болезни: отчёт рецензента полон дженериков и сравнений, и каждый такой фрагмент
  // становился «незаполненным местом» — готовый артефакт навсегда числился неготовым.
  it('плейсхолдер — только типографские скобки, обычный текст в <> — нет', () => {
    strictEqual(countPlaceholders('‹что вписать›'), 1);
    strictEqual(countPlaceholders('‹файл› и ‹зачем›'), 2);
    strictEqual(countPlaceholders('Map<string, Gate> и если a < b, то <br>'), 0);
    strictEqual(countPlaceholders('обычный текст без форм'), 0);
  });
});
