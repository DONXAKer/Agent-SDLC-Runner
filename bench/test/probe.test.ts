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
import { PREFLIGHT_CASES, formatProbe, probeModel } from '../../server/src/probe.ts';

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

    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000 });
    strictEqual(report.passed, true, JSON.stringify(report.cases));
    strictEqual(report.cases.length, 3);
    ok(formatProbe(report).includes('✅'));
  });

  it('модель, печатающая текст вместо вызова, краснеет с текстом причины', async () => {
    const provider = scripted(() => ({ text: 'Вот содержимое файла:\n# привет' }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000 });
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
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000 });
    strictEqual(report.passed, false);
    ok(report.cases[0]!.detail.includes('ECONNREFUSED'));
    // Среда, не модель: отчёт обязан сказать «не измерено», а не «модель не тянет».
    strictEqual(report.envBlocked, true);
    ok(formatProbe(report).includes('НЕ ИЗМЕРЕНА'), formatProbe(report));
  });

  it('модель, застрявшая на чтении, валит третий кейс', async () => {
    const provider = scripted((req) => {
      const names = req.tools.map((t) => t.name);
      if (!names.includes('Read')) return { text: 'не знаю' };
      return { text: '', toolCalls: [{ name: 'Read', arguments: { file_path: 'config/title.txt' } }] };
    });
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000 });
    const readWrite = report.cases.find((c) => c.name === 'чтение → запись');
    strictEqual(readWrite?.ok, false);
    ok(readWrite!.detail.includes('снова Read'), readWrite!.detail);
  });

  it('без явного набора кейсов гоняются базовые три — обещание «секунды» не нарушено', async () => {
    const provider = scripted(() => ({ text: 'текст без вызова' }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000 });
    strictEqual(report.cases.length, 3);
  });
});

/**
 * Преполётные кейсы (PREFLIGHT_CASES): точность многострочного Edit, честность путей,
 * длинная запись без усечения. Та же заглушка, разбор по тексту user-сообщения.
 */
describe('преполётные кейсы пробы', () => {
  it('точный многострочный Edit — кейс зелёный', async () => {
    const provider = scripted((req) => {
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      if (user.includes('template.ts')) {
        return {
          text: '',
          toolCalls: [
            { name: 'Edit', arguments: { file_path: 'src/template.ts', old_string: 'Срок: ${days} дн.`;', new_string: 'Дедлайн: ${days} дн.`;' } },
          ],
        };
      }
      return { text: '' };
    });
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(3, 4) });
    strictEqual(report.cases.length, 1);
    strictEqual(report.cases[0]!.ok, true, report.cases[0]!.detail);
  });

  it('old_string, набранный по памяти (не подстрока файла), — красный с цитатой', async () => {
    const provider = scripted(() => ({
      text: '',
      // Классический промах «по памяти»: бэктик template-литерала потерян — такая
      // строка в файле не встречается, и Edit промахнулся бы.
      toolCalls: [
        { name: 'Edit', arguments: { file_path: 'src/template.ts', old_string: 'Срок: ${days} дн.;', new_string: 'Дедлайн: ${days} дн.`;' } },
      ],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(3, 4) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('побайтово'), report.cases[0]!.detail);
  });

  it('вымышленный путь — красный, путь назван', async () => {
    const provider = scripted(() => ({
      text: '',
      toolCalls: [
        { name: 'Edit', arguments: { file_path: 'src/loyalty.ts', old_string: 'const LIMIT = 100', new_string: 'const LIMIT = 200' } },
      ],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('src/loyalty.ts'), report.cases[0]!.detail);
  });

  it('вымышленное имя инструмента — красный', async () => {
    const provider = scripted(() => ({
      text: '',
      toolCalls: [{ name: 'edit_file', arguments: { file_path: 'src/a.ts', old_string: '100', new_string: '200' } }],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('edit_file'), report.cases[0]!.detail);
  });

  it('правка строго объявленного файла — зелёный', async () => {
    const provider = scripted(() => ({
      text: '',
      toolCalls: [
        { name: 'Edit', arguments: { file_path: 'src/a.ts', old_string: 'const LIMIT = 100', new_string: 'const LIMIT = 200' } },
      ],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, true, report.cases[0]!.detail);
  });

  it('чтение объявленного файла перед правкой — законно, правка после чтения засчитывается', async () => {
    const provider = scripted((req) => {
      const afterTool = req.messages.some((m) => m.role === 'tool');
      if (!afterTool) return { text: '', toolCalls: [{ name: 'Read', arguments: { file_path: 'src/a.ts' } }] };
      return {
        text: '',
        toolCalls: [
          { name: 'Edit', arguments: { file_path: 'src/a.ts', old_string: 'const LIMIT = 100', new_string: 'const LIMIT = 200' } },
        ],
      };
    });
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, true, report.cases[0]!.detail);
  });

  it('чтение ВЫМЫШЛЕННОГО файла — красный: путь назван', async () => {
    const provider = scripted(() => ({ text: '', toolCalls: [{ name: 'Read', arguments: { file_path: 'src/loyalty.ts' } }] }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('src/loyalty.ts'), report.cases[0]!.detail);
  });

  it('маркер 60-й строки доехал — зелёный; не доехал — красный с диагнозом усечения', async () => {
    const full = scripted(() => ({
      text: '',
      toolCalls: [
        {
          name: 'Write',
          arguments: {
            file_path: 'notes/lines.txt',
            content: Array.from({ length: 59 }, (_, i) => `строка ${i + 1}`).join('\n') + '\nстрока 60 — КОНЕЦ\n',
          },
        },
      ],
    }));
    const okReport = await probeModel({ provider: full, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(5, 6) });
    strictEqual(okReport.cases[0]!.ok, true, okReport.cases[0]!.detail);

    const truncated = scripted(() => ({
      text: '',
      toolCalls: [
        { name: 'Write', arguments: { file_path: 'notes/lines.txt', content: 'строка 1\nстрока 2\nстрока 3' } },
      ],
    }));
    const badReport = await probeModel({ provider: truncated, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(5, 6) });
    strictEqual(badReport.cases[0]!.ok, false);
    ok(badReport.cases[0]!.detail.includes('усечён'), badReport.cases[0]!.detail);
  });

  it('правка поля: Edit строки карты — зелёный; Write целиком — красный с названной перезаписью', async () => {
    const form =
      '# Отчёт разведки\n\n## Карта кодовой базы\n\n| Путь | Что там сейчас |\n|---|---|\n| ‹путь› | ‹что там сейчас› |\n';
    const edit = scripted(() => ({
      text: '',
      toolCalls: [
        {
          name: 'Edit',
          arguments: {
            file_path: '.sdlc/probe/exploration-report.md',
            old_string: '| ‹путь› | ‹что там сейчас› |',
            new_string: '| src/a.ts | функция priceFor |',
          },
        },
      ],
    }));
    const good = await probeModel({ provider: edit, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(6, 7) });
    strictEqual(good.cases[0]!.ok, true, good.cases[0]!.detail);

    const rewrite = scripted(() => ({
      text: '',
      toolCalls: [{ name: 'Write', arguments: { file_path: '.sdlc/probe/exploration-report.md', content: form } }],
    }));
    const bad = await probeModel({ provider: rewrite, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(6, 7) });
    strictEqual(bad.cases[0]!.ok, false);
    ok(bad.cases[0]!.detail.includes('переписан целиком'), bad.cases[0]!.detail);
    ok(bad.cases[0]!.detail.includes('стёрто'), bad.cases[0]!.detail);
  });

  it('честность путей: ./src/a.ts и src\\a.ts — тот же объявленный файл, зелёный (code-review, 2026-09-14)', async () => {
    for (const path of ['./src/a.ts', 'src\\a.ts']) {
      const provider = scripted(() => ({
        text: '',
        toolCalls: [{ name: 'Edit', arguments: { file_path: path, old_string: 'const LIMIT = 100', new_string: 'const LIMIT = 200' } }],
      }));
      const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
      strictEqual(report.cases[0]!.ok, true, `${path}: ${report.cases[0]!.detail}`);
    }
  });

  it('честность путей: Read ./src/a.ts, затем Edit src/a.ts — зелёный', async () => {
    const provider = scripted((req) => {
      const afterTool = req.messages.some((m) => m.role === 'tool');
      if (!afterTool) return { text: '', toolCalls: [{ name: 'Read', arguments: { file_path: './src/a.ts' } }] };
      return {
        text: '',
        toolCalls: [{ name: 'Edit', arguments: { file_path: 'src/a.ts', old_string: '100', new_string: '200' } }],
      };
    });
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, true, report.cases[0]!.detail);
  });

  it('длинная запись: маркер с дефисом/коротким тире вместо «—» — зелёный (кейс мерит усечение, не глиф)', async () => {
    for (const marker of ['строка 60 - КОНЕЦ', 'строка 60 – КОНЕЦ', 'строка 60 − КОНЕЦ', 'строка 60 -- КОНЕЦ']) {
      const provider = scripted(() => ({
        text: '',
        toolCalls: [
          {
            name: 'Write',
            arguments: {
              file_path: 'notes/lines.txt',
              content: Array.from({ length: 59 }, (_, i) => `строка ${i + 1}`).join('\n') + `\n${marker}\n`,
            },
          },
        ],
      }));
      const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(5, 6) });
      strictEqual(report.cases[0]!.ok, true, `${marker}: ${report.cases[0]!.detail}`);
    }
  });

  it('точный многострочный Edit остаётся строгим: ./-нормализация сюда не распространяется', async () => {
    const provider = scripted(() => ({
      text: '',
      toolCalls: [
        { name: 'Edit', arguments: { file_path: 'src/template.ts', old_string: 'Срок:  ${days} дн.`;', new_string: 'Дедлайн: ${days} дн.`;' } },
      ],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(3, 4) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('побайтово'), report.cases[0]!.detail);
  });

  it('detail называет первую проваленную проверку: Edit верного файла без 200 — про замену, не про путь', async () => {
    const provider = scripted(() => ({
      text: '',
      toolCalls: [{ name: 'Edit', arguments: { file_path: 'src/a.ts', old_string: '100', new_string: '300' } }],
    }));
    const report = await probeModel({ provider, model: 'm', caseTimeoutMs: 5000, cases: PREFLIGHT_CASES.slice(4, 5) });
    strictEqual(report.cases[0]!.ok, false);
    ok(report.cases[0]!.detail.includes('200'), report.cases[0]!.detail);
  });

  it('полный преполётный набор — семь кейсов', async () => {
    strictEqual(PREFLIGHT_CASES.length, 7);
  });
});
