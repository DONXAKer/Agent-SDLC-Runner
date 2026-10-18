/**
 * Тело запроса OpenAI-совместимого провайдера.
 *
 * Планка — дефолтный `max_tokens`: без него ollama-теги с маленьким дефолтным
 * `num_predict` обрезают ответ на середине (класс отказа «лимит длины ответа» у
 * слабых моделей — gemma4-12b). Дефолт обязан уходить в body, а `ModelDef.params`
 * обязан его перекрывать — проверяем оба на поднятом stub-сервере, читающем тело.
 */

import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { OpenAiCompatProvider } from '../src/provider/OpenAiCompatProvider.ts';
import { ProviderEnvError, type ChatRequest } from '../src/provider/ChatProvider.ts';

let servers: Server[] = [];
const bodies: Record<string, unknown>[] = [];

after(() => {
  // keep-alive-соединения fetch не дают процессу теста выйти, пока сокеты живы:
  // рвём их вместе с закрытием слушателя.
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
});

async function startStub(): Promise<string> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

const request = (params?: Record<string, unknown>): ChatRequest => ({
  model: 'test',
  messages: [{ role: 'user', content: 'привет' }],
  tools: [],
  signal: new AbortController().signal,
  temperature: null,
  ...(params === undefined ? {} : { params }),
});

describe('тело запроса OpenAiCompatProvider', () => {
  it('без params уходит дефолтный max_tokens — ответ не обрезается дефолтом сервера', async () => {
    const baseUrl = await startStub();
    const provider = new OpenAiCompatProvider({ name: 'stub', baseUrl, apiKey: null, timeoutMs: 2000 });
    await provider.chat(request());
    strictEqual(bodies.length, 1);
    deepStrictEqual(bodies[0]!['max_tokens'], 8192);
  });

  it('params.max_tokens из конфига модели перекрывает дефолт', async () => {
    const baseUrl = await startStub();
    const provider = new OpenAiCompatProvider({ name: 'stub', baseUrl, apiKey: null, timeoutMs: 2000 });
    await provider.chat(request({ max_tokens: 512 }));
    strictEqual(bodies[bodies.length - 1]!['max_tokens'], 512);
  });
});

describe('таймаут одного запроса', () => {
  it('зависший сервер обрывается собственным AbortSignal и называется таймаутом, а не отменой', async () => {
    // Потолок (`limits.chatTimeoutMs`/`exploreRequestTimeoutMs`) — единственная защита от
    // локального сервера, держащего соединение без ответа: разбор 2026-10-05, запросы
    // разведки по ~300 с. Таймаут не повторяется (иначе висели бы 3×timeoutMs) и не
    // маскируется под отмену оператора — у них разная диагностика.
    const server = createServer(() => {
      // Ответа не будет никогда — клиент обязан оборвать ожидание сам.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const provider = new OpenAiCompatProvider({
      name: 'stub', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: null, timeoutMs: 200,
    });
    const started = Date.now();
    await rejects(
      () => provider.chat(request()),
      (e: unknown) => {
        ok(e instanceof ProviderEnvError, String(e));
        ok((e as Error).message.includes('таймаут запроса'), (e as Error).message);
        return true;
      },
    );
    ok(Date.now() - started < 5000, 'таймаут не сработал или запрос пошёл на повторы');
  });
});

describe('fallback: unsupported thinking', () => {
  it('повтор без reasoning-параметров при HTTP 400 "does not support thinking"', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        calls++;
        const body = JSON.parse(raw);
        if (calls === 1) {
          ok(body['reasoning_effort'] === 'low', 'первая попытка должна содержать reasoning_effort');
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: '"test-model" does not support thinking', type: 'invalid_request_error' } }));
        } else {
          strictEqual(body['reasoning_effort'], undefined);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const provider = new OpenAiCompatProvider({ name: 'stub', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: null, timeoutMs: 2000 });
    const result = await provider.chat(request({ reasoning_effort: 'low' }));
    strictEqual(result.text, 'ok');
    strictEqual(calls, 2);
  });
});
