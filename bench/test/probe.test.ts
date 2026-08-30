/**
 * Преполётная проба tool-calling — герметично, на провайдере-заглушке.
 *
 * Сторожится: модель, отвечающая вызовами, проходит; модель, печатающая текст вместо
 * вызова, краснеет с текстом причины; ошибка транспорта — красный кейс, а не исключение
 * («сервер лёг» — измеренный факт среды, а не несостоявшееся измерение).
 */

import { ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ChatProvider, ChatRequest } from '../../server/src/provider/ChatProvider.ts';
import { formatProbe, probeModel } from '../src/probe.ts';

type Reply = { text: string; toolCalls?: { name: string; arguments: Record<string, unknown> }[] };

/** Заглушка: отвечает по имени первого доступного инструмента в запросе. */
function scripted(replyFor: (req: ChatRequest) => Reply): ChatProvider {
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      const r = replyFor(req);
      return {
        text: r.text,
        toolCalls: (r.toolCalls ?? []).map((c, i) => ({
          id: `c${i}`,
          name: c.name,
          arguments: c.arguments,
          rawArguments: JSON.stringify(c.arguments),
        })),
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: null,
          durationMs: 1,
          envBlocked: false,
        },
        finishReason: (r.toolCalls ?? []).length > 0 ? ('tool_use' as const) : ('end_turn' as const),
      };
    },
  } as unknown as ChatProvider;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('преполётная проба', () => {
  it('модель, зовущая инструменты по делу, проходит все три кейса', async () => {
    const provider = scripted((req) => {
      const names = req.tools.map((t) => t.name);
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const afterTool = req.messages.some((m) => m.role === 'tool');
      if (names.includes('Write') && user.includes('hello.md')) {
        return { text: '', toolCalls: [{ name: 'Write', arguments: { file_path: 'notes/hello.md', content: 'привет' } }] };
      }
      if (user.includes('Замени плейсхолдер')) {
        return {
          text: '',
          toolCalls: [
            {
              name: 'Edit',
              arguments: {
                file_path: '.sdlc/probe/intent.md',
                old_string: '- **Итог:** ‹что должно стать правдой›',
                new_string: '- **Итог:** проба пройдена',
              },
            },
          ],
        };
      }
      // Кейс «чтение → запись»: сперва Read, после результата — Edit.
      if (!afterTool) return { text: '', toolCalls: [{ name: 'Read', arguments: { file_path: 'config/title.txt' } }] };
      return {
        text: '',
        toolCalls: [
          { name: 'Edit', arguments: { file_path: 'config/title.txt', old_string: 'черновик', new_string: 'готово' } },
        ],
      };
    });

    const report = await probeModel({ provider, model: 'm', signal: signal() });
    strictEqual(report.passed, true, JSON.stringify(report.cases));
    strictEqual(report.cases.length, 3);
    ok(formatProbe(report).includes('✅'));
  });

  it('модель, печатающая текст вместо вызова, краснеет с текстом причины', async () => {
    const provider = scripted(() => ({ text: 'Вот содержимое файла:\n# привет' }));
    const report = await probeModel({ provider, model: 'm', signal: signal() });
    strictEqual(report.passed, false);
    ok(report.cases.every((c) => !c.ok));
    ok(report.cases[0]!.detail.includes('вызова нет'), report.cases[0]!.detail);
    ok(formatProbe(report).includes('НЕ пройдена'));
  });

  it('ошибка транспорта — красный кейс с причиной, а не исключение', async () => {
    const provider = {
      name: 'stub',
      async chat() {
        throw new Error('ECONNREFUSED 127.0.0.1:11434');
      },
    } as unknown as ChatProvider;
    const report = await probeModel({ provider, model: 'm', signal: signal() });
    strictEqual(report.passed, false);
    ok(report.cases[0]!.detail.includes('ECONNREFUSED'));
  });

  it('модель, застрявшая на чтении, валит третий кейс', async () => {
    const provider = scripted((req) => {
      const names = req.tools.map((t) => t.name);
      if (!names.includes('Read')) return { text: 'не знаю' };
      return { text: '', toolCalls: [{ name: 'Read', arguments: { file_path: 'config/title.txt' } }] };
    });
    const report = await probeModel({ provider, model: 'm', signal: signal() });
    const readWrite = report.cases.find((c) => c.name === 'чтение → запись');
    strictEqual(readWrite?.ok, false);
    ok(readWrite!.detail.includes('снова Read'), readWrite!.detail);
  });
});
