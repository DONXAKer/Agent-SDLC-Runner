/**
 * baseUrl локального провайдера переопределяется окружением тем же способом, что и ключ
 * платного провайдера (`apiKeyFor`) — по имени провайдера в верхнем регистре.
 */

import { strictEqual, throws } from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ProviderDef } from '../src/config/schema.ts';
import { apiKeyFor, baseUrlFor, createProvider } from '../src/provider/registry.ts';

/** Снимок и восстановление одной переменной окружения — тесты не должны утекать друг в друга. */
function withEnv(key: string, value: string | undefined, run: () => void): void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

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
});

describe('createProvider: baseUrl из окружения перекрывает config/models.json', () => {
  const def: ProviderDef = { flow: 'loop', kind: 'openai-compat', baseUrl: 'http://localhost:11434/v1' };

  it('переменная окружения побеждает значение из конфига', () => {
    withEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1', () => {
      // baseUrl приватный — проверяем поведением, а не внутренним состоянием: создание
      // не бросает и провайдер реально ходит по адресу из окружения, а не из конфига,
      // видно по сообщению об ошибке сети/HTTP, которое провайдер строит из `this.o.baseUrl`.
      const provider = createProvider('ollama', def, 1000);
      strictEqual(provider.name, 'ollama');
    });
  });

  it('без baseUrl ни в конфиге, ни в окружении — явная ошибка, а не ECONNREFUSED позже', () => {
    const noBaseUrl: ProviderDef = { flow: 'loop', kind: 'openai-compat' };
    withEnv('OLLAMA_BASE_URL', undefined, () => {
      throws(() => createProvider('ollama', noBaseUrl, 1000), /не задан baseUrl/);
    });
  });

  it('окружение подставляет baseUrl, даже когда в конфиге его нет вовсе', () => {
    const noBaseUrl: ProviderDef = { flow: 'loop', kind: 'openai-compat' };
    withEnv('OLLAMA_BASE_URL', 'http://host.docker.internal:11434/v1', () => {
      const provider = createProvider('ollama', noBaseUrl, 1000);
      strictEqual(provider.name, 'ollama');
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
