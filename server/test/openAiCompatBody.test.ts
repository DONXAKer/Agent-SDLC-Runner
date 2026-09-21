/**
 * Тело запроса OpenAI-совместимого провайдера.
 *
 * Планка — дефолтный `max_tokens`: без него ollama-теги с маленьким дефолтным
 * `num_predict` обрезают ответ на середине (класс отказа «лимит длины ответа» у
 * слабых моделей — gemma4-12b). Дефолт обязан уходить в body, а `ModelDef.params`
 * обязан его перекрывать — проверяем оба на поднятом stub-сервере, читающем тело.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { OpenAiCompatProvider } from '../src/provider/OpenAiCompatProvider.ts';
import type { ChatRequest } from '../src/provider/ChatProvider.ts';

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

  it('response_format (constrainedChoice) доезжает до тела без особого случая — тот же путь, что max_tokens', async () => {
    const baseUrl = await startStub();
    const provider = new OpenAiCompatProvider({ name: 'stub', baseUrl, apiKey: null, timeoutMs: 2000 });
    const format = { type: 'json_schema', json_schema: { name: 'field_choice', strict: true, schema: { type: 'string', enum: ['✅', '❌'] } } };
    await provider.chat(request({ response_format: format }));
    deepStrictEqual(bodies[bodies.length - 1]!['response_format'], format);
  });
});
