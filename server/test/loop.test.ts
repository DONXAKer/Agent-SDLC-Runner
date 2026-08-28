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

function executor(p: ChatProvider): LoopExecutor {
  return new LoopExecutor({
    provider: p,
    maxResultBytes: 5_000,
    readRangeRequiredAboveBytes: 1_000_000,
    bashTimeoutMs: 30_000,
    temperature: null,
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
