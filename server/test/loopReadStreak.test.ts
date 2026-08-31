/**
 * Бюджет ходов на чтение во флоу `loop`.
 *
 * Замер этапа 5 (`docs/model-runs.md`): 8 вызовов за этап — все чтение, дерево не
 * изменилось. Инвариант: серия из `READ_STREAK_LIMIT` чтений подряд БЕЗ записи получает
 * напоминание «пора писать»; запись серию сбрасывает; субагентам и этапам без артефакта
 * (finishGuard === null) напоминание не шлётся — для читателя серия чтений законна.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ToolName } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ChatMessage, ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

interface Turn {
  text: string;
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
}

/** Провайдер-заглушка, записывающий каждый входящий запрос. */
function provider(turns: Turn[], seenRequests: ChatRequest[]): ChatProvider {
  let i = 0;
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      // Исполнитель мутирует один и тот же массив messages между ходами — без копии все
      // сохранённые запросы к концу прогона выглядят как последний.
      seenRequests.push({ ...req, messages: structuredClone(req.messages) });
      const t = turns[Math.min(i++, turns.length - 1)];
      return {
        text: t?.text ?? '',
        toolCalls: (t?.toolCalls ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
          rawArguments: JSON.stringify(c.arguments),
        })),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0,
          durationMs: 1,
          envBlocked: false,
        },
        finishReason: (t?.toolCalls ?? []).length > 0 ? ('tool_use' as const) : ('end_turn' as const),
      };
    },
  } as unknown as ChatProvider;
}

function hooks(frictions: string[]): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async () => ({ allowed: true, updatedInput: null, by: 'policy' as const }),
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: () => {},
    onFriction: (k: string) => frictions.push(k),
  } as unknown as ExecHooks;
}

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап', user: 'работай', tools: [], editedByOperator: false },
    cwd: process.cwd(),
    model: 'm',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit'] as ToolName[],
    mcp: null,
    // Артефакт «не готов» всегда: напоминание про чтение действует только на этапах
    // с артефактом, и здесь этап именно такой.
    finishGuard: () => 'артефакт не заполнен',
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 20,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

/** Ход из одного чтения; разные пути, чтобы не сработал детектор повторов. */
const read = (n: number): Turn => ({
  text: '',
  toolCalls: [{ id: `r${n}`, name: 'Read', arguments: { file_path: `/нет/такого/${n}.md` } }],
});

const lastUser = (req: ChatRequest): string => {
  const users = req.messages.filter((m: ChatMessage) => m.role === 'user');
  return users[users.length - 1]?.content ?? '';
};

describe('бюджет ходов на чтение (loop)', () => {
  it('пять чтений подряд без записи получают напоминание, и оно считается трением', async () => {
    const frictions: string[] = [];
    const seen: ChatRequest[] = [];
    const exec = new LoopExecutor({
      provider: provider([read(1), read(2), read(3), read(4), read(5), { text: 'готово' }], seen),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request(), hooks(frictions));

    ok(
      seen.some((r) => lastUser(r).includes('только чтение')),
      'напоминание «только чтение» не дошло до модели',
    );
    strictEqual(frictions.filter((k) => k === 'reminder').length >= 1, true, 'напоминание не посчитано трением');
  });

  it('запись сбрасывает серию: четыре чтения и Edit напоминания не дают', async () => {
    const frictions: string[] = [];
    const seen: ChatRequest[] = [];
    const exec = new LoopExecutor({
      provider: provider(
        [
          read(1),
          read(2),
          read(3),
          read(4),
          { text: '', toolCalls: [{ id: 'e1', name: 'Edit', arguments: { file_path: '/нет/x.md', old_string: 'а', new_string: 'б' } }] },
          read(5),
          { text: 'готово' },
        ],
        seen,
      ),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request(), hooks(frictions));

    ok(!seen.some((r) => lastUser(r).includes('только чтение')), 'напоминание пришло, хотя серия была сброшена записью');
  });

  it('без артефакта этапа (finishGuard=null) напоминание не шлётся — читателю серия законна', async () => {
    const seen: ChatRequest[] = [];
    const exec = new LoopExecutor({
      provider: provider([read(1), read(2), read(3), read(4), read(5), read(6), { text: 'отчёт' }], seen),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request({ finishGuard: null }), hooks([]));

    ok(!seen.some((r) => lastUser(r).includes('только чтение')), 'напоминание пришло субагенту-читателю');
  });

  it('четыре Bash подряд получают напоминание «этап делается правками», запись серию сбрасывает', async () => {
    const bash = (n: number): Turn => ({
      text: '',
      toolCalls: [{ id: `b${n}`, name: 'Bash', arguments: { command: `echo ${n}` } }],
    });
    const frictions: string[] = [];
    const seen: ChatRequest[] = [];
    const exec = new LoopExecutor({
      provider: provider([bash(1), bash(2), bash(3), bash(4), { text: 'готово' }], seen),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request({ allowedTools: ['Bash', 'Edit'] as ToolName[] }), hooks(frictions));
    ok(
      seen.some((r) => lastUser(r).includes('только Bash')),
      'напоминание «только Bash» не дошло до модели',
    );

    // Со сбросом Edit'ом на середине серии напоминания нет.
    const seen2: ChatRequest[] = [];
    const exec2 = new LoopExecutor({
      provider: provider(
        [
          bash(1),
          bash(2),
          bash(3),
          { text: '', toolCalls: [{ id: 'e1', name: 'Edit', arguments: { file_path: '/нет/x.md', old_string: 'а', new_string: 'б' } }] },
          bash(4),
          { text: 'готово' },
        ],
        seen2,
      ),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec2.run(request({ allowedTools: ['Bash', 'Edit'] as ToolName[] }), hooks([]));
    ok(!seen2.some((r) => lastUser(r).includes('только Bash')), 'напоминание пришло после сброса серии записью');
  });

  it('анти-цикл при ГОТОВОМ артефакте закрывает этап зелёным, а не красным (r17d)', async () => {
    // coder-next успешно заявила отчёт готовым и повторила FinalizeArtifact «для
    // верности» — готовый этап падал красным. Исход считается по диску: молчащий страж
    // при сработавшем анти-цикле = этап закрыт.
    const fin: Turn = {
      text: '',
      toolCalls: [{ id: 'f', name: 'FinalizeArtifact', arguments: { artifact: '.sdlc/x/отчёт.md' } }],
    };
    const seen: ChatRequest[] = [];
    const result = await new LoopExecutor({ provider: provider([fin, fin, fin, fin], seen), maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000, temperature: null }).run(
      request({ finishGuard: () => null }),
      hooks([]),
    );
    strictEqual(result.ok, true, result.note);
    ok(result.note.includes('закрыт по диску'), result.note);
  });

  it('анти-цикл при НЕготовом артефакте остаётся красным', async () => {
    const fin: Turn = {
      text: '',
      toolCalls: [{ id: 'f', name: 'FinalizeArtifact', arguments: { artifact: '.sdlc/x/отчёт.md' } }],
    };
    const result = await new LoopExecutor({ provider: provider([fin, fin, fin, fin], []), maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000, temperature: null }).run(
      request(),
      hooks([]),
    );
    strictEqual(result.ok, false);
    ok(result.note.includes('прогресса нет'), result.note);
  });

  it('params из конфига модели доезжают до провайдера', async () => {
    const seen: ChatRequest[] = [];
    const exec = new LoopExecutor({
      provider: provider([{ text: 'готово' }], seen),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
      params: { temperature: 0, max_tokens: 512 },
    });
    await exec.run(request({ finishGuard: null }), hooks([]));

    strictEqual(seen.length, 1);
    ok(seen[0]!.params !== null && seen[0]!.params !== undefined, 'params не переданы');
    strictEqual((seen[0]!.params as Record<string, unknown>)['max_tokens'], 512);
  });
});
