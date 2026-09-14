/**
 * `LoopExecutor` — напоминание о нулевом прогрессе после доли бюджета ходов
 * (`NO_PROGRESS_BUDGET_FRACTION`).
 *
 * Живой замер серии v4 (`docs/model-runs.md`, `ministral`/`security-bait`, 2026-09-14):
 * модель довела разведку и журнал chunk'а до конца, но исчерпала бюджет ходов, ни разу не
 * тронув исходный код — бумажная работа съела весь бюджет молча, без единого напоминания.
 *
 * Код-ревью того же дня (code-review-all) нашло два дефекта первой версии: совет «переходи
 * к Edit» был жёстко зашит и буквально неверен на `verify` (там прогресс —
 * `RecordClaim`/`RecordFinding`, не правка файлов), и блок не был гейтирован
 * `finishGuard !== null`, как соседние детекторы серий — субагент (`finishGuard: null`)
 * наследует родительский `progressSignal` и мог получить совет про инструмент, которого у
 * него нет. Оба фикса — ниже, тестами `finishGuard: null` и `progressHint`.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

// Разные аргументы на каждом ходу — иначе анти-цикл по отпечатку вызова (REPEAT_LIMIT)
// остановит серию раньше, чем успеет сработать напоминание, которое здесь проверяется.
const readCall = (id: string, n: number) => ({
  id,
  name: 'Read',
  arguments: { file_path: `src/demo${n}.ts` },
});

function hooks(): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (_call: NormalizedCall) => ({ allowed: true, updatedInput: null, by: 'policy' as const }),
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: () => {},
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function request(over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап', user: 'работай', tools: [], editedByOperator: false },
    cwd: process.cwd(),
    model: 'm',
    allowedTools: ['Read', 'Edit'] as ToolName[],
    mcp: null,
    // Не null: напоминание о нулевом прогрессе гейтится `finishGuard !== null`, тем же
    // приёмом, что у серий чтения/Bash/готовности — субагент (`finishGuard: null`)
    // адресатом совета «переходи к Edit» не является, см. отдельный тест ниже.
    finishGuard: () => 'артефакт не готов',
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 5,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    // Прогресс всегда 0 — ни одной принятой правки за весь ход, тот же сигнал, что у chunk
    // (`acceptedWrites`), когда модель не коснулась ни одного файла из плана.
    progressSignal: () => 0,
    ...over,
  } as ExecRequest;
}

describe('напоминание о нулевом прогрессе (NO_PROGRESS_BUDGET_FRACTION)', () => {
  it('после доли бюджета без единой правки — одно напоминание, не раньше и не дважды', async () => {
    const seenUserMessages: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        call++;
        seenUserMessages.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        return {
          text: '',
          toolCalls: [{ ...readCall(`r${call}`, call), rawArguments: JSON.stringify(readCall(`r${call}`, call).arguments) }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const executor = new LoopExecutor({
      provider,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    const result = await executor.run(request(), hooks());

    strictEqual(result.ok, false);
    ok(result.note.includes('исчерпан лимит ходов'), result.note);

    // maxTurns=5, доля 0.6 → ceil(3): условие проверяется ПОСЛЕ хода 3, напоминание
    // добавляется в историю и попадает в запрос хода 4 и остаётся в ней до конца (не
    // изымается) — то есть появляется у последних двух запросов из пяти, не раньше.
    deepStrictEqual(
      seenUserMessages.map((m) => m.includes('Пройдено')),
      [false, false, false, true, true],
    );
  });

  it('прогресс есть (progressSignal > 0) — напоминание не появляется', async () => {
    const seenUserMessages: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        call++;
        seenUserMessages.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        return {
          text: '',
          toolCalls: [{ ...readCall(`r${call}`, call), rawArguments: JSON.stringify(readCall(`r${call}`, call).arguments) }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const executor = new LoopExecutor({
      provider,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    await executor.run(request({ progressSignal: () => 1 }), hooks());

    ok(!seenUserMessages.some((m) => m.includes('Пройдено')), 'напоминание сработало при ненулевом прогрессе');
  });

  it('finishGuard: null (субагент) — напоминание не появляется даже при нулевом прогрессе (code-review-all, 2026-09-14)', async () => {
    const seenUserMessages: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        call++;
        seenUserMessages.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        return {
          text: '',
          toolCalls: [{ ...readCall(`r${call}`, call), rawArguments: JSON.stringify(readCall(`r${call}`, call).arguments) }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const executor = new LoopExecutor({
      provider,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    // `runSubagent` обнуляет `finishGuard`, но наследует родительский `progressSignal` —
    // без гейта по `finishGuard` субагент получал бы совет «переходи к Edit», которого у
    // него может не быть в наборе инструментов вовсе.
    await executor.run(request({ finishGuard: null }), hooks());

    ok(!seenUserMessages.some((m) => m.includes('Пройдено')), 'напоминание сработало без finishGuard');
  });

  it('progressHint подменяет совет по умолчанию (verify: находки, а не Edit)', async () => {
    const seenUserMessages: string[] = [];
    let call = 0;
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        call++;
        seenUserMessages.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        return {
          text: '',
          toolCalls: [{ ...readCall(`r${call}`, call), rawArguments: JSON.stringify(readCall(`r${call}`, call).arguments) }],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const executor = new LoopExecutor({
      provider,
      maxResultBytes: 1000,
      readRangeRequiredAboveBytes: 1000,
      bashTimeoutMs: 1000,
      temperature: null,
    });

    await executor.run(request({ progressHint: 'переходи к RecordFinding.' }), hooks());

    const withHint = seenUserMessages.filter((m) => m.includes('Пройдено'));
    ok(withHint.length > 0, 'напоминание не появилось вовсе');
    ok(withHint.every((m) => m.includes('переходи к RecordFinding.')), withHint.join('\n---\n'));
    ok(!withHint.some((m) => m.includes('инструментом Edit')), withHint.join('\n---\n'));
  });
});
