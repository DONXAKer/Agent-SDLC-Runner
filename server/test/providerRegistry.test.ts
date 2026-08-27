/**
 * baseUrl локального провайдера переопределяется окружением тем же способом, что и ключ
 * платного провайдера (`apiKeyFor`) — по имени провайдера в верхнем регистре.
 */

import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';

import type { ProviderDef } from '../src/config/schema.ts';
import { apiKeyFor, baseUrlFor, createProvider } from '../src/provider/registry.ts';
import { withEnv, withEnvAsync } from './testUtils.ts';

describe('baseUrlFor', () => {
  it('читает <ИМЯ>_BASE_URL по имени провайдера в верхнем регистре', () => {
    withEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1', () => {
      strictEqual(baseUrlFor('ollama'), 'http://host.docker.internal:11434/v1');
    });
  });

  it('не заданная и пустая переменная — обе «не задано»', () => {
    withEnv('OLLAMA_BASE_URL', undefined, () => {
      strictEqual(baseUrlFor('ollama'), null);
    });
    withEnv('OLLAMA_BASE_URL', '', () => {
      strictEqual(baseUrlFor('ollama'), null);
    });
  });

  it('хвостовые/начальные пробелы обрезаются — иначе они уходят в путь запроса', () => {
    withEnv('OLLAMA_BASE_URL', '  http://host.docker.internal:11434/v1  ', () => {
      strictEqual(baseUrlFor('ollama'), 'http://host.docker.internal:11434/v1');
    });
    withEnv('OLLAMA_BASE_URL', '   ', () => {
      strictEqual(baseUrlFor('ollama'), null);
    });
  });
});

describe('createProvider: baseUrl из окружения перекрывает config/models.json', () => {
  const def: ProviderDef = { flow: 'loop', kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1' };

  it('без baseUrl ни в конфиге, ни в окружении — явная ошибка, а не ECONNREFUSED позже', () => {
    const noBaseUrl: ProviderDef = { flow: 'loop', kind: 'openai-compat' };
    withEnv('OLLAMA_BASE_URL', undefined, () => {
      throws(() => createProvider('ollama', noBaseUrl, 1000), /не задан baseUrl/);
    });
  });

  it('пустая строка baseUrl в конфиге — тоже явная ошибка, а не пустой fetch', () => {
    const emptyBaseUrl: ProviderDef = { flow: 'loop', kind: 'openai-compat', baseUrl: '' };
    withEnv('OLLAMA_BASE_URL', undefined, () => {
      throws(() => createProvider('ollama', emptyBaseUrl, 1000), /не задан baseUrl/);
    });
  });

  /**
   * Реальный сетевой поход, а не проверка поля `.name`: `baseUrl` в `OpenAiCompatProvider`
   * приватный, геттера нет, и единственный честный способ убедиться, что переопределение
   * из окружения действительно попало в запрос, — поднять сервер и посмотреть, дошёл ли
   * он до него. `def.baseUrl` в обоих тестах указывает на заведомо непрослушиваемый порт:
   * если бы `createProvider` проигнорировал env и использовал его, запрос бы не дошёл.
   */
  it('запрос реально уходит на адрес из окружения, а не из конфига', async () => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('сервер не поднялся');
    const stubUrl = `http://127.0.0.1:${address.port}/v1`;

    try {
      await withEnvAsync('OLLAMA_BASE_URL', stubUrl, async () => {
        const wrongDef: ProviderDef = {
          flow: 'loop',
          kind: 'openai-compat',
          baseUrl: 'http://127.0.0.1:1/v1', // порт 1 — привилегированный, ничего не слушает
        };
        const provider = createProvider('ollama', wrongDef, 2000);
        const turn = await provider.chat({
          model: 'test',
          messages: [{ role: 'user', content: 'привет' }],
          tools: [],
          signal: new AbortController().signal,
          temperature: null,
        });
        strictEqual(turn.text, 'ok');
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    deepStrictEqual(requests, ['/v1/chat/completions']);
  });

  it('окружение подставляет baseUrl, даже когда в конфиге его нет вовсе', () => {
    const noBaseUrl: ProviderDef = { flow: 'loop', kind: 'openai-compat' };
    withEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1', () => {
      // createProvider не бросает — единственное, что можно проверить без сетевого
      // похода (см. тест выше на реальный passthrough); throws()-тест на отсутствие
      // baseUrl рядом доказывает, что этот путь вообще что-то проверяет.
      createProvider('ollama', noBaseUrl, 1000);
    });
  });
});

describe('apiKeyFor и baseUrlFor — независимые переменные одного провайдера', () => {
  before(() => {
    process.env['LMSTUDIO_API_KEY'] = '';
    process.env['LMSTUDIO_BASE_URL'] = '';
  });
  after(() => {
    delete process.env['LMSTUDIO_API_KEY'];
    delete process.env['LMSTUDIO_BASE_URL'];
  });

  it('пустые обе — обе null, ключ и адрес не путаются суффиксом', () => {
    strictEqual(apiKeyFor('lmstudio'), null);
    strictEqual(baseUrlFor('lmstudio'), null);
  });
});
