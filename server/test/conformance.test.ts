/**
 * Conformance: два флоу — одна форма вызова и одно решение политики.
 *
 * Единственный реальный риск двух исполнителей в том, что одобрения и confinement начнут
 * вести себя по-разному. Здесь одна таблица вызовов прогоняется в обеих формах —
 * инструменты Claude Code (флоу `sdk`, snake_case, MCP-префикс у наших инструментов) и
 * инструменты нашего цикла (флоу `loop`, свои имена и camelCase) — и проверяется, что
 * `NormalizedCall` совпадает, а политика выносит тот же вердикт.
 *
 * Пока флоу `loop` не реализован, сверять две реализации цикла не с чем — но нормализатор
 * у них общий по построению, и именно он тут проверяется. Расхождение имён и форм
 * аргументов ловится сборкой, а не первым локальным витком.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { CallKind, NormalizedCall, PolicyContext, ToolName } from '@sdlc-runner/shared';
import { CALL_KINDS } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { baseToolName, normalize } from '../src/exec/normalize.ts';
import { evaluate } from '../src/policy/index.ts';

const ROOT = 'D:/work/proj';

const CTX: PolicyContext = {
  projectRoot: ROOT,
  stage: 'chunk',
  sdlcDir: '.sdlc/demo',
  planFiles: ['src/Foo.java'],
  protectedArtifacts: ['.sdlc/gates.md', '.sdlc/demo/plan.md'],
  readOnlyRoots: ['D:/methodology'],
  allowedTools: [
    'Read',
    'Glob',
    'Grep',
    'Write',
    'Edit',
    'Bash',
    'Task',
    'AskHuman',
    'FinalizeArtifact',
  ] satisfies ToolName[],
  mcpTools: [],
};

interface Case {
  what: string;
  sdk: [string, Record<string, unknown>];
  loop: [string, Record<string, unknown>];
  expect: NormalizedCall;
}

const CASES: Case[] = [
  {
    what: 'чтение целиком',
    sdk: ['Read', { file_path: 'src/Foo.java' }],
    loop: ['Read', { path: 'src/Foo.java' }],
    expect: { kind: 'read', path: 'src/Foo.java', range: null },
  },
  {
    what: 'чтение диапазоном — границы включающие',
    sdk: ['Read', { file_path: 'src/Foo.java', offset: 10, limit: 5 }],
    loop: ['Read', { filePath: 'src/Foo.java', offset: 10, limit: 5 }],
    expect: { kind: 'read', path: 'src/Foo.java', range: { from: 10, to: 14 } },
  },
  {
    what: 'запись',
    sdk: ['Write', { file_path: 'src/Foo.java', content: 'x' }],
    loop: ['Write', { path: 'src/Foo.java', content: 'x' }],
    expect: { kind: 'write', path: 'src/Foo.java', content: 'x' },
  },
  {
    what: 'правка одной операцией',
    sdk: ['Edit', { file_path: 'src/Foo.java', old_string: 'a', new_string: 'b' }],
    loop: ['Edit', { path: 'src/Foo.java', oldString: 'a', newString: 'b' }],
    expect: {
      kind: 'edit',
      path: 'src/Foo.java',
      edits: [{ oldStr: 'a', newStr: 'b', replaceAll: false }],
    },
  },
  {
    what: 'правка пачкой',
    sdk: [
      'MultiEdit',
      {
        file_path: 'src/Foo.java',
        edits: [{ old_string: 'a', new_string: 'b', replace_all: true }],
      },
    ],
    loop: [
      'Edit',
      { path: 'src/Foo.java', edits: [{ oldString: 'a', newString: 'b', replaceAll: true }] },
    ],
    expect: {
      kind: 'edit',
      path: 'src/Foo.java',
      edits: [{ oldStr: 'a', newStr: 'b', replaceAll: true }],
    },
  },
  {
    what: 'shell',
    sdk: ['Bash', { command: 'ls -la' }],
    loop: ['Bash', { command: 'ls -la' }],
    expect: { kind: 'bash', command: 'ls -la' },
  },
  {
    what: 'поиск по имени',
    sdk: ['Glob', { pattern: '**/*.java' }],
    loop: ['Glob', { pattern: '**/*.java' }],
    expect: { kind: 'glob', pattern: '**/*.java', path: null },
  },
  {
    what: 'субагент',
    sdk: ['Task', { subagent_type: 'sdlc-reviewer', prompt: 'проверь' }],
    loop: ['Agent', { agent: 'sdlc-reviewer', prompt: 'проверь' }],
    expect: { kind: 'subagent', agent: 'sdlc-reviewer', prompt: 'проверь' },
  },
  {
    what: 'вопрос человеку',
    sdk: [
      'mcp__sdlc__ask_human',
      { questions: [{ id: 'q1', question: 'какой формат?', header: 'Формат', options: [] }] },
    ],
    loop: [
      'AskHuman',
      { questions: [{ id: 'q1', question: 'какой формат?', header: 'Формат', options: [] }] },
    ],
    expect: {
      kind: 'ask_human',
      questions: [
        { id: 'q1', question: 'какой формат?', header: 'Формат', multiSelect: false, options: [] },
      ],
    },
  },
  {
    what: 'финализация артефакта',
    sdk: ['mcp__sdlc__finalize_artifact', { artifact: 'plan', note: 'готово' }],
    loop: ['FinalizeArtifact', { artifact: 'plan', note: 'готово' }],
    expect: { kind: 'finalize_artifact', artifact: 'plan', note: 'готово' },
  },
];

describe('нормализация одинакова в обоих флоу', () => {
  for (const c of CASES) {
    it(`${c.what}: одна форма`, () => {
      const fromSdk = normalize(c.sdk[0], c.sdk[1]);
      const fromLoop = normalize(c.loop[0], c.loop[1]);
      deepStrictEqual(fromSdk, c.expect, 'форма sdk разошлась с ожидаемой');
      deepStrictEqual(fromLoop, c.expect, 'форма loop разошлась с ожидаемой');
    });

    it(`${c.what}: одно решение политики`, () => {
      const a = evaluate(normalize(c.sdk[0], c.sdk[1]), CTX);
      const b = evaluate(normalize(c.loop[0], c.loop[1]), CTX);
      deepStrictEqual(a, b);
    });
  }
});

describe('нормализация: худший случай по умолчанию', () => {
  it('незнакомый инструмент становится unknown, а не теряется', () => {
    const call = normalize('NotebookEdit', { notebook_path: 'x.ipynb' });
    strictEqual(call.kind, 'unknown');
    ok(!evaluate(call, CTX).ok, 'unknown обязан отклоняться политикой');
  });

  // Регрессия: объектный литерал вместо Map возвращал функцию для имени `toString`,
  // ни одна ветка не срабатывала, и политика падала с TypeError вместо отказа.
  it('имя из прототипа объекта не ломает нормализацию', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const call = normalize(name, {});
      strictEqual(call.kind, 'unknown', `${name} должен стать unknown`);
      ok(!evaluate(call, CTX).ok);
    }
  });

  it('правка без единой операции правкой не считается', () => {
    strictEqual(normalize('Edit', { file_path: 'src/Foo.java' }).kind, 'unknown');
    strictEqual(normalize('Edit', { file_path: 'src/Foo.java', edits: [] }).kind, 'unknown');
  });

  it('запись без пути не проскакивает как безобидная', () => {
    const call = normalize('Write', { content: 'x' });
    strictEqual(call.kind, 'unknown');
    ok(!evaluate(call, CTX).ok);
  });

  it('MCP-префикс снимается, а имя инструмента остаётся', () => {
    strictEqual(baseToolName('mcp__sdlc__ask_human'), 'ask_human');
    strictEqual(baseToolName('Read'), 'Read');
  });
});

describe('политика решает одинаково независимо от формы вызова', () => {
  it('запись вне плана отклоняется в обеих формах', () => {
    const sdk = evaluate(normalize('Write', { file_path: 'src/Other.java', content: '' }), CTX);
    const loop = evaluate(normalize('Write', { path: 'src/Other.java', content: '' }), CTX);
    ok(!sdk.ok);
    deepStrictEqual(sdk, loop);
  });

  it('shell-запись вне плана отклоняется независимо от формы аргументов', () => {
    // Сравнение X === X, стоявшее здесь раньше, упасть не могло никогда. Формы должны
    // РАЗЛИЧАТЬСЯ: у флоу sdk аргумент называется `command`, у нашего цикла — так же,
    // но описание команды приходит разными полями, и нормализатор обязан дать одно.
    const sdk = evaluate(normalize('Bash', { command: 'echo x > tmp.sh' }), CTX);
    const loop = evaluate(
      normalize('Bash', { command: 'echo x > tmp.sh', description: 'создать временный скрипт' }),
      CTX,
    );
    ok(!sdk.ok);
    deepStrictEqual(sdk, loop);
  });

  // Оба исполнителя обязаны спрашивать гейт по ОДНОМУ и тому же признаку. Проверяем это
  // напрямую: у обоих `NO_HUMAN_STEP` — общий, и «дешёвый» вызов не должен требовать
  // человека ни в одном флоу, а вопрос человеку не должен вставать в очередь одобрений.
  it('дешёвые вызовы и вопрос человеку шаг оператора не требуют', async () => {
    const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
    const cheap: NormalizedCall[] = [
      { kind: 'read', path: 'README.md', range: null },
      { kind: 'glob', pattern: 'src/**/*.ts', path: null },
      { kind: 'grep', pattern: 'foo', path: null },
      { kind: 'ask_human', questions: [] },
    ];
    for (const call of cheap) {
      const d = await gate.request({
        runId: 'r1',
        stage: 'chunk',
        requestId: `c-${call.kind}`,
        toolName: 'X',
        rawInput: {},
        call,
        ctx: CTX,
      });
      ok(d.allowed, `${call.kind} обязан пройти без ожидания оператора`);
    }
    strictEqual(gate.list().length, 0, 'ни один такой вызов не должен висеть в очереди');
  });
});

describe('внешние MCP-серверы: имя разбирается одинаково в обоих флоу', () => {
  // Пары `sdk`/`loop` здесь нет намеренно: у внешнего сервера имя на проводе ОДНО —
  // `mcp__<сервер>__<инструмент>`, и написать пару значило бы сравнить X с X. Проверяется
  // то, что действительно может разъехаться: разбор самого имени.
  const cases: { name: string; expect: NormalizedCall }[] = [
    {
      name: 'mcp__unreal__pie_start',
      expect: { kind: 'mcp', server: 'unreal', tool: 'pie_start', args: {} },
    },
    {
      // Дефис в имени сервера — обычное дело: это ключ из `.mcp.json`.
      name: 'mcp__unreal-mcp__asset_exists',
      expect: { kind: 'mcp', server: 'unreal-mcp', tool: 'asset_exists', args: {} },
    },
    {
      // `__` внутри имени ИНСТРУМЕНТА: режем по первому разделителю, а не по последнему.
      name: 'mcp__srv__do__it',
      expect: { kind: 'mcp', server: 'srv', tool: 'do__it', args: {} },
    },
    {
      // Наш внутренний сервер зарезервирован: иначе неизвестный `mcp__sdlc__*` превратился
      // бы из `unknown` в законный вызов к серверу, которого нет.
      name: 'mcp__sdlc__нет_такого',
      expect: { kind: 'unknown', toolName: 'mcp__sdlc__нет_такого', raw: {} },
    },
    { name: 'mcp__', expect: { kind: 'unknown', toolName: 'mcp__', raw: {} } },
    { name: 'mcp____x', expect: { kind: 'unknown', toolName: 'mcp____x', raw: {} } },
    { name: 'mcp__srv__', expect: { kind: 'unknown', toolName: 'mcp__srv__', raw: {} } },
  ];

  for (const c of cases) {
    it(`${c.name} -> ${c.expect.kind}`, () => {
      deepStrictEqual(normalize(c.name, {}), c.expect);
    });
  }

  it('вызов сервера, которого нет в разрешительном списке, отклоняется как stageTools', () => {
    const v = evaluate(normalize('mcp__unreal__spawn_actor', {}), CTX);
    ok(!v.ok);
    strictEqual(v.policy, 'stageTools');
  });

  it('наш внутренний MCP-инструмент по-прежнему узнаётся, а не считается внешним', () => {
    strictEqual(baseToolName('mcp__sdlc__ask_human'), 'ask_human');
    strictEqual(normalize('mcp__sdlc__ask_human', { questions: [] }).kind, 'ask_human');
  });
});

describe('новый вид вызова не проходит мимо разбора молча', () => {
  // Половина модулей политики и предпросмотр разбирают вызов через `switch` с `default`:
  // новый `kind` их не ломает — он через них просто проходит. Этот тест требует, чтобы
  // автор нового вида ОТНЁС его к одному из двух списков, а не забыл про него.
  it('каждый вид вызова назван явно', () => {
    const проверяется: CallKind[] = ['read', 'write', 'edit', 'bash', 'mcp'];
    const пропускается: CallKind[] = [
      'glob',
      'grep',
      'ask_human',
      'finalize_artifact',
      'subagent',
      'request_scope_extension',
      // Записи в отчёт этапа 6 файловой системы не касаются: на диск отчёт уходит одним
      // нормализованным `Write` рантайма, и проверяет его политика ровно там. Здесь
      // проверять нечего — путей в вызове нет вовсе.
      'record_claim',
      'record_finding',
      'unknown',
    ];
    const названы = new Set([...проверяется, ...пропускается]);
    for (const kind of CALL_KINDS) {
      ok(названы.has(kind), `вид «${kind}» не отнесён ни к проверяемым, ни к пропускаемым`);
    }
    strictEqual(названы.size, CALL_KINDS.length);
  });
});
