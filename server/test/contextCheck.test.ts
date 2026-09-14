/**
 * Диспетчер преполётной проверки окна контекста (`provider/contextCheck.ts`).
 *
 * Проверяется маршрутизация по провайдерам и переход «baseUrl из env ИЛИ из конфига»;
 * содержательные ветки окон покрыты в `lmstudioContext.test.ts` и
 * `ollamaContext.test.ts` — здесь они доезжают до диспетчера через те же http-стабы.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { contextProblemFor } from '../src/provider/contextCheck.ts';

let servers: Server[] = [];

after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
});

/** Стаб, отвечающий сразу в двух протоколах: `/api/v0/models` (LM Studio) и `/api/tags`+`/api/show` (Ollama). */
async function startStub(handler: (url: string) => unknown): Promise<string> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(handler(req.url ?? '')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('contextProblemFor', () => {
  it('провайдеры без управляемого окна (vllm/openrouter/polza/anthropic) — null без запросов', async () => {
    for (const p of ['vllm', 'openrouter', 'polza', 'anthropic']) {
      strictEqual(await contextProblemFor(p, 'm', 16384, undefined), null);
    }
  });

  it('lmstudio без заявленного contextWindow — null (сверять не с чем)', async () => {
    strictEqual(await contextProblemFor('lmstudio', 'm', undefined, 'http://127.0.0.1:1/v1'), null);
  });

  it('lmstudio: расхождение окна доезжает до сообщения оператору', async () => {
    const baseUrl = await startStub(() => ({ data: [{ id: 'm', state: 'loaded', loaded_context_length: 8192 }] }));
    const problem = await contextProblemFor('lmstudio', 'm', 16384, baseUrl);
    ok(problem !== null && problem.includes('8192') && problem.includes('16384'), String(problem));
  });

  it('lmstudio: окно совпадает — null', async () => {
    const baseUrl = await startStub(() => ({ data: [{ id: 'm', state: 'loaded', loaded_context_length: 16384 }] }));
    strictEqual(await contextProblemFor('lmstudio', 'm', 16384, baseUrl), null);
  });

  it('ollama проверяется и БЕЗ заявленного contextWindow: голый тег (4096) — проблема сама по себе', async () => {
    const baseUrl = await startStub((url) =>
      url === '/api/tags' ? { models: [{ name: 'm' }] } : { parameters: 'temperature 0.6\n' },
    );
    // Диспетчер читает process.env: заданная на машине переменная перекрасила бы кейс.
    const saved = process.env['OLLAMA_CONTEXT_LENGTH'];
    delete process.env['OLLAMA_CONTEXT_LENGTH'];
    try {
      const problem = await contextProblemFor('ollama', 'm', undefined, baseUrl);
      ok(problem !== null && problem.includes('4096'), String(problem));
    } finally {
      if (saved !== undefined) process.env['OLLAMA_CONTEXT_LENGTH'] = saved;
    }
  });

  it('ollama: /api не отвечает (404 — прокси только с /v1) — null, прогон не блокируется (code-review, 2026-09-14)', async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    strictEqual(await contextProblemFor('ollama', 'm', 16384, baseUrl), null);
  });

  it('ollama: сервер недоступен — null (обычный путь запроса назовёт это средовой ошибкой)', async () => {
    strictEqual(await contextProblemFor('ollama', 'm', 16384, 'http://127.0.0.1:1/v1'), null);
  });

  it('ollama: мёртвый тег — по-прежнему проблема', async () => {
    const baseUrl = await startStub((url) => (url === '/api/tags' ? { models: [{ name: 'другая' }] } : {}));
    const problem = await contextProblemFor('ollama', 'm', 16384, baseUrl);
    ok(problem !== null && problem.includes('не найдена'), String(problem));
  });

  it('ollama: тег с зашитым num_ctx — null', async () => {
    const baseUrl = await startStub((url) =>
      url === '/api/tags' ? { models: [{ name: 'm' }] } : { parameters: 'num_ctx 16384\n' },
    );
    strictEqual(await contextProblemFor('ollama', 'm', 16384, baseUrl), null);
  });

  it('пустой baseUrl — null (точную ошибку даст обычный путь запроса)', async () => {
    strictEqual(await contextProblemFor('ollama', 'm', 16384, ''), null);
  });
});
