/**
 * Классификация отказа: среда или модель.
 *
 * Замер 2026-09-04 (14 витков `polza:ministral-14b` по семействам фикстур) показал цену
 * смешения: 503 полза-апстрима приходил посреди этапа, уходил в заметку обычной ошибкой,
 * и bench возвращал 1 — «модель не прошла» — на пяти прогонах из четырнадцати. Тип
 * ошибки и есть тот признак, по которому это различимо; проверяется он здесь, а решение
 * о коде возврата — в `bench/test/report.test.ts`.
 */

import { ok, rejects, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { describe, it } from 'node:test';

import { ProviderEnvError, type ChatProvider } from '../src/provider/ChatProvider.ts';
import { OpenAiCompatProvider } from '../src/provider/OpenAiCompatProvider.ts';

/** Сервер, отвечающий одним и тем же статусом. Повторы провайдера тоже придут сюда. */
async function stub(status: number, body: string): Promise<{ url: string; server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('сервер не поднялся');
  return { url: `http://127.0.0.1:${address.port}/v1`, server, hits: () => hits };
}

/** Пауза повтора укорочена: тест обязан дойти до ИСЧЕРПАНИЯ повторов, а не ждать их. */
function provider(url: string, timeoutMs = 2000): ChatProvider {
  return new OpenAiCompatProvider({ name: 'ollama', baseUrl: url, apiKey: null, timeoutMs, retryDelayMs: 5 });
}

function chatWith(url: string, timeoutMs = 2000): Promise<unknown> {
  return provider(url, timeoutMs).chat({
    model: 'test',
    messages: [{ role: 'user', content: 'привет' }],
    tools: [],
    signal: AbortSignal.timeout(60_000),
    temperature: null,
  });
}

describe('OpenAiCompatProvider: среда против модели', () => {
  it('503 после всех повторов — ProviderEnvError, а не обычная ошибка', async () => {
    const s = await stub(503, JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }));
    try {
      await rejects(
        () => chatWith(s.url),
        (e: Error) => {
          ok(e instanceof ProviderEnvError, `ожидался ProviderEnvError, пришёл ${e.name}`);
          ok(e.message.includes('HTTP 503'), 'причина названа дословно');
          return true;
        },
      );
      // Повторы провайдера отработали до классификации: env-ошибкой становится только
      // то, что не починилось само.
      ok(s.hits() > 1, `ожидались повторы, попыток: ${s.hits()}`);
    } finally {
      s.server.close();
    }
  });

  it('429 — тот же класс: потолок агрегатора не свойство модели', async () => {
    const s = await stub(429, '{}');
    try {
      await rejects(
        () => chatWith(s.url),
        (e: Error) => e instanceof ProviderEnvError,
      );
    } finally {
      s.server.close();
    }
  });

  it('402 «нет денег» — отказ среды: модель не отвечала ни разу', async () => {
    // Пойман живьём 2026-09-05: на платном агрегаторе кончился баланс посреди серии, и
    // восемь витков из четырнадцати выглядели провалом измеряемой настройки.
    const s = await stub(402, JSON.stringify({ error: { code: 'INSUFFICIENT_BALANCE' } }));
    try {
      await rejects(
        () => chatWith(s.url),
        (e: Error) => {
          ok(e instanceof ProviderEnvError, `ожидался ProviderEnvError, пришёл ${e.name}`);
          return true;
        },
      );
      strictEqual(s.hits(), 1, 'нет денег повтором не чинится — повторять незачем');
    } finally {
      s.server.close();
    }
  });

  it('401 «нет ключа» — тоже среда: это состояние счёта, а не запроса', async () => {
    const s = await stub(401, '{}');
    try {
      await rejects(() => chatWith(s.url), (e: Error) => e instanceof ProviderEnvError);
    } finally {
      s.server.close();
    }
  });

  it('400 — обычная ошибка: это про запрос, повтором не чинится', async () => {
    const s = await stub(400, JSON.stringify({ error: { message: 'схема инструмента не принята' } }));
    try {
      await rejects(
        () => chatWith(s.url),
        (e: Error) => {
          ok(!(e instanceof ProviderEnvError), '4xx не должен читаться как отказ среды');
          ok(e.message.includes('HTTP 400'));
          return true;
        },
      );
      strictEqual(s.hits(), 1, '4xx не повторяется');
    } finally {
      s.server.close();
    }
  });

  it('адрес, где никто не слушает, — тоже отказ среды: до модели запрос не дошёл', async () => {
    await rejects(
      () =>
        provider('http://127.0.0.1:1/v1').chat({
          model: 'test',
          messages: [{ role: 'user', content: 'привет' }],
          tools: [],
          signal: AbortSignal.timeout(60_000),
          temperature: null,
        }),
      (e: Error) => e instanceof ProviderEnvError,
    );
  });
});
