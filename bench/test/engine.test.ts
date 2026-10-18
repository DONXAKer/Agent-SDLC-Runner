/**
 * Обвязка движка (`src/engine.ts`) — герметично: провайдер прогрева подменяется заглушкой,
 * ветки `reloadEngine` без внешних процессов (ollama, неподдержанный провайдер) — чистые.
 * Ветку LM Studio (`lms --version`/`lms load`) живьём не гоняем: GPU занят, а наличие
 * бинаря зависит от машины — её поведение проверяется через мок `PreflightDeps.reloadEngine`
 * в `preflight.test.ts`.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderEnvError, ProviderHttpError } from '../../server/src/provider/ChatProvider.ts';
import type { ChatRequest, ChatTurn } from '../../server/src/provider/ChatProvider.ts';
import { isEngineEnvFailure, reloadEngine, warmupEngine } from '../src/engine.ts';

describe('isEngineEnvFailure', () => {
  it('ProviderEnvError и подстроки падения движка — средовой сбой; прочие ошибки — нет', () => {
    strictEqual(isEngineEnvFailure(new ProviderEnvError('ответ не получен за таймаут')), true);
    strictEqual(isEngineEnvFailure(new Error('HTTP 400 terminated')), true);
    strictEqual(isEngineEnvFailure(new Error('fetch failed')), true);
    // Граница слова: «Unterminated string in JSON» — отказ разбора (про модель), не движок.
    strictEqual(isEngineEnvFailure(new Error('Unterminated string in JSON at position 812')), false);
    strictEqual(isEngineEnvFailure(new Error('HTTP 400 bad request')), false);
    strictEqual(isEngineEnvFailure('строковый бросок'), false);
  });

  it('HTTP-ответ провайдера по подстрокам сырого тела не переклассифицируется', () => {
    strictEqual(
      isEngineEnvFailure(new ProviderHttpError('lmstudio: HTTP 400 от http://x — {"error":{"message":"upstream fetch failed"}}', 400)),
      false,
    );
  });
});

describe('warmupEngine', () => {
  it('один дешёвый запрос: без инструментов, max_tokens перекрыт минимумом, params модели сохранены', async () => {
    let seen: ChatRequest | null = null;
    const provider = {
      name: 'stub',
      chat: async (req: ChatRequest): Promise<ChatTurn> => {
        seen = req;
        return {
          text: 'готов',
          toolCalls: [],
          finishReason: 'max_tokens',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1 },
        };
      },
    };
    await warmupEngine({ provider, model: 'm', params: { temperature: 0.2, max_tokens: 4096 } });
    strictEqual(seen!.model, 'm');
    deepStrictEqual(seen!.tools, []);
    // max_tokens прогрева перекрывает конфиг: меряется поднятие весов, а не генерация —
    // иначе «дешёвый запрос» стоил бы как полноценный кейс пробы.
    strictEqual(seen!.params?.max_tokens, 1);
    strictEqual(seen!.params?.temperature, 0.2);
    strictEqual(seen!.messages.length, 1);
  });

  it('неответ за потолок прогрева — ProviderEnvError (сбой движка), а не «запрос отменён»', async () => {
    const provider = {
      name: 'stub',
      chat: (req: ChatRequest): Promise<ChatTurn> =>
        new Promise((_, reject) => {
          req.signal.addEventListener('abort', () => reject(new Error('запрос к модели отменён')));
        }),
    };
    let caught: unknown = null;
    try {
      await warmupEngine({ provider, model: 'm', params: null, timeoutMs: 20 });
    } catch (e) {
      caught = e;
    }
    ok(caught instanceof ProviderEnvError, String(caught));
    strictEqual(isEngineEnvFailure(caught), true);
  });
});

describe('reloadEngine', () => {
  it('ollama — команда не нужна: движок поднимает модель сам на повторном запросе', async () => {
    const r = await reloadEngine({ provider: 'ollama', model: 'qwen3:8b' });
    strictEqual(r.kind, 'reloaded');
    ok(r.detail.includes('ollama'), r.detail);
  });

  it('LM Studio на удалённом адресе — lms не трогается: он управляет только этой машиной', async () => {
    const r = await reloadEngine({ provider: 'lmstudio', model: 'm', baseUrl: 'http://192.0.2.10:1234/v1' });
    strictEqual(r.kind, 'unsupported');
    ok(r.detail.includes('не локальный'), r.detail);
  });

  it('провайдер без осмысленной команды — честный unsupported, без молчаливого ретрая', async () => {
    const r = await reloadEngine({ provider: 'openrouter', model: 'm' });
    strictEqual(r.kind, 'unsupported');
    ok(r.detail.includes('не поддержана'), r.detail);
    ok(r.detail.includes('openrouter'), r.detail);
  });
});
