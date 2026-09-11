/**
 * Проверка окна контекста LM Studio (`provider/lmstudioContext.ts`).
 *
 * Стенд поднимает настоящий `node:http`-сервер, отвечающий как `/api/v0/models` — тем же
 * приёмом, что `openAiCompatBody.test.ts` для `/v1/chat/completions`, а не мок `fetch`.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { checkLmStudioContext } from '../src/provider/lmstudioContext.ts';

let servers: Server[] = [];

after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
});

/** `respond` строит тело `/api/v0/models`; `status` — код ответа (умолчание 200). */
async function startStub(respond: () => unknown, status = 200): Promise<string> {
  const server = createServer((req, res) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(respond()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address() as AddressInfo;
  // baseUrl — как в config/models.json, с хвостом /v1: проверяем, что модуль сам его срезает.
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('checkLmStudioContext', () => {
  it('окно совпадает — ok:true', async () => {
    const baseUrl = await startStub(() => ({
      data: [{ id: 'ministral-3-14b-reasoning-2512', state: 'loaded', loaded_context_length: 24576 }],
    }));
    const r = await checkLmStudioContext(baseUrl, 'ministral-3-14b-reasoning-2512', 24576);
    strictEqual(r.ok, true);
    strictEqual(r.state, 'loaded');
    strictEqual(r.loadedContextLength, 24576);
  });

  it('окно не совпадает — ok:false, сообщение называет оба числа и команду перезагрузки', async () => {
    const baseUrl = await startStub(() => ({
      data: [{ id: 'gpt-oss-20b', state: 'loaded', loaded_context_length: 16384 }],
    }));
    const r = await checkLmStudioContext(baseUrl, 'gpt-oss-20b', 32768);
    strictEqual(r.ok, false);
    strictEqual(r.loadedContextLength, 16384);
    ok(r.message.includes('16384') && r.message.includes('32768'), r.message);
    ok(r.message.includes('lms load'), r.message);
  });

  it('модель не загружена (state: not-loaded) — ok:false, команда загрузки с нужным окном', async () => {
    const baseUrl = await startStub(() => ({
      data: [{ id: 'zai-org/glm-4.7-flash', state: 'not-loaded' }],
    }));
    const r = await checkLmStudioContext(baseUrl, 'zai-org/glm-4.7-flash', 16384);
    strictEqual(r.ok, false);
    strictEqual(r.state, 'not-loaded');
    strictEqual(r.loadedContextLength, null);
    ok(r.message.includes('lms load zai-org/glm-4.7-flash -c 16384'), r.message);
  });

  it('модели нет в ответе вовсе (опечатка id) — ok:false, называет причину', async () => {
    const baseUrl = await startStub(() => ({
      data: [{ id: 'другая-модель', state: 'loaded', loaded_context_length: 8192 }],
    }));
    const r = await checkLmStudioContext(baseUrl, 'ministral-3-14b-reasoning-2512', 24576);
    strictEqual(r.ok, false);
    strictEqual(r.state, null);
    ok(r.message.includes('не найдена'), r.message);
  });

  it('сервер отвечает НЕ 200 — ok:false, средовое сообщение', async () => {
    const baseUrl = await startStub(() => ({ error: 'nope' }), 500);
    const r = await checkLmStudioContext(baseUrl, 'x', 1);
    strictEqual(r.ok, false);
    ok(r.message.includes('500'), r.message);
  });

  it('сервер недоступен (соединение закрыто) — ok:false, не бросает исключение', async () => {
    const r = await checkLmStudioContext('http://127.0.0.1:1/v1', 'x', 1);
    strictEqual(r.ok, false);
    strictEqual(r.state, null);
    strictEqual(r.loadedContextLength, null);
  });

  it('baseUrl с хвостом /v1 корректно превращается в /api/v0/models', async () => {
    let hitPath = '';
    const server = createServer((req, res) => {
      hitPath = req.url ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'm', state: 'loaded', loaded_context_length: 1 }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const address = server.address() as AddressInfo;
    await checkLmStudioContext(`http://127.0.0.1:${address.port}/v1`, 'm', 1);
    strictEqual(hitPath, '/api/v0/models');
  });
});
