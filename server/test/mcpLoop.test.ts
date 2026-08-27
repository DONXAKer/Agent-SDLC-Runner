/**
 * Флоу `loop` с внешними MCP-серверами.
 *
 * Три вещи, которые ломаются молча и потому проверяются здесь: набор инструментов доезжает
 * до модели ровно тот, что выдан; вызов исполняется через хаб, а не через файловый
 * инструментарий; опросные инструменты (`pie_status`, `wait_for_*`) не считаются
 * топтанием на месте — иначе ожидание редактора обрывало бы этап диагнозом «прогресса нет»,
 * который был бы неверным.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Decision, PreparedPrompt } from '@sdlc-runner/shared';
import { emptyUsage } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ExecHooks, ExecRequest, McpAccess } from '../src/exec/StageExecutor.ts';
import type { ChatProvider, ChatRequest, ChatTurn } from '../src/provider/ChatProvider.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-mcploop-'));

const PROMPT: PreparedPrompt = {
  presetNote: null,
  system: 'системный блок',
  user: 'задача',
  tools: [],
  editedByOperator: false,
};

const mcpCall = (tool: string, id = 'c1'): ChatTurn['toolCalls'][number] => ({
  id,
  name: `mcp__unreal__${tool}`,
  arguments: {},
  rawArguments: '{}',
});

function access(over: Partial<McpAccess> = {}): McpAccess & { calls: string[] } {
  const calls: string[] = [];
  const base: McpAccess = {
    tools: [
      { name: 'mcp__unreal__pie_status', description: 'состояние PIE', schema: { type: 'object' } },
      {
        name: 'mcp__unreal__spawn_actor',
        description: 'создать актёра',
        schema: { type: 'object' },
      },
    ],
    call: (server, tool) => {
      calls.push(`${server}.${tool}`);
      return Promise.resolve({ ok: true, text: `ответ ${tool}` });
    },
    sdkServers: {},
    pollingTools: ['pie_status'],
    ...over,
  };
  return Object.assign(base, { calls });
}

function request(mcp: McpAccess | null, over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: PROMPT,
    cwd: root,
    model: 'test-model',
    allowedTools: ['Read', 'McpRead', 'McpWrite'],
    mcp,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 8,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  };
}

function hooks(over: Partial<ExecHooks> = {}): ExecHooks & { friction: string[]; kinds: string[] } {
  const friction: string[] = [];
  const kinds: string[] = [];
  const base: ExecHooks = {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: (call) => {
      kinds.push(call.kind);
      return Promise.resolve<Decision>({ allowed: true, updatedInput: null, by: 'auto' });
    },
    onToolResult: () => {},
    onAskHuman: () => Promise.resolve({}),
    onUsage: () => {},
    onWarn: () => {},
    onFriction: (k) => friction.push(k),
    ...over,
  };
  return Object.assign(base, { friction, kinds });
}

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

const executor = (p: ChatProvider): LoopExecutor =>
  new LoopExecutor({
    provider: p,
    maxResultBytes: 5_000,
    readRangeRequiredAboveBytes: 1_000_000,
    bashTimeoutMs: 30_000,
    temperature: null,
  });

describe('флоу loop: внешние MCP-инструменты', () => {
  it('набор доезжает до модели вместе с собственными инструментами раннера', async () => {
    const p = provider([{ text: 'готово', finishReason: 'end_turn' }]);
    await executor(p).run(request(access()), hooks());

    const names = (p.seen[0]?.tools ?? []).map((t) => t.name);
    ok(names.includes('Read'), 'собственные инструменты остаются');
    ok(names.includes('mcp__unreal__pie_status'), 'MCP-инструменты добавлены');
  });

  it('вызов проходит через гейт и исполняется хабом', async () => {
    const m = access();
    const h = hooks();
    const p = provider([
      { toolCalls: [mcpCall('pie_status')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    await executor(p).run(request(m), h);

    strictEqual(h.kinds[0], 'mcp', 'вызов нормализован как MCP и дошёл до гейта');
    strictEqual(m.calls.join(), 'unreal.pie_status');
  });

  it('MCP не выдан на этапе — вызов не исполняется, но этап не падает', async () => {
    const h = hooks();
    const p = provider([
      { toolCalls: [mcpCall('pie_status')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request(null), h);
    strictEqual(r.ok, true);
  });

  it('опросный инструмент можно звать подряд — это не топтание на месте', async () => {
    const m = access();
    const h = hooks();
    // Три одинаковых хода подряд: обычному вызову это оборвало бы этап на третьем.
    const p = provider([
      { toolCalls: [mcpCall('pie_status')], finishReason: 'tool_use' },
      { toolCalls: [mcpCall('pie_status')], finishReason: 'tool_use' },
      { toolCalls: [mcpCall('pie_status')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request(m), h);
    strictEqual(r.ok, true);
    strictEqual(m.calls.length, 3, 'все три опроса исполнены');
    strictEqual(h.friction.includes('repeat'), false, 'повтор опроса трением не считается');
  });

  it('обычный инструмент, повторённый подряд, по-прежнему обрывает этап', async () => {
    const m = access();
    const h = hooks();
    const p = provider([
      { toolCalls: [mcpCall('spawn_actor')], finishReason: 'tool_use' },
      { toolCalls: [mcpCall('spawn_actor')], finishReason: 'tool_use' },
      { toolCalls: [mcpCall('spawn_actor')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request(m), h);
    strictEqual(r.ok, false);
    ok(r.note.includes('прогресса нет'));
    ok(h.friction.includes('repeat'));
  });

  it('отказ политики не роняет этап и считается трением', async () => {
    const h = hooks({
      onToolRequest: () =>
        Promise.resolve<Decision>({ allowed: false, reason: 'нет в списке', by: 'policy' }),
    });
    const p = provider([
      { toolCalls: [mcpCall('spawn_actor')], finishReason: 'tool_use' },
      { text: 'готово', finishReason: 'end_turn' },
    ]);
    const r = await executor(p).run(request(access()), h);
    strictEqual(r.ok, true);
    ok(h.friction.includes('denied'));
  });
});
