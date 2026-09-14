/**
 * Вызовы, написанные текстом (`toolCallsFromText`), и причина завершения хода для них.
 *
 * Сторожится code-review 2026-09-14: форма Mistral `Имя[ARGS]{…}` исполняла цитату из
 * прозы, теряла второй и следующие вызовы подряд, а обрыв по длине ПОСЛЕ закрытого вызова
 * выбрасывал вызов целиком как «обрезан на середине вызова инструмента».
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import { OpenAiCompatProvider, mapFinish, textToolCalls, toolCallsFromText } from '../src/provider/OpenAiCompatProvider.ts';

const known = new Set(['Read', 'Write']);

describe('toolCallsFromText: форма Mistral', () => {
  it('цитата посреди прозы — не вызов', () => {
    const text = 'Вызов выглядит так: Read[ARGS]{"file_path": "a.ts"} — но сейчас я его не делаю.';
    deepStrictEqual(toolCallsFromText(text, known), []);
  });

  it('цитата в артефакте после заголовка — не вызов', () => {
    const text = '## Пример\n\nWrite[ARGS]{"file_path": "x.md", "content": "y"}';
    deepStrictEqual(toolCallsFromText(text, known), []);
  });

  it('два вызова подряд — оба, с уникальными id', () => {
    const calls = toolCallsFromText('Read[ARGS]{"file_path": "a.ts"}Read[ARGS]{"file_path": "b.ts"}', known);
    strictEqual(calls.length, 2);
    deepStrictEqual(
      calls.map((c) => c.arguments),
      [{ file_path: 'a.ts' }, { file_path: 'b.ts' }],
    );
    strictEqual(new Set(calls.map((c) => c.id)).size, 2);
  });

  it('последовательность с пробелами и повторным [TOOL_CALLS] — разбирается целиком', () => {
    const calls = toolCallsFromText(
      '  [TOOL_CALLS]Read[ARGS] {"file_path": "a.ts"}\n[TOOL_CALLS]Write[ARGS]{"file_path": "b.ts", "content": "c"}',
      known,
    );
    deepStrictEqual(
      calls.map((c) => c.name),
      ['Read', 'Write'],
    );
  });

  it('проза после последовательности не мешает и не читается', () => {
    const calls = toolCallsFromText('Read[ARGS]{"file_path": "a.ts"} а потом Write[ARGS]{"file_path": "b"}', known);
    deepStrictEqual(
      calls.map((c) => c.name),
      ['Read'],
    );
  });

  it('ведущий <think> и явный [TOOL_CALLS] после прозы — вызов; голая форма после прозы — нет', () => {
    deepStrictEqual(
      toolCallsFromText('<think>надо прочитать</think>\nRead[ARGS]{"file_path": "a.ts"}', known).map((c) => c.name),
      ['Read'],
    );
    deepStrictEqual(
      toolCallsFromText('Прочитаю файл.\n[TOOL_CALLS]Read[ARGS]{"file_path": "a.ts"}', known).map((c) => c.name),
      ['Read'],
    );
    deepStrictEqual(toolCallsFromText('Прочитаю файл.\nRead[ARGS]{"file_path": "a.ts"}', known), []);
  });

  it('id — 9 алфавитно-цифровых символов (шаблон Mistral в vLLM)', () => {
    for (const c of toolCallsFromText('Read[ARGS]{"file_path": "a.ts"}Read[ARGS]{"file_path": "b.ts"}', known)) {
      strictEqual(/^[A-Za-z0-9]{9}$/.test(c.id), true, c.id);
    }
  });

  it('последовательность, оборванная на незакрытом объекте, помечена truncated', () => {
    const r = textToolCalls('Read[ARGS]{"file_path": "a.ts"}Read[ARGS]{"file_pa', known);
    strictEqual(r.calls.length, 1);
    strictEqual(r.truncated, true);
    strictEqual(textToolCalls('Read[ARGS]{"file_path": "a.ts"} и текст', known).truncated, false);
  });

  it('JSON-форма — по-прежнему один вызов', () => {
    const calls = toolCallsFromText('Сейчас прочитаю: {"tool": "Read", "arguments": {"file_path": "a.ts"}}', known);
    strictEqual(calls.length, 1);
    strictEqual(calls[0]?.name, 'Read');
  });
});

describe('mapFinish', () => {
  it('length при нативных tool_calls — max_tokens (аргументы могли оборваться)', () => {
    strictEqual(mapFinish('length', true), 'max_tokens');
  });
  it('length при вызовах из текста — tool_use: объект закрыт по построению', () => {
    strictEqual(mapFinish('length', true, true), 'tool_use');
  });
  it('length без вызовов — max_tokens', () => {
    strictEqual(mapFinish('length', false, false), 'max_tokens');
  });
});

let servers: Server[] = [];
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  servers = [];
});

async function stub(body: unknown): Promise<string> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
}

describe('OpenAiCompatProvider: вызовы из текста', () => {
  const chat = (baseUrl: string) =>
    new OpenAiCompatProvider({ name: 'stub', baseUrl, apiKey: null, timeoutMs: 2000 }).chat({
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'Read', description: '', schema: {} },
        { name: 'Write', description: '', schema: {} },
      ],
      signal: new AbortController().signal,
      temperature: null,
    });

  it('все вызовы последовательности доезжают до хода, finish length → tool_use', async () => {
    const baseUrl = await stub({
      choices: [
        {
          message: { content: 'Read[ARGS]{"file_path": "a.ts"}Read[ARGS]{"file_path": "b.ts"} и ещё немного текс' },
          finish_reason: 'length',
        },
      ],
    });
    const turn = await chat(baseUrl);
    strictEqual(turn.toolCalls.length, 2);
    strictEqual(turn.finishReason, 'tool_use');
  });

  it('последовательность, оборванная по length на незакрытом вызове, — max_tokens', async () => {
    const baseUrl = await stub({
      choices: [{ message: { content: 'Read[ARGS]{"file_path": "a.ts"}Read[ARGS]{"file_pa' }, finish_reason: 'length' }],
    });
    strictEqual((await chat(baseUrl)).finishReason, 'max_tokens');
  });

  it('JSON-форма при length — max_tokens: объект после любой скобки может быть цитатой', async () => {
    const baseUrl = await stub({
      choices: [{ message: { content: 'Пример: {"tool": "Read", "arguments": {"file_path": "a.ts"}} и дал' }, finish_reason: 'length' }],
    });
    strictEqual((await chat(baseUrl)).finishReason, 'max_tokens');
  });

  it('нативный tool_calls при length — max_tokens, как раньше', async () => {
    const baseUrl = await stub({
      choices: [
        {
          message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"file_pa' } }] },
          finish_reason: 'length',
        },
      ],
    });
    const turn = await chat(baseUrl);
    strictEqual(turn.finishReason, 'max_tokens');
  });
});
