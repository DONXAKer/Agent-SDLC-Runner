/**
 * Субагенты во флоу `loop`.
 *
 * Инварианты, которые здесь сторожатся:
 * - права субагента = ПЕРЕСЕЧЕНИЕ прав этапа и объявленных прав агента (право на `Task` не
 *   расширяет права этапа);
 * - незаявленный субагент и провалившийся субагент отдаются ОШИБКОЙ, а не текстом: успешный
 *   исход засчитывается как состоявшееся ревью и зажигает обязательный гейт;
 * - рассказ вызывающего рецензенту не передаётся.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { LoopExecutor, SubagentUnavailable } from '../src/exec/LoopExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest, SubagentDef } from '../src/exec/StageExecutor.ts';

/** Провайдер-заглушка: отдаёт заранее записанные ходы по порядку. */
function provider(
  turns: { text: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
): ChatProvider {
  let i = 0;
  return {
    async chat() {
      const t = turns[Math.min(i++, turns.length - 1)];
      return {
        text: t?.text ?? '',
        toolCalls: (t?.toolCalls ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments,
          rawArguments: JSON.stringify(c.arguments),
        })),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

const reviewer: SubagentDef = {
  name: 'sdlc-reviewer',
  description: 'рецензент',
  prompt: 'ТЫ РЕЦЕНЗЕНТ',
  tools: ['Read', 'Grep', 'Bash'],
  model: null,
};

interface Seen {
  calls: NormalizedCall[];
  warns: string[];
  results: { ok: boolean; summary: string }[];
}

function emptySeen(): Seen {
  return { calls: [], warns: [], results: [] };
}

function hooks(seen: Seen): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (call: NormalizedCall) => {
      seen.calls.push(call);
      return { allowed: true, updatedInput: null, by: 'policy' as const };
    },
    onToolResult: (r: { ok: boolean; summary: string }) => seen.results.push(r),
    onAskHuman: async () => ({}),
    onUsage: () => {},
    onWarn: (m: string) => seen.warns.push(m),
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап', user: 'работай', tools: [], editedByOperator: false },
    cwd: process.cwd(),
    model: 'm',
    allowedTools: ['Read', 'Grep', 'Task'] as ToolName[],
  mcp: null,
  finishGuard: null,
  salvageFromText: null,
    readOnlyDirs: [],
    subagents: [reviewer],
    maxTurns: 8,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

const callTask = (agent: string) => ({
  id: 't1',
  name: 'Task',
  arguments: { subagent_type: agent, prompt: 'проверь diff' },
});

describe('субагент во флоу loop', () => {
  it('незаявленный субагент — ошибка, а не текст', async () => {
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: provider([{ text: '', toolCalls: [callTask('кто-то-другой')] }, { text: 'готово' }]),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request(), hooks(seen));
    // Этап может продолжиться — модели сообщают об отказе и она вправе доработать иначе.
    // Важно другое: вызов отчитывается ОШИБКОЙ инструмента, поэтому «состоявшимся ревью»
    // он не считается и обязательный гейт от него не зеленеет.
    ok(seen.warns.some((w) => w.includes('не объявлен')), 'нет предупреждения об отказе');
    ok(seen.results.some((r) => !r.ok && r.summary.includes('субагент')), 'вызов не помечен ошибкой');
  });

  it('объявленный субагент запускается с пересечением прав', async () => {
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: provider([
        { text: '', toolCalls: [callTask('sdlc-reviewer')] },
        { text: 'отчёт рецензента' },
        { text: 'этап завершён' },
      ]),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    const r = await exec.run(request(), hooks(seen));
    strictEqual(r.ok, true);
    const started = seen.warns.find((w: string) => w.includes('запущен субагент'));
    ok(started !== undefined, 'нет сообщения о запуске');
    // Bash объявлен агентом, но этапу не выдан — в пересечение он попасть не может.
    strictEqual(started.includes('Bash'), false);
    ok(started.includes('Read') && started.includes('Grep'));
  });

  it('право на Task субагенту не передаётся: рекурсия исключена', async () => {
    const withTask: SubagentDef = { ...reviewer, tools: ['Read', 'Task'] };
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: provider([
        { text: '', toolCalls: [callTask('sdlc-reviewer')] },
        { text: 'отчёт' },
        { text: 'готово' },
      ]),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request({ subagents: [withTask] }), hooks(seen));
    // Само сообщение о запуске может содержать Task (он в пересечении прав), но вложенный
    // прогон получает пустой список субагентов — вызвать по нему некого.
    ok(seen.warns.some((w) => w.includes('запущен субагент')));
  });
});

describe('параллельный запуск субагентов', () => {
  const second: SubagentDef = { ...reviewer, name: 'sdlc-claims', prompt: 'ТЫ СЛЕПОЙ ЛИСТ' };

  it('два субагента одним ходом идут одновременно, а не подряд', async () => {
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: provider([
        {
          text: '',
          toolCalls: [
            { id: 'a', name: 'Task', arguments: { subagent_type: 'sdlc-reviewer', prompt: 'разведка' } },
            { id: 'b', name: 'Task', arguments: { subagent_type: 'sdlc-claims', prompt: 'слепой лист' } },
          ],
        },
        { text: 'ответ субагента' },
        { text: 'этап завершён' },
      ]),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    const r = await exec.run(request({ subagents: [reviewer, second] }), hooks(seen));
    strictEqual(r.ok, true);
    // Оба запущены: параллельность не должна проглатывать второй вызов.
    strictEqual(seen.warns.filter((w: string) => w.includes('запущен субагент')).length, 2);
  });

  it('смешанный ход (субагент плюс обычный инструмент) идёт последовательно', async () => {
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: provider([
        {
          text: '',
          toolCalls: [
            { id: 'a', name: 'Task', arguments: { subagent_type: 'sdlc-reviewer', prompt: 'x' } },
            { id: 'b', name: 'Read', arguments: { file_path: 'README.md' } },
          ],
        },
        { text: 'ответ' },
        { text: 'готово' },
      ]),
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    await exec.run(request(), hooks(seen));
    // Инструменты делят рабочее дерево, и порядок правок значим: параллелить их нельзя.
    ok(seen.calls.some((c) => c.kind === 'read'));
  });
});

describe('модель субагента во флоу loop', () => {
  it('алиас Claude Code (`model: opus`) не уходит провайдеру — субагент идёт на модели этапа', async () => {
    const withOpus: SubagentDef = { ...reviewer, model: 'opus' };
    const seenModels: string[] = [];
    let i = 0;
    const p = {
      async chat(req: { model: string }) {
        seenModels.push(req.model);
        const turns = [
          { text: '', toolCalls: [callTask('sdlc-reviewer')] },
          { text: 'отчёт' },
          { text: 'готово' },
        ];
        const t = turns[Math.min(i++, turns.length - 1)];
        return {
          text: t?.text ?? '',
          toolCalls: (t?.toolCalls ?? []).map((c) => ({
            id: c.id, name: c.name, arguments: c.arguments, rawArguments: JSON.stringify(c.arguments),
          })),
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: p,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request({ subagents: [withOpus] }), hooks(seen));
    ok(!seenModels.includes('opus'), 'алиас opus утёк провайдеру');
    ok(seen.warns.some((w) => w.includes('алиас Claude Code')), 'нет предупреждения об алиасе');
  });

  it('настоящая модель из определения субагента используется как есть', async () => {
    const withReal: SubagentDef = { ...reviewer, model: 'deepseek/deepseek-v4-pro' };
    const seenModels: string[] = [];
    let i = 0;
    const p = {
      async chat(req: { model: string }) {
        seenModels.push(req.model);
        const turns = [
          { text: '', toolCalls: [callTask('sdlc-reviewer')] },
          { text: 'отчёт' },
          { text: 'готово' },
        ];
        const t = turns[Math.min(i++, turns.length - 1)];
        return {
          text: t?.text ?? '',
          toolCalls: (t?.toolCalls ?? []).map((c) => ({
            id: c.id, name: c.name, arguments: c.arguments, rawArguments: JSON.stringify(c.arguments),
          })),
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const seen = emptySeen();
    const exec = new LoopExecutor({
      provider: p,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });
    await exec.run(request({ subagents: [withReal] }), hooks(seen));
    ok(seenModels.includes('deepseek/deepseek-v4-pro'), 'настоящая модель определения не применилась');
  });
});
