/**
 * Флоу `loop`: инструменты собственного цикла и сам цикл.
 *
 * Модель здесь подставная — проверяется поведение рантайма, а не качество ответов. Всё,
 * что в этом файле названо, отлаживалось на локальных моделях 4B-класса в AI-Workflow:
 * они пишут вызов текстом, ломают JSON в аргументах и зацикливаются на одном файле.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Decision, PreparedPrompt } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { LoopOptions } from '../src/exec/LoopExecutor.ts';
import { estimateMessageTokens } from '../src/exec/contextBudget.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { executeTool, type ToolContext } from '../src/exec/tools/index.ts';
import type { ChatProvider, ChatRequest, ChatTurn } from '../src/provider/ChatProvider.ts';
import { toolCallFromText } from '../src/provider/OpenAiCompatProvider.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-loop-')));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx: ToolContext = {
  projectRoot: root,
  maxResultBytes: 5_000,
  readRangeRequiredAboveBytes: 1_000,
  timeoutMs: 30_000,
  signal: new AbortController().signal,
};

describe('инструменты цикла', () => {
  it('Write создаёт каталоги и файл', async () => {
    const r = await executeTool(
      { kind: 'write', path: 'src/deep/A.ts', content: 'const a = 1;\n' },
      ctx,
    );
    ok(r.ok, r.text);
    strictEqual(readFileSync(join(root, 'src/deep/A.ts'), 'utf8'), 'const a = 1;\n');
  });

  it('Read отдаёт строки с номерами — иначе правку «по строке 42» не с чем сверить', async () => {
    const r = await executeTool({ kind: 'read', path: 'src/deep/A.ts', range: null }, ctx);
    ok(r.ok);
    ok(r.text.startsWith('1\tconst a = 1;'), r.text);
  });

  it('Read диапазоном берёт ровно запрошенные строки', async () => {
    writeFileSync(join(root, 'many.txt'), ['a', 'b', 'c', 'd', 'e'].join('\n'));
    const r = await executeTool({ kind: 'read', path: 'many.txt', range: { from: 2, to: 4 } }, ctx);
    deepStrictEqual(r.text.split('\n'), ['2\tb', '3\tc', '4\td']);
  });

  // Локальный контур живёт на 16K контекста: файл целиком вытесняет из него входные
  // артефакты этапа, и модель начинает работать по памяти вместо текста.
  it('большой файл целиком не отдаётся — требуется диапазон', async () => {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(2_000));
    const r = await executeTool({ kind: 'read', path: 'big.txt', range: null }, ctx);
    strictEqual(r.ok, false);
    ok(/диапазон/i.test(r.text), r.text);
  });

  it('Read несуществующего файла — ошибка, а не пустота', async () => {
    const r = await executeTool({ kind: 'read', path: 'нет-такого.txt', range: null }, ctx);
    strictEqual(r.ok, false);
  });

  it('Edit применяет правку', async () => {
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'src/deep/A.ts',
        edits: [{ oldStr: 'const a = 1;', newStr: 'const a = 2;', replaceAll: false }],
      },
      ctx,
    );
    ok(r.ok, r.text);
    ok(readFileSync(join(root, 'src/deep/A.ts'), 'utf8').includes('const a = 2;'));
  });

  // Неоднозначная правка попадёт не туда, где её ждали, и всплывёт это только на ревью.
  it('неоднозначная правка отклоняется целиком, а не применяется наугад', async () => {
    writeFileSync(join(root, 'dup.ts'), 'x = 1;\nx = 1;\n');
    const before = readFileSync(join(root, 'dup.ts'), 'utf8');
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'dup.ts',
        edits: [{ oldStr: 'x = 1;', newStr: 'x = 2;', replaceAll: false }],
      },
      ctx,
    );
    strictEqual(r.ok, false);
    ok(/встречается 2 раз/.test(r.text), r.text);
    strictEqual(readFileSync(join(root, 'dup.ts'), 'utf8'), before, 'файл не должен измениться');
  });

  it('пачка правок либо применяется целиком, либо не применяется вовсе', async () => {
    writeFileSync(join(root, 'batch.ts'), 'a = 1;\nb = 2;\n');
    const before = readFileSync(join(root, 'batch.ts'), 'utf8');
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'batch.ts',
        edits: [
          { oldStr: 'a = 1;', newStr: 'a = 9;', replaceAll: false },
          { oldStr: 'такого-нет', newStr: 'x', replaceAll: false },
        ],
      },
      ctx,
    );
    strictEqual(r.ok, false);
    strictEqual(readFileSync(join(root, 'batch.ts'), 'utf8'), before);
  });

  // Живой прогон (`docs/model-runs.md`, серия r33): модель написала `import { Add, Subtract }`
  // с заглавной буквы, которых в целевом файле нет, — и не заметила, что код не грузится.
  it('Write ловит несуществующий именованный импорт из соседнего файла', async () => {
    writeFileSync(join(root, 'money.ts'), 'export function add(a: number, b: number) {\n  return a + b;\n}\n');
    const r = await executeTool(
      { kind: 'write', path: 'broken.ts', content: "import { Add } from './money.ts';\n" },
      ctx,
    );
    strictEqual(r.ok, false);
    ok(r.text.includes('«Add» не экспортируется'), r.text);
    ok(r.text.includes('add'), r.text);
    // Файл при этом уже лежит на диске — правку модель делает следующим ходом, не Write заново.
    ok(readFileSync(join(root, 'broken.ts'), 'utf8').includes('Add'));
  });

  it('Write с верным импортом проверку не трогает', async () => {
    const r = await executeTool(
      { kind: 'write', path: 'fine.ts', content: "import { add } from './money.ts';\n" },
      ctx,
    );
    ok(r.ok, r.text);
  });

  it('Edit, ломающий импорт правкой, ловится так же, как Write', async () => {
    writeFileSync(join(root, 'consumer.ts'), "import { add } from './money.ts';\n");
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'consumer.ts',
        edits: [{ oldStr: 'import { add }', newStr: 'import { Add }', replaceAll: false }],
      },
      ctx,
    );
    strictEqual(r.ok, false);
    ok(r.text.includes('«Add» не экспортируется'), r.text);
  });

  it('импорт из файла без единого распознанного экспорта не считается расхождением', async () => {
    writeFileSync(join(root, 'opaque.ts'), 'export default function () {}\n');
    const r = await executeTool(
      { kind: 'write', path: 'usesOpaque.ts', content: "import { anything } from './opaque.ts';\n" },
      ctx,
    );
    ok(r.ok, r.text);
  });

  it('импорт пакета (не относительный путь) проверкой не трогается', async () => {
    const r = await executeTool(
      { kind: 'write', path: 'usesPkg.ts', content: "import { z } from 'zod';\n" },
      ctx,
    );
    ok(r.ok, r.text);
  });

  // Относительный импорт без расширения `.ts` резолвится здесь терпимо (эта проверка — про
  // имена экспорта, не про формат пути): в отличие от прежней версии, «файл нашёлся» не
  // считается расхождением сама по себе. Формат пути под конкретный проект — гейт
  // «Импорты» (`server/test/importsGate.test.ts`), не эта проверка Write/Edit.
  it('Write с импортом без расширения `.ts` — не расхождение (формат пути не здесь)', async () => {
    const r = await executeTool(
      { kind: 'write', path: 'noExt.ts', content: "import { add } from './money';\n" },
      ctx,
    );
    ok(r.ok, r.text);
  });

  // Серии из 4–26 промахов подряд у одной и той же модели по одному и тому же файлу
  // (`docs/model-runs.md`, серия r33) — модель не звала Read между попытками.
  it('промах Edit возвращает текущее содержимое файла, а не только «прочитай заново»', async () => {
    writeFileSync(join(root, 'target.txt'), 'первая строка\nвторая строка\n');
    const r = await executeTool(
      {
        kind: 'edit',
        path: 'target.txt',
        edits: [{ oldStr: 'такого текста тут нет', newStr: 'x', replaceAll: false }],
      },
      ctx,
    );
    strictEqual(r.ok, false);
    ok(r.text.includes('1\tпервая строка'), r.text);
    ok(r.text.includes('2\tвторая строка'), r.text);
  });

  it('Glob находит файлы и пропускает служебные каталоги', async () => {
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules/pkg/B.ts'), '');
    const r = await executeTool({ kind: 'glob', pattern: '**/*.ts', path: null }, ctx);
    ok(r.text.includes('src/deep/A.ts'), r.text);
    ok(!r.text.includes('node_modules'), r.text);
  });

  it('Grep находит строку с адресом', async () => {
    const r = await executeTool({ kind: 'grep', pattern: 'const a', path: null }, ctx);
    ok(r.ok);
    ok(/src\/deep\/A\.ts:1:/.test(r.text), r.text);
  });

  it('сломанное выражение не роняет этап', async () => {
    const r = await executeTool({ kind: 'grep', pattern: '([', path: null }, ctx);
    strictEqual(r.ok, false);
  });

  it('Bash отдаёт код возврата и вывод', async () => {
    const r = await executeTool({ kind: 'bash', command: 'echo loop-tool-ok' }, ctx);
    ok(r.ok, r.text);
    ok(r.text.includes('loop-tool-ok'), r.text);
  });

  it('пол безопасности действует и в цикле', async () => {
    const r = await executeTool({ kind: 'bash', command: 'rm -rf /' }, ctx);
    strictEqual(r.ok, false);
  });

  it('инструменты, которые исполняет цикл, а не диск, сюда не проваливаются', async () => {
    const r = await executeTool({ kind: 'ask_human', questions: [] }, ctx);
    strictEqual(r.ok, false);
  });
});

describe('вызов, написанный текстом', () => {
  const known = new Set(['Read', 'Write']);

  it('явная форма распознаётся', () => {
    const call = toolCallFromText('Сейчас прочитаю: {"tool": "Read", "arguments": {"file_path": "a.ts"}}', known);
    strictEqual(call?.name, 'Read');
    deepStrictEqual(call?.arguments, { file_path: 'a.ts' });
  });

  it('синонимы имени поля тоже', () => {
    strictEqual(toolCallFromText('{"name": "Write", "input": {"file_path": "a"}}', known)?.name, 'Write');
  });

  // Свободный JSON в ответе — чаще кусок артефакта, чем вызов. Приняв его за вызов, мы бы
  // исполнили то, чего модель не просила.
  it('произвольный JSON вызовом не считается', () => {
    strictEqual(toolCallFromText('{"files_to_touch": ["a.ts"]}', known), null);
    strictEqual(toolCallFromText('{"tool": "НеизвестныйИнструмент", "arguments": {}}', known), null);
    strictEqual(toolCallFromText('просто текст без фигурных скобок', known), null);
  });

  // Преполёт 2026-09-14, ministral3-14b: служебный `[TOOL_CALLS]` съеден шаблоном движка,
  // и вызов дошёл текстом — раньше это читалось «модель не вызвала инструмент».
  it('родная форма Mistral распознаётся — с префиксом [TOOL_CALLS] и без', () => {
    const call = toolCallFromText('Write[ARGS]{"file_path": "notes/hello.md", "content": "привет"}', known);
    strictEqual(call?.name, 'Write');
    deepStrictEqual(call?.arguments, { file_path: 'notes/hello.md', content: 'привет' });
    strictEqual(toolCallFromText('[TOOL_CALLS]Read[ARGS] {"file_path": "a.ts"}', known)?.name, 'Read');
  });

  it('форма Mistral: незнакомое имя, маркер без объекта, битый JSON — не вызов', () => {
    strictEqual(toolCallFromText('Delete[ARGS]{"file_path": "a.ts"}', known), null);
    strictEqual(toolCallFromText('в описании встречается Read[ARGS] без аргументов', known), null);
    strictEqual(toolCallFromText('Write[ARGS]{"file_path": "a.ts", "content": ', known), null);
  });

  // code-review 2026-09-14: маркер искался в любом месте текста, и процитированный пример
  // исполнялся. Форма Mistral принимается, только если ответ с вызова начинается.
  it('форма Mistral, процитированная посреди прозы, — не вызов', () => {
    strictEqual(toolCallFromText('Например: Read[ARGS]{"file_path": "a.ts"} — так выглядит вызов', known), null);
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
    model: 'test-model',
    allowedTools: ['Read', 'Write', 'Bash'],
  mcp: null,
  finishGuard: null,
  salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 10,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  };
}

function hooks(over: Partial<ExecHooks> = {}): ExecHooks & { warns: string[]; calls: string[] } {
  const warns: string[] = [];
  const calls: string[] = [];
  const base: ExecHooks = {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: (call) => {
      calls.push(call.kind);
      return Promise.resolve<Decision>({ allowed: true, updatedInput: null, by: 'auto' });
    },
    onToolResult: () => {},
    onAskHuman: () => Promise.resolve({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: (m) => warns.push(m),
    onFriction: () => {},
    ...over,
  };
  return Object.assign(base, { warns, calls });
}

/** Подставная модель: выдаёт заранее заданную последовательность ходов. */
function provider(turns: Partial<ChatTurn>[]): ChatProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  let i = 0;
  return {
    name: 'fake',
    seen,
    chat(req: ChatRequest): Promise<ChatTurn> {
      seen.push(req);
      const t = turns[Math.min(i, turns.length - 1)] ?? {};
      i++;
      return Promise.resolve({
        text: '',
        toolCalls: [],
        finishReason: 'end_turn',
        usage: emptyUsage(),
        ...t,
      });
    },
  };
}

function executor(p: ChatProvider, over: Partial<LoopOptions> = {}): LoopExecutor {
  return new LoopExecutor({
    provider: p,
    maxResultBytes: 5_000,
    readRangeRequiredAboveBytes: 1_000_000,
    bashTimeoutMs: 30_000,
    temperature: null,
    ...over,
  });
}

const readCall = (path: string): ChatTurn['toolCalls'][number] => ({
  id: 'c1',
  name: 'Read',
  arguments: { file_path: path },
  rawArguments: JSON.stringify({ file_path: path }),
});

describe('цикл tool-use', () => {
  it('ход без вызовов завершает этап', async () => {
    const r = await executor(provider([{ text: 'готово', finishReason: 'end_turn' }])).run(
      request(),
      hooks(),
    );
    strictEqual(r.ok, true);
    strictEqual(r.finalText, 'готово');
  });

  it('вызов инструмента проходит через гейт, а не мимо него', async () => {
    const h = hooks();
    await executor(
      provider([
        { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
        { text: 'всё', finishReason: 'end_turn' },
      ]),
    ).run(request(), h);
    deepStrictEqual(h.calls, ['read']);
  });

  it('отказ гейта доезжает до модели текстом, а не роняет этап', async () => {
    const h = hooks({
      onToolRequest: () =>
        Promise.resolve<Decision>({ allowed: false, reason: 'вне плана', by: 'policy' }),
    });
    const p = provider([
      { toolCalls: [readCall('чужой.txt')], finishReason: 'tool_use' },
      { text: 'понял', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request(), h);
    strictEqual(r.ok, true);
    const toolMessage = p.seen[1]?.messages.find((m) => m.role === 'tool');
    ok(toolMessage !== undefined && /вне плана/.test(toolMessage.content));
  });

  // 4B-модель способна звать Read по одному файлу до конца бюджета.
  it('повторение одного и того же вызова обрывает этап', async () => {
    const h = hooks();
    const r = await executor(
      provider([{ toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' }]),
    ).run(request(), h);
    strictEqual(r.ok, false);
    ok(/прогресса нет/.test(r.note), r.note);
    ok(h.warns.length > 0, 'остановка обязана быть названа, а не тихо случиться');
  });

  it('повтор при РАСТУЩЕМ результате этап не обрывает', async () => {
    // Дважды измеренный обрыв (`Read`×3, `Edit`×3) случался ПОСЛЕ прогона гейтов и
    // посреди заполнения отчёта: работа шла, повторялся один вызов, и этап терялся
    // целиком вместе с уже оплаченными гейтами. «Прогресса нет» обязано означать
    // «ничего не прибавилось», а не «вызов тот же».
    const h = hooks();
    let done = 0;
    const p = provider([
      { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
      { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
      { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request({ progressSignal: () => ++done }), h);
    strictEqual(r.ok, true);
    ok(
      h.warns.some((w) => /новых результат/.test(w)),
      h.warns.join(' | '),
    );
  });

  it('повтор при ЗАСТЫВШЕМ результате обрывает по-прежнему', async () => {
    const h = hooks();
    const r = await executor(
      provider([{ toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' }]),
    ).run(request({ progressSignal: () => 7 }), h);
    strictEqual(r.ok, false);
    ok(/прогресса нет/.test(r.note), r.note);
  });

  it('сломанный JSON в аргументах объясняется модели, а не роняет этап', async () => {
    const p = provider([
      {
        toolCalls: [{ id: 'c1', name: 'Read', arguments: null, rawArguments: '{file_path:' }],
        finishReason: 'tool_use',
      },
      { text: 'исправился', finishReason: 'end_turn' },
    ]);
    const h = hooks();
    const r = await executor(p).run(request(), h);
    strictEqual(r.ok, true);
    deepStrictEqual(h.calls, [], 'нечитаемый вызов до гейта доходить не должен');
    const toolMessage = p.seen[1]?.messages.find((m) => m.role === 'tool');
    ok(toolMessage !== undefined && /не разобрались/.test(toolMessage.content));
  });

  it('правка аргументов оператором исполняется вместо исходного вызова', async () => {
    const h = hooks({
      onToolRequest: () =>
        Promise.resolve<Decision>({
          allowed: true,
          updatedInput: { file_path: 'src/deep/A.ts' },
          by: 'operator',
        }),
    });
    const p = provider([
      { toolCalls: [readCall('нет-такого.txt')], finishReason: 'tool_use' },
      { text: 'ок', finishReason: 'end_turn' },
    ]);
    await executor(p).run(request(), h);
    const toolMessage = p.seen[1]?.messages.find((m) => m.role === 'tool');
    ok(toolMessage !== undefined && /const a/.test(toolMessage.content), toolMessage?.content);
  });

  it('лимит ходов этапа завершает цикл, а не крутит его вечно', async () => {
    let n = 0;
    const p: ChatProvider = {
      name: 'fake',
      chat: () => {
        n++;
        return Promise.resolve({
          text: '',
          // Аргументы разные каждый ход: детект повтора не должен подменять лимит ходов.
          toolCalls: [readCall(`f${n}.txt`)],
          finishReason: 'tool_use' as const,
          usage: emptyUsage(),
        });
      },
    };
    const r = await executor(p).run(request({ maxTurns: 3 }), hooks());
    strictEqual(r.ok, false);
    ok(/лимит ходов/.test(r.note), r.note);
    strictEqual(n, 3);
  });

  it('отмена прерывает цикл', async () => {
    const aborter = new AbortController();
    aborter.abort();
    const r = await executor(provider([{ text: 'x' }])).run(
      request({ signal: aborter.signal }),
      hooks(),
    );
    strictEqual(r.ok, false);
    ok(/отмен/.test(r.note));
  });

  it('этапу отдаются имена инструментов его прав, без MCP-префикса', async () => {
    const p = provider([{ text: 'ok', finishReason: 'end_turn' }]);
    await executor(p).run(request({ allowedTools: ['Read', 'AskHuman'] }), hooks());
    deepStrictEqual(
      p.seen[0]?.tools.map((t) => t.name),
      ['Read', 'AskHuman'],
    );
  });

  // Методология держит на субагентах то, что нельзя доверить автору работы. Цикл их теперь
  // запускает вложенным прогоном, но ВЫЗОВ НЕОБЪЯВЛЕННОГО агента по-прежнему обязан быть
  // отказом, а не выглядеть успешным: успешный исход здесь зажигает обязательный гейт
  // «Ревью независимым агентом».
  it('вызов необъявленного субагента остаётся отказом, а не успехом', async () => {
    const h = hooks();
    const p = provider([
      {
        toolCalls: [
          {
            id: 'c1',
            name: 'Task',
            arguments: { subagent_type: 'sdlc-reviewer', prompt: 'проверь' },
            rawArguments: '{}',
          },
        ],
        finishReason: 'tool_use',
      },
      { text: 'ладно', finishReason: 'end_turn' },
    ]);
    // В `request()` субагенты не объявлены, поэтому вызов «sdlc-reviewer» законным не
    // является — права субагента задаются конструкцией, а не просьбой модели.
    await executor(p).run(request({ allowedTools: ['Read', 'Task'] }), h);
    ok(h.warns.some((w) => /не объявлен/.test(w)), h.warns.join('; '));
  });
});

describe('max_tokens по остатку окна (LoopOptions.contextWindow)', () => {
  it('не задан contextWindow — params уходит как есть, без вычисления', async () => {
    const p = provider([
      { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    await executor(p, { params: { seed: 1 } }).run(request(), hooks());
    deepStrictEqual(p.seen[0]?.params, { seed: 1 });
    deepStrictEqual(p.seen[1]?.params, { seed: 1 });
  });

  // Раньше первый ход уходил с константой провайдера («окну ещё не с чем сравнить») —
  // ровно там, где промпт этапа крупнее всего. Теперь бюджет считается по оценке
  // исходящего запроса. Запас — ОДИН результат (ceil(5000/4) = 1250), а не три: оценка уже
  // содержит всю историю, результатов инструментов сверх неё нет — запас в три вычитал
  // несуществующие результаты и на окне 16K сажал первый ход на пол.
  it('первый ход — max_tokens по оценке исходящего запроса с запасом в один результат', async () => {
    const p = provider([{ toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' }]);
    await executor(p, { contextWindow: 16384 }).run(request({ maxTurns: 1 }), hooks());
    const sent = p.seen[0]!;
    // Массив истории цикл дописывает после запроса (без окна истории `outgoing` — он сам),
    // поэтому оценка — по двум сообщениям, ушедшим в первый запрос.
    const outgoing = sent.messages.slice(0, 2);
    const estimate = estimateMessageTokens([{ content: JSON.stringify({ outgoing, tools: sent.tools }) }]);
    deepStrictEqual(sent.params, { max_tokens: 16384 - estimate - 1250 });
  });

  // `inputTokens: 0` на первом ответе раньше записывался измерением, и `?? оценка`
  // пропускала 0: второй ход считал бюджет по «пустому» контексту — 16384 − 0 − 3750.
  it('первый ответ без usage (inputTokens 0) — второй ход по оценке, а не по пустому окну', async () => {
    const p = provider([
      { toolCalls: [readCall('src/deep/A.ts')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    await executor(p, { contextWindow: 16384 }).run(request(), hooks());
    const sent = p.seen[1]!;
    const estimate = estimateMessageTokens([{ content: JSON.stringify({ outgoing: sent.messages, tools: sent.tools }) }]);
    ok(estimate > 0);
    deepStrictEqual(sent.params, { max_tokens: 16384 - estimate - 1250 });
  });

  // Сам ответ уже в истории второго запроса, а `prompt_tokens` его не содержит. Прибавляется
  // оценка того, что ЛЕГЛО в историю, а не `completion_tokens`: у reasoning-модели в них
  // рассуждение, которое в историю не возвращается (code-review, 2026-09-15). Но и 4 байта на
  // токен недосчитывали плотный код: доля ответа — не меньше `completion_tokens`, ограниченных
  // ДВУМЯ байтами на токен сохранённого текста (code-review-all, 2026-09-15).
  it('второй ход — к prompt_tokens прибавлен сохранённый ответ: completion_tokens под потолком 2 байта на токен', async () => {
    const call = readCall('src/deep/A.ts');
    const p = provider([
      {
        toolCalls: [call],
        finishReason: 'tool_use',
        usage: { ...emptyUsage(), inputTokens: 3000, outputTokens: 5000 },
      },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    await executor(p, { contextWindow: 16384 }).run(request(), hooks());
    const visible = `${call.name}${call.rawArguments}`;
    const stored = Math.max(
      estimateMessageTokens([{ content: visible }]),
      Math.min(5000, Math.ceil(Buffer.byteLength(visible, 'utf8') / 2)),
    );
    deepStrictEqual(p.seen[1]?.params, { max_tokens: 16384 - 3000 - stored - 3750 });
  });

  it('второй ход — max_tokens посчитан по prompt_tokens первого ответа и запасу', async () => {
    const call = readCall('src/deep/A.ts');
    const p = provider([
      {
        toolCalls: [call],
        finishReason: 'tool_use',
        usage: { ...emptyUsage(), inputTokens: 3000 },
      },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const h = hooks();
    // Запас — TOOL_RESULTS_MARGIN_FACTOR (3) результатов у потолка `maxResultBytes`
    // тестового исполнителя (5000 байт): ceil(5000/4)×3 = 3750 (code-review-all,
    // 2026-09-11 — прежний фиксированный запас 512 был на порядок меньше одного
    // крупного результата инструмента). Окно взято большим специально, чтобы остаток
    // остался положительным при таком запасе: 16384 − 3000 − ответ − 3750.
    await executor(p, { contextWindow: 16384 }).run(request(), h);
    const stored = estimateMessageTokens([{ content: `${call.name}${call.rawArguments}` }]);
    deepStrictEqual(p.seen[1]?.params, { max_tokens: 16384 - 3000 - stored - 3750 });
    ok(!h.warns.some((w) => /почти исчерпано/.test(w)), 'предупреждения при незажатом расчёте быть не должно');
  });

  it('остаток ушёл в минус — пол не даёт вырожденный потолок, и оператор предупреждён', async () => {
    const p = provider([
      {
        toolCalls: [readCall('src/deep/A.ts')],
        finishReason: 'tool_use',
        usage: { ...emptyUsage(), inputTokens: 3000 },
      },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const h = hooks();
    // 4096 − 3000 − 3750 (запас) < 0 — пол MIN_MAX_TOKENS = 256 забирает верх.
    await executor(p, { contextWindow: 4096 }).run(request(), h);
    deepStrictEqual(p.seen[1]?.params, { max_tokens: 256 });
    ok(
      h.warns.some((w) => /почти исчерпано/.test(w)),
      'тихий пол выглядел бы как рабочий расчёт — оператор обязан быть предупреждён',
    );
  });

  it('явный max_tokens в ModelDef.params перекрывает вычисленное значение', async () => {
    const p = provider([
      {
        toolCalls: [readCall('src/deep/A.ts')],
        finishReason: 'tool_use',
        usage: { ...emptyUsage(), inputTokens: 3000 },
      },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    await executor(p, { contextWindow: 4096, params: { max_tokens: 999, temperature: 0.1 } }).run(
      request(),
      hooks(),
    );
    // Оператор назвал число явно — он знает больше рантайма (тот же порядок, что у
    // `applyParams` в провайдере).
    deepStrictEqual(p.seen[1]?.params, { max_tokens: 999, temperature: 0.1 });
  });
});
