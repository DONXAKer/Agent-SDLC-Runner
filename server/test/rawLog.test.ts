/**
 * Сырой дамп запросов к модели (`provider/rawLog.ts`) — корпус «вход → выход».
 *
 * Проверяется ровно то, ради чего он заведён: в файле лежит ТО ЖЕ тело, что ушло в модель
 * (а не пересказ), и ТОТ ЖЕ ответ строкой. Проверка идёт через настоящий сетевой поход к
 * заглушке, а не мимо провайдера: дамп стоит внутри `chat()`, и тест, зовущий
 * `dumpExchange` напрямую, доказал бы только то, что функция пишет файл.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ProviderDef } from '../src/config/schema.ts';
import { createProvider } from '../src/provider/registry.ts';
import { resetRawLogForTests } from '../src/provider/rawLog.ts';
import { withEnvAsync } from './testUtils.ts';

const ANSWER = { choices: [{ message: { content: 'ответ' }, finish_reason: 'stop' }] };

/** Заглушка сервера моделей: отдаёт один и тот же ответ и запоминает полученные тела. */
async function withStub(run: (baseUrl: string, bodies: string[]) => Promise<void>): Promise<void> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(ANSWER));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('сервер не поднялся');
  try {
    await run(`http://127.0.0.1:${address.port}/v1`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function ask(baseUrl: string, trace?: Parameters<typeof createProvider>[3]): Promise<unknown> {
  const def: ProviderDef = { flow: 'loop', kind: 'openai-compat', baseUrl };
  const provider = createProvider('ollama', def, 5000, trace);
  return provider.chat({
    model: 'test-model',
    messages: [
      { role: 'system', content: 'правила этапа' },
      { role: 'user', content: 'задача' },
    ],
    tools: [{ name: 'Read', description: 'читает файл', schema: { type: 'object' } }],
    signal: new AbortController().signal,
    temperature: null,
  });
}

describe('сырой дамп запросов к модели', () => {
  it('пишет пару «запрос → ответ» побайтово тем, что ушло в модель', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-rawlog-'));
    try {
      await withStub(async (baseUrl, bodies) => {
        await withEnvAsync('SDLC_RAW_LOG_DIR', dir, async () => {
          resetRawLogForTests();
          await ask(baseUrl, { slug: 'витокА', stage: 'chunk', mode: 'step', attempt: 2 });
        });

        // Каталог по слагу: трассы разных прогонов не смешиваются.
        const runDir = join(dir, 'витокА');
        const files = readdirSync(runDir);
        strictEqual(files.length, 1);
        strictEqual(files[0], '00001-chunk-step.json');

        const dump = JSON.parse(readFileSync(join(runDir, files[0]!), 'utf8')) as Record<string, unknown>;
        strictEqual(dump['slug'], 'витокА');
        strictEqual(dump['stage'], 'chunk');
        strictEqual(dump['mode'], 'step');
        strictEqual(dump['attempt'], 2);
        strictEqual(dump['provider'], 'ollama');
        strictEqual(dump['model'], 'test-model');
        strictEqual(dump['status'], 200);

        // Главное свойство: записанный вход совпадает с тем, что сервер реально получил.
        // Не «похож», а совпадает — иначе обучать пришлось бы на пересказе.
        deepStrictEqual(dump['request'], JSON.parse(bodies[0]!));
        // Ответ — строкой: разобранный объект потерял бы то, на чём ломаются слабые серверы.
        strictEqual(dump['response'], JSON.stringify(ANSWER));

        // Рядом с трассами не появляется ничего ещё: сводный указатель был второй точкой
        // отказа (на сетевой шаре `appendFileSync` даёт EBADF) и снят.
        deepStrictEqual(readdirSync(dir), ['витокА']);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('без SDLC_RAW_LOG_DIR не пишет ничего — дамп не включается сам собой', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-rawlog-off-'));
    try {
      await withStub(async (baseUrl) => {
        await withEnvAsync('SDLC_RAW_LOG_DIR', undefined, async () => {
          resetRawLogForTests();
          await ask(baseUrl, { slug: 'витокБ', stage: 'plan', mode: 'loop' });
        });
      });
      deepStrictEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('без метки маршрута не пишет ничего даже при заданной переменной', async () => {
    // Запрос без метки в корпусе бесполезен — разложить его по мишеням нечем, а место в
    // каталоге он занимает такое же.
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-rawlog-notrace-'));
    try {
      await withStub(async (baseUrl) => {
        await withEnvAsync('SDLC_RAW_LOG_DIR', dir, async () => {
          resetRawLogForTests();
          await ask(baseUrl);
        });
      });
      deepStrictEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('нумерация сквозная по процессу — порядок запросов витка восстанавливается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdlc-rawlog-seq-'));
    try {
      await withStub(async (baseUrl) => {
        await withEnvAsync('SDLC_RAW_LOG_DIR', dir, async () => {
          resetRawLogForTests();
          await ask(baseUrl, { slug: 'витокВ', stage: 'intent', mode: 'formFill' });
          await ask(baseUrl, { slug: 'витокВ', stage: 'chunk', mode: 'loop' });
        });
      });
      deepStrictEqual(readdirSync(join(dir, 'витокВ')).sort(), [
        '00001-intent-formFill.json',
        '00002-chunk-loop.json',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('нерабочий каталог гасит дамп не сразу: три отказа подряд, каждый назван', async () => {
    // Оба края измерены живым прогоном. Оплаченный прогон не должен погибнуть из-за
    // опечатки в пути, молчать тоже нельзя — но и выключаться с первого чиха нельзя:
    // один EBADF сетевой шары погасил дамп на весь виток, оставив от него одну пару.
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      warnings.push(w.message);
    };
    process.on('warning', onWarning);
    try {
      await withStub(async (baseUrl) => {
        // Файл вместо каталога: mkdirSync по такому пути бросает ENOTDIR/EEXIST.
        const busy = join(tmpdir(), `sdlc-rawlog-file-${String(Date.now())}`);
        rmSync(busy, { force: true });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(busy, 'занято', 'utf8');
        try {
          await withEnvAsync('SDLC_RAW_LOG_DIR', join(busy, 'внутрь'), async () => {
            resetRawLogForTests();
            for (let i = 0; i < 3; i++) {
              const turn = (await ask(baseUrl, { slug: 'витокГ', stage: 'ask', mode: 'loop' })) as {
                text: string;
              };
              // Ход прошёл штатно — отказ дампа на него не влияет ни разу.
              strictEqual(turn.text, 'ответ');
            }
            strictEqual(existsSync(join(busy, 'внутрь')), false);
          });
        } finally {
          rmSync(busy, { force: true });
        }
      });
      // Предупреждение доходит асинхронно — даём событию отработать.
      await new Promise<void>((resolve) => setImmediate(resolve));
      strictEqual(
        warnings.filter((m) => m.includes('пара не записана')).length,
        2,
        `первые два отказа названы поимённо: ${JSON.stringify(warnings)}`,
      );
      strictEqual(
        warnings.some((m) => m.includes('выключен после 3 отказов подряд')),
        true,
        `третий отказ выключает дамп: ${JSON.stringify(warnings)}`,
      );
    } finally {
      process.off('warning', onWarning);
      resetRawLogForTests();
    }
  });
});
