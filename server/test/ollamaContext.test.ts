/**
 * Проверка наличия модели и окна контекста Ollama (`provider/ollamaContext.ts`).
 *
 * Стенд поднимает настоящий `node:http`-сервер, отвечающий как `/api/tags` и
 * `/api/show` — тем же приёмом, что `lmstudioContext.test.ts` для `/api/v0/models`.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { checkOllamaContext, parseNumCtx } from '../src/provider/ollamaContext.ts';

let servers: Server[] = [];

after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
});

interface StubState {
  /** Теги, которые вернёт `/api/tags`. */
  tags: string[];
  /** Тело `/api/show` по имени модели; отсутствие ключа — HTTP 404, как у Ollama. */
  show?: Record<string, unknown>;
  /** Код ответа обоих эндпойнтов (умолчание 200). */
  status?: number;
}

async function startStub(state: StubState): Promise<string> {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (state.status !== undefined) {
      res.statusCode = state.status;
      res.end(JSON.stringify({ error: 'nope' }));
      return;
    }
    if (req.url === '/api/tags') {
      res.end(JSON.stringify({ models: state.tags.map((name) => ({ name, model: name })) }));
      return;
    }
    if (req.url === '/api/show') {
      if (state.show === undefined) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'model not found' }));
        return;
      }
      res.end(JSON.stringify(state.show));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  const address = server.address() as AddressInfo;
  // baseUrl — как в config/models.json, с хвостом /v1: проверяем, что модуль сам его срезает.
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('parseNumCtx', () => {
  it('читает num_ctx из строки параметров модфайла', () => {
    strictEqual(parseNumCtx('temperature                    0.6\nnum_ctx                        16384\n'), 16384);
  });
  it('num_ctx не зашит — null (вызывающий подставляет умолчание Ollama)', () => {
    strictEqual(parseNumCtx('temperature 0.6\n'), null);
    strictEqual(parseNumCtx(undefined), null);
  });
});

describe('checkOllamaContext', () => {
  it('тег есть, num_ctx покрывает заявленное окно — ok:true', async () => {
    const baseUrl = await startStub({
      tags: ['qwen3.5:4b-ctx16k'],
      show: { parameters: 'num_ctx 16384\n' },
    });
    const r = await checkOllamaContext(baseUrl, 'qwen3.5:4b-ctx16k', 16384);
    strictEqual(r.ok, true);
    strictEqual(r.effectiveContextLength, 16384);
  });

  it('тег есть, окно больше заявленного — ok:true (запас окна не ошибка)', async () => {
    const baseUrl = await startStub({
      tags: ['m'],
      show: { parameters: 'num_ctx 32768\n' },
    });
    const r = await checkOllamaContext(baseUrl, 'm', 16384);
    strictEqual(r.ok, true);
  });

  it('тег есть, num_ctx меньше заявленного — ok:false, называет оба числа и команду', async () => {
    const baseUrl = await startStub({
      tags: ['m'],
      show: { parameters: 'num_ctx 8192\n' },
    });
    const r = await checkOllamaContext(baseUrl, 'm', 16384);
    strictEqual(r.ok, false);
    strictEqual(r.effectiveContextLength, 8192);
    ok(r.message.includes('8192') && r.message.includes('16384'), r.message);
    ok(r.message.includes('ollama create'), r.message);
  });

  it('`/api/tags` отдаёт имя с суффиксом `:latest`, конфиг называет тег без него — совпадение находится (bench v5, 2026-09-14)', async () => {
    const baseUrl = await startStub({
      tags: ['ministral3-14b-ctx32k:latest'],
      show: { parameters: 'num_ctx 32768\n' },
    });
    const r = await checkOllamaContext(baseUrl, 'ministral3-14b-ctx32k', 32768);
    strictEqual(r.ok, true, r.message);
  });

  it('тег без num_ctx — эффективное окно 4096; без заявленного окна это красное (ловушка голого тега)', async () => {
    const baseUrl = await startStub({
      tags: ['qwen3.5:4b'],
      show: { parameters: 'temperature 0.6\n' },
    });
    const r = await checkOllamaContext(baseUrl, 'qwen3.5:4b');
    strictEqual(r.ok, false);
    strictEqual(r.effectiveContextLength, 4096);
    ok(r.message.includes('4096'), r.message);
    ok(r.message.includes('ctx16k'), r.message);
  });

  it('тег без num_ctx против заявленного окна — красное с пометкой про умолчание', async () => {
    const baseUrl = await startStub({
      tags: ['m'],
      show: {},
    });
    const r = await checkOllamaContext(baseUrl, 'm', 16384);
    strictEqual(r.ok, false);
    ok(r.message.includes('умолчание'), r.message);
  });

  it('тега нет в /api/tags — ok:false, называет класс «мёртвый тег»', async () => {
    const baseUrl = await startStub({ tags: ['другая-модель:latest'] });
    const r = await checkOllamaContext(baseUrl, 'qwen3-coder:30b-ctx16k', 16384);
    strictEqual(r.ok, false);
    ok(r.message.includes('не найдена'), r.message);
    ok(r.message.includes('ollama list'), r.message);
  });

  it('сервер отвечает НЕ 200 — ok:false, средовое сообщение', async () => {
    const baseUrl = await startStub({ tags: [], status: 500 });
    const r = await checkOllamaContext(baseUrl, 'm', 1);
    strictEqual(r.ok, false);
    ok(r.message.includes('500'), r.message);
  });

  it('сервер недоступен — ok:false, не бросает исключение', async () => {
    const r = await checkOllamaContext('http://127.0.0.1:1/v1', 'm', 1);
    strictEqual(r.ok, false);
    strictEqual(r.effectiveContextLength, null);
  });

  it('baseUrl с хвостом /v1 корректно превращается в /api/tags', async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/api/tags' ? { models: [{ name: 'm' }] } : { parameters: 'num_ctx 16384' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    servers.push(server);
    const address = server.address() as AddressInfo;
    await checkOllamaContext(`http://127.0.0.1:${address.port}/v1`, 'm', 16384);
    strictEqual(paths[0], '/api/tags');
    strictEqual(paths[1], '/api/show');
  });
});
