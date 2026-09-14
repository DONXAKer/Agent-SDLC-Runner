/**
 * `LoopExecutor` — спасение артефакта из текста при обрыве ходом `finishReason:
 * 'max_tokens'`, не только на успешном завершении хода (`done`).
 *
 * Живой разбор серии v5 (`docs/model-runs.md`, 2026-09-14): класс «модель упёрлась в
 * лимит длины ответа» на этапе `explore` — 5 из 22 прогонов, во всех модель печатала
 * артефакт текстом вместо `Write`/`Edit` и обрывалась на середине. Спасение
 * (`req.salvageFromText`) уже существовало, но было гейтировано только веткой `done`
 * (`end_turn`/`other`) — на `max_tokens` не пробовалось вовсе, хотя `salvageBlocks`
 * (`run/salvage.ts`) устроен так, что полностью напечатанные блоки ДО обрыва спасает,
 * пропуская только недописанный хвост.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { LoopExecutor } from '../src/exec/LoopExecutor.ts';
import type { ChatProvider } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

function hooks(warnings: string[]): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (_call: NormalizedCall) => ({ allowed: true, updatedInput: null, by: 'policy' as const }),
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: (m: string) => warnings.push(m),
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
    finishGuard: null,
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 4,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

function exec(text: string, finishReason: 'max_tokens' | 'end_turn' | 'other'): LoopExecutor {
  const provider: ChatProvider = {
    name: 'stub',
    async chat() {
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 1, envBlocked: false },
        finishReason,
      };
    },
  } as unknown as ChatProvider;
  return new LoopExecutor({ provider, maxResultBytes: 1000, readRangeRequiredAboveBytes: 1000, bashTimeoutMs: 1000, temperature: null });
}

const ARTIFACT_TEXT = ['### Файл `report.md`', '```', '# Отчёт', 'содержимое готово', '```', ''].join('\n');

describe('LoopExecutor: спасение из текста при лимите длины ответа', () => {
  it('finishReason max_tokens, полностью напечатанный блок — спасено, этап зелёный', async () => {
    const warnings: string[] = [];
    let written: string | null = null;
    let guardCalls = 0;
    const req = request({
      finishGuard: () => {
        guardCalls++;
        return written === null ? 'артефакт не готов' : null;
      },
      salvageFromText: async (text: string) => {
        if (!text.includes('```')) return null;
        written = 'сохранено';
        return 'содержимое артефакта было напечатано в ответ, а не записано инструментом — рантайм записал его через гейт одобрения: report.md';
      },
    });

    const result = await exec(ARTIFACT_TEXT, 'max_tokens').run(req, hooks(warnings));

    strictEqual(result.ok, true, result.note);
    ok(result.note.includes('спас'), result.note);
    ok(guardCalls >= 2, 'страж обязан быть перепроверен после спасения');
    ok(warnings.some((w) => w.includes('report.md')), warnings.join('\n'));
  });

  it('finishReason max_tokens, спасать нечего (нет блока) — этап остаётся красным с прежним диагнозом', async () => {
    const warnings: string[] = [];
    const req = request({
      finishGuard: () => 'артефакт не готов',
      salvageFromText: async () => null,
    });

    const result = await exec('просто рассуждения без блока кода, а потом обрыв', 'max_tokens').run(req, hooks(warnings));

    strictEqual(result.ok, false);
    ok(result.note.includes('лимит длины ответа'), result.note);
  });

  it('finishReason max_tokens, спасение частично закрыло страж (остались другие плейсхолдеры) — по-прежнему красный, но запись состоялась', async () => {
    const warnings: string[] = [];
    let written = false;
    const req = request({
      finishGuard: () => (written ? 'артефакт не готов (осталось другое поле)' : 'артефакт не готов'),
      salvageFromText: async (text: string) => {
        if (!text.includes('```')) return null;
        written = true;
        return 'записано через гейт: report.md';
      },
    });

    const result = await exec(ARTIFACT_TEXT, 'max_tokens').run(req, hooks(warnings));

    strictEqual(result.ok, false);
    ok(result.note.includes('лимит длины ответа'), result.note);
    ok(warnings.some((w) => w.includes('report.md')), 'спасённый текст обязан быть записан, даже если страж не закрылся целиком');
  });

  it('без salvageFromText (null) поведение прежнее — красный с диагнозом, без обращения к спасению', async () => {
    const warnings: string[] = [];
    const req = request({ finishGuard: () => 'артефакт не готов', salvageFromText: null });

    const result = await exec(ARTIFACT_TEXT, 'max_tokens').run(req, hooks(warnings));

    strictEqual(result.ok, false);
    ok(result.note.includes('лимит длины ответа'), result.note);
  });
});
