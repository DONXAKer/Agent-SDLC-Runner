/**
 * Режим «заполнение бланка по полям» (`FormFillExecutor`).
 *
 * Сторожится: плейсхолдеры заполняются ответами модели и артефакт уходит на диск ЧЕРЕЗ
 * гейт (нормализованный Write в `onToolRequest`); отказ гейта оставляет бланк нетронутым;
 * пустой ответ и ответ с плейсхолдером полем не считаются; последнее слово об исходе —
 * за стражем завершения, а не за счётчиком полей.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { FormFillExecutor, cleanFieldAnswer, cleanRowAnswer, groupFields } from '../src/exec/FormFillExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { ESTIMATE_MARGIN_TOKENS, estimateMessageTokens } from '../src/exec/contextBudget.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const FORM = ['# Задача', '', '- **Итог:** ‹что должно стать правдой›', '- **Зачем:** ‹почему сейчас›', '- **Ветка:** sdlc/demo', ''].join('\n');

/** Провайдер: отвечает на вопрос о поле готовой строкой по содержимому плейсхолдера. */
function fieldProvider(answers: Record<string, string>): ChatProvider {
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const found = Object.entries(answers).find(([needle]) => user.includes(needle));
      return {
        text: found?.[1] ?? '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

function hooks(seen: { writes: NormalizedCall[] }, allow: boolean): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (call: NormalizedCall) => {
      seen.writes.push(call);
      return allow
        ? { allowed: true, updatedInput: null, by: 'policy' as const }
        : { allowed: false, reason: 'запрещено политикой теста', by: 'policy' as const };
    },
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => 'записано',
    onUsage: () => {},
    onWarn: () => {},
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function request(root: string, artifact: string, over: Partial<ExecRequest> = {}): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап intent', user: 'задача: сделать демо', tools: [], editedByOperator: false },
    cwd: root,
    model: 'm',
    allowedTools: ['Read', 'Edit', 'Write'] as ToolName[],
    mcp: null,
    finishGuard: () => (readFileSync(artifact, 'utf8').includes('‹') ? 'артефакт не заполнен' : null),
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns: 10,
    maxBudgetUsd: null,
    formArtifacts: [artifact],
    signal: new AbortController().signal,
    ...over,
  } as ExecRequest;
}

function setup(): { root: string; artifact: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
  roots.push(root);
  const artifact = join(root, 'intent.md');
  writeFileSync(artifact, FORM);
  return { root, artifact };
}

const exec = (provider: ChatProvider): FormFillExecutor =>
  new FormFillExecutor({ provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000 });

describe('onExchange: что спросили у модели и что она ответила', () => {
  it('хук получает карточку поля без общего промпта этапа и ответ модели', async () => {
    const { root, artifact } = setup();
    const exchanges: { question: string; answer: string }[] = [];
    const h = { ...hooks({ writes: [] }, true), onExchange: (x: { question: string; answer: string }) => exchanges.push(x) } as ExecHooks;
    await exec(fieldProvider({ 'что должно стать правдой': 'Демо работает', 'почему сейчас': 'Нужно к релизу' })).run(request(root, artifact), h);

    ok(exchanges.length >= 2, String(exchanges.length));
    const itog = exchanges.find((x) => x.question.includes('что должно стать правдой'));
    ok(itog !== undefined, exchanges.map((x) => x.question.slice(0, 80)).join(' | '));
    strictEqual(itog.answer, 'Демо работает');
    ok(!itog.question.startsWith('задача: сделать демо'), itog.question.slice(0, 120));
  });
});

describe('groupFields: строка таблицы — одно поле-образец', () => {
  it('два плейсхолдера в строке таблицы схлопываются в одно поле-строку', () => {
    const text = '| id | Пункт | Как проверить |\n|---|---|---|\n| claim-1 | ‹поведение› | ‹критерий› |\n';
    const fields = groupFields(text);
    strictEqual(fields.length, 1);
    strictEqual(fields[0]?.kind, 'row');
    strictEqual(text.slice(fields[0]!.start, fields[0]!.end), '| claim-1 | ‹поведение› | ‹критерий› |');
  });

  it('поле с меткой в списке остаётся одиночным плейсхолдером, а не строкой', () => {
    const fields = groupFields('- **Ветка витка:** ‹sdlc/слаг›\n');
    strictEqual(fields.length, 1);
    strictEqual(fields[0]?.kind, 'cell');
    strictEqual(fields[0]?.text, '‹sdlc/слаг›');
  });

  it('две разные строки таблицы — два поля', () => {
    const text = '| 1 | ‹дата› |\n| 2 | ‹дата› |\n';
    strictEqual(groupFields(text).length, 2);
  });

  it('строка под шапкой «Утвердил (человек)» — решение, модели не отдаётся', () => {
    // Ревью (К1): подпись в таблицах живёт в шапке, и модель подписывала неприменимость.
    const text =
      "| Гейт | Почему бессмыслен для этого diff'а | Утвердил (человек) |\n" +
      '|---|---|---|\n| ‹гейт› | ‹причина› | ‹имя› |\n';
    strictEqual(groupFields(text).length, 0);
  });

  it('строка под шапкой с колонкой «Кто» (таблица «Долг») — тоже решение', () => {
    const text =
      '| Гейт | Где должен стоять | Как закрывается | Дата | Кто |\n' +
      '|---|---|---|---|---|\n| ‹гейт› | ‹где› | ‹как› | ‹дата› | ‹имя› |\n';
    strictEqual(groupFields(text).length, 0);
  });
});

describe('cleanRowAnswer: чистка ответа-строки', () => {
  const header = '| id | Пункт | Как проверить |';

  it('таблица в обёртке из прозы и продублированная шапка чистятся до строк данных', () => {
    const raw = `${header}\n|---|---|---|\n| claim-1 | а | б |\n| claim-2 | в | г |\n**Обоснование:** текст`;
    strictEqual(cleanRowAnswer(raw, header), '| claim-1 | а | б |\n| claim-2 | в | г |');
  });

  it('шапка ЛЮБОЙ таблицы дедуплицируется сравнением с фактической шапкой поля', () => {
    // Ревью (К15): прежний дедуп знал только «| id |», шапка вопросов вклеивалась данными.
    const qHeader = '| # | Вопрос | Блокирующий | Ответ | Изм |';
    const raw = `${qHeader}\n| 1 | как? | да | так | ничего |`;
    strictEqual(cleanRowAnswer(raw, qHeader), '| 1 | как? | да | так | ничего |');
  });

  it('ответ из одной шапки — пустое поле, а не «заполненное» шапкой', () => {
    strictEqual(cleanRowAnswer(`${header}\n|---|---|---|`, header), '');
  });

  it('разделитель без замыкающей черты тоже снимается (модели её теряют)', () => {
    // Ревью-2: своя регулярка требовала замыкающую |, и «|---|---» вклеивался данными.
    strictEqual(cleanRowAnswer('|---|---\n| claim-1 | а | б |', header), '| claim-1 | а | б |');
  });
});

describe('заполнение бланка по полям', () => {
  it('плейсхолдеры заполняются, запись идёт через гейт, этап зелёный', async () => {
    const { root, artifact } = setup();
    const seen = { writes: [] as NormalizedCall[] };
    const result = await exec(
      fieldProvider({
        'что должно стать правдой': '- **Итог:** цена считается на границе 300 см',
        'почему сейчас': '- **Зачем:** теряем заказы',
      }),
    ).run(request(root, artifact), hooks(seen, true));

    strictEqual(result.ok, true, result.note);
    strictEqual(seen.writes.length, 1);
    strictEqual(seen.writes[0]!.kind, 'write');
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('граница') || text.includes('границе'), text);
    ok(!text.includes('‹'), 'плейсхолдеры остались');
    ok(text.includes('sdlc/demo'), 'строки без плейсхолдеров тронуты');
  });

  it('отказ гейта оставляет бланк нетронутым, этап красный по стражу', async () => {
    const { root, artifact } = setup();
    const seen = { writes: [] as NormalizedCall[] };
    const result = await exec(
      fieldProvider({ 'что должно стать правдой': '- **Итог:** готово', 'почему сейчас': '- **Зачем:** надо' }),
    ).run(request(root, artifact), hooks(seen, false));

    strictEqual(result.ok, false);
    ok(readFileSync(artifact, 'utf8').includes('‹'), 'бланк изменён мимо отказа гейта');
    ok(result.finalText.includes('отклонена'), result.finalText);
  });

  it('пустой ответ и ответ с плейсхолдером полем не считаются', async () => {
    const { root, artifact } = setup();
    const seen = { writes: [] as NormalizedCall[] };
    const result = await exec(
      fieldProvider({ 'что должно стать правдой': '- **Итог:** готово', 'почему сейчас': '- **Зачем:** ‹не знаю›' }),
    ).run(request(root, artifact), hooks(seen, true));

    strictEqual(result.ok, false, 'этап не должен зеленеть с незаполненным полем');
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('- **Итог:** готово'), text);
    ok(text.includes('‹почему сейчас›'), 'незаполненное поле должно остаться плейсхолдером');
  });

  it('систематическая ошибка провайдера (та же строка N раз подряд) останавливает этап рано, а не тонет в «поле не спрошено» (замер qwen3-coder-30b-a3b/sweep5, 2026-09-13)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      [
        '# Задача',
        '',
        '- **Поле 1:** ‹а›',
        '- **Поле 2:** ‹б›',
        '- **Поле 3:** ‹в›',
        '- **Поле 4:** ‹г›',
        '- **Поле 5:** ‹д›',
        '',
      ].join('\n'),
    );
    // Не `ProviderEnvError` — намеренно обычная ошибка, тот же класс, что HTTP 404
    // «модель не найдена» у OpenAiCompatProvider (чинится конфигом, не средой), и он же
    // не даёт классифицировать это как envFailure — раньше тонул в notes целиком.
    const provider: ChatProvider = {
      name: 'stub',
      async chat() {
        throw new Error("model 'dead-tag' not found");
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, false);
    ok(result.note.includes('одну и ту же ошибку'), result.note);
    ok(result.note.includes('сломанный конфиг'), result.note);
    // Остановка ранняя — не «поле не спрошено» на каждое из пяти полей подряд.
    ok(!result.note.includes('поле не спрошено'), result.note);
  });

  it('переполнение контекста: диагноз несёт оценку входа и говорит, что окно не задано (серия v4 — без чисел)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, ['# Задача', '', '- **Поле 1:** ‹а›', '- **Поле 2:** ‹б›', '- **Поле 3:** ‹в›', ''].join('\n'));
    const provider: ChatProvider = {
      name: 'stub',
      async chat() {
        throw new Error('HTTP 400 {"error":"Context size has been exceeded."}');
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, false);
    ok(result.note.includes('не помещается в окно'), result.note);
    ok(/наибольший вход ≈\d+ токенов/.test(result.note), result.note);
    ok(result.note.includes('окно маршрута не задано'), result.note);
  });

  // Поля пачки идут параллельно, и прежнее поле экземпляра «последний запрос» перезаписывал
  // тот, чей paramsFor выполнился позже: пачка спрашивается с конца бланка, поэтому крупное
  // поле в КОНЦЕ уходило первым, а диагноз называл размер мелкого соседа.
  it('диагноз переполнения называет наибольший вход пачки, а не последний', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    const huge = 'x'.repeat(40_000);
    writeFileSync(artifact, ['# Задача', '', '- **Поле 1:** ‹а›', '- **Поле 2:** ‹б›', `- **Поле 3:** ‹в› ${huge}`, ''].join('\n'));
    const provider: ChatProvider = {
      name: 'stub',
      async chat() {
        throw new Error('HTTP 400 {"error":"Context size has been exceeded."}');
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    const n = Number(/наибольший вход ≈(\d+) токенов/.exec(result.note)?.[1] ?? 0);
    ok(n >= 10_000, `назван не наибольший вход: ${result.note}`);
  });

  it('счёт обращений к модели — в modelRequests, а не в turns (другая единица)', async () => {
    const { root, artifact } = setup();
    const result = await exec(fieldProvider({ 'что должно стать правдой': 'демо работает', 'почему сейчас': 'нужно' })).run(
      request(root, artifact),
      hooks({ writes: [] }, true),
    );
    strictEqual(result.modelRequests, 2);
    strictEqual(result.turns, undefined);
  });

  // Запас в целый результат инструмента (marginFor(maxResultBytes)) у запроса без
  // инструментов сажал ответ поля на пол: окно 4096, maxResultBytes 10 000 → запас 2500.
  it('contextWindow: запас полевого запроса — только на неточность оценки, не на результаты инструментов', async () => {
    const { root, artifact } = setup();
    const seen: ChatRequest[] = [];
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        seen.push(req);
        return {
          text: 'значение',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const executor = new FormFillExecutor({
      provider,
      maxResultBytes: 10_000,
      readRangeRequiredAboveBytes: 10_000,
      bashTimeoutMs: 1000,
      contextWindow: 4096,
    });
    await executor.run(request(root, artifact), hooks({ writes: [] }, true));
    ok(seen.length > 0);
    for (const r of seen) {
      const expected = 4096 - estimateMessageTokens(r.messages) - ESTIMATE_MARGIN_TOKENS;
      ok(expected > 256, `тест потерял смысл: остаток ${expected}`);
      strictEqual((r.params as Record<string, unknown>)['max_tokens'], expected);
    }
  });

  it('отказы, перемежённые успехом, — не систематическая ошибка: счётчик подряд сбрасывается успешным полем (code-review-all, 2026-09-14)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      [
        '# Задача',
        '',
        '- **Поле 1:** ‹а›',
        '- **Поле 2:** ‹б›',
        '- **Поле 3:** ‹в›',
        '- **Поле 4:** ‹г›',
        '- **Поле 5:** ‹д›',
        '',
      ].join('\n'),
    );
    // Поля 1,3,5 падают с ОДНОЙ и той же ошибкой, 2 и 4 отвечают штатно — та же ошибка
    // встречается трижды за прогон, но никогда три раза ПОДРЯД (между каждой парой отказов
    // стоит успех). До фикса счётчик считал только ветку `rejected` и не видел успехи между
    // ними — те же три одинаковых отказа ложно читались как «подряд» и рано останавливали
    // этап, хотя половина полей была заполнена штатно. Отказные поля падают только на
    // ПЕРВОМ вопросе: второй проход спрашивает их подряд, без успехов между ними, и если бы
    // они падали снова, это была бы уже настоящая серия из трёх — отдельный сценарий.
    // Прежде второй проход отсекался потолком `maxTurns: 5`, но бюджет дозаполнения больше
    // от лимита ходов не зависит (`fillRequestBudget`).
    const asked = new Map<string, number>();
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        const field = /Поле (\d):/.exec(user)?.[1] ?? '';
        const n = (asked.get(field) ?? 0) + 1;
        asked.set(field, n);
        if (['1', '3', '5'].includes(field) && n === 1) throw new Error("model 'dead-tag' not found");
        return {
          text: 'значение поля',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact, { maxTurns: 5 }), hooks({ writes: [] }, true));

    // Не систематический отказ: этап доходит до конца прохода, а не останавливается рано
    // (ранняя остановка возвращает диагноз В `note` напрямую, минуя стража завершения).
    ok(!result.note.includes('одну и ту же ошибку'), result.note);
    ok(!result.note.includes('сломанный конфиг'), result.note);
    // Ровно три поля из пяти честно остались незаполненными, а не проглочены остановкой —
    // подробности в `finalText` (сводка), `note` здесь — жалоба стража («не заполнен»).
    const seen = (result.finalText.match(/поле не спрошено/g) ?? []).length;
    strictEqual(seen, 3, result.finalText);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('- **Поле 2:** значение поля'), text);
    ok(text.includes('- **Поле 4:** значение поля'), text);
  });

  it('систематическая ошибка «Context size has been exceeded» — диагноз про размер промпта, не про конфиг (замер qwen3-8b/refuse-dangerous, 2026-09-13)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['# Задача', '', '- **Поле 1:** ‹а›', '- **Поле 2:** ‹б›', '- **Поле 3:** ‹в›', ''].join('\n'),
    );
    const provider: ChatProvider = {
      name: 'stub',
      async chat() {
        throw new Error(
          'lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict stream returned an ' +
            'error: {\\"code\\":500,\\"message\\":\\"Context size has been exceeded.\\",\\"type\\":\\"server_error\\"}"}',
        );
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, false);
    ok(result.note.includes('одну и ту же ошибку'), result.note);
    ok(result.note.includes('не помещается в окно контекста'), result.note);
    ok(!result.note.includes('сломанный конфиг'), result.note);
  });

  it('систематическая ошибка «fetch failed» — диагноз про недоступность модели, не про конфиг (замер qwen3-coder-30b-stepfill/freeship, серия v3, 2026-09-13)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['# Задача', '', '- **Поле 1:** ‹а›', '- **Поле 2:** ‹б›', '- **Поле 3:** ‹в›', ''].join('\n'),
    );
    // Живой замер: LM Studio выгрузил/уронил модель под давлением памяти между `lms load`
    // и первым запросом бенча — три поля подряд получили одну и ту же сетевую ошибку.
    const provider: ChatProvider = {
      name: 'stub',
      async chat() {
        throw new Error(
          'lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"}',
        );
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, false);
    ok(result.note.includes('одну и ту же ошибку'), result.note);
    ok(result.note.includes('недоступна прямо сейчас'), result.note);
    ok(!result.note.includes('сломанный конфиг'), result.note);
    ok(!result.note.includes('не помещается в окно контекста'), result.note);
  });

  it('поле «Карта кодовой базы» получает заземление — реальные пути проекта, не память модели', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    // Файл реально существует в дереве проекта — заземление обязано его назвать.
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.ts'), 'export const real = 1;\n');
    const artifact = join(root, 'exploration-report.md');
    writeFileSync(
      artifact,
      [
        '## Карта кодовой базы',
        '',
        '| Файл | Что там сейчас | Что меняем |',
        '|---|---|---|',
        '| ‹путь› | ‹что там сейчас› | ‹что меняем› |',
        '',
      ].join('\n'),
    );
    let seenPrompt = '';
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        seenPrompt = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        return {
          text: '| `src/real.ts` | код | правка |',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    ok(seenPrompt.includes('Реальные файлы проекта'), 'нет заземляющего блока в промпте поля');
    ok(seenPrompt.includes('src/real.ts'), 'заземление не назвало реальный файл дерева');
    ok(seenPrompt.includes('Называй в карте ТОЛЬКО пути из этого списка'), 'нет инструкции не сочинять пути');
  });

  it('лист приёмки ниже нормы добирается повторным запросом, дубли id отбрасываются (r17)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['## Приёмочный лист', '', '| id | что проверяем |', '|---|---|', '| ‹claim-N› | ‹проверка› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        // Добор ПЕРВЫМ в словаре: оба запроса содержат текст задачи, ищется по вхождению.
        // Модель типично возвращает весь лист заново: дословный повтор (claim-2)
        // отбрасывается по содержимому, новый пункт под занятым id (claim-1)
        // перенумеровывается — r17e показал, что фильтр «дубль id → в мусор»
        // выбрасывал и новые пункты.
        'Добор приёмочного листа':
          '| `claim-2` | ещё случай |\n| `claim-1 [edge]` | граница 300 |\n| `claim-4 [edge]` | пустой ввод |',
        'ОБРАЗЕЦ': '| `claim-1` | базовый случай |\n| `claim-2` | ещё случай |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('claim-4 [edge]'), text);
    ok(text.includes('claim-3 [edge]` | граница 300'), `новый пункт под занятым id должен быть перенумерован:\n${text}`);
    strictEqual(text.split('ещё случай').length - 1, 1, 'дословный повтор пункта должен быть отброшен');
  });

  it('лист приёмки: первая попытка добора без [edge], вторая (настойчивая) закрывает дефицит', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['## Приёмочный лист', '', '| id | что проверяем |', '|---|---|', '| ‹claim-N› | ‹проверка› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        // Ключ ретрая специфичнее общего добора — должен идти первым в словаре, иначе
        // второй вызов (тоже содержащий общий текст добора) совпал бы с первым ключом.
        'Предыдущий ответ дефицит не закрыл': '| `claim-4 [edge]` | граница A |\n| `claim-5 [edge]` | граница B |',
        'Добор приёмочного листа': '| `claim-3` | ещё случай без edge |',
        'ОБРАЗЕЦ': '| `claim-1` | базовый случай |\n| `claim-2` | ещё один |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    ok(result.note.includes('попытка 1') && result.note.includes('попытка 2'), result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('claim-4 [edge]') && text.includes('claim-5 [edge]'), text);
    ok(!result.note.includes('не закрыл минимум'), 'дефицит закрыт второй попыткой — жалобы быть не должно');
  });

  it('лист приёмки: обе попытки добора не несут [edge] — честная заметка о неудаче, не ложный успех', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['## Приёмочный лист', '', '| id | что проверяем |', '|---|---|', '| ‹claim-N› | ‹проверка› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        'Предыдущий ответ дефицит не закрыл': '| `claim-4` | ещё один без edge |',
        'Добор приёмочного листа': '| `claim-3` | ещё случай без edge |',
        'ОБРАЗЕЦ': '| `claim-1` | базовый случай |\n| `claim-2` | ещё один |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    ok(result.note.includes('не закрыл минимум за 2 попытки'), result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(!text.includes('[edge]'), 'в тексте не должно быть тега [edge] — ни одна попытка его не дала');
  });

  it('пустой files_to_touch добирается повторным запросом (2026-09-03: PlanScope отключился бы молча)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        // Добор ПЕРВЫМ в словаре: обычный запрос на строку-образец тоже содержит текст
        // задачи — без явного порядка совпал бы он, а не добор.
        'Добор files_to_touch': '| `src/a.ts` | добавить проверку |',
        'ОБРАЗЕЦ': '', // первый запрос — пустой ответ, ровно та ситуация, что поймали живьём
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('src/a.ts') && text.includes('добавить проверку'), text);
    ok(!text.includes('‹path/to/file›'), 'плейсхолдер не должен остаться после добора');
  });

  it('files_to_touch, добор тоже вернул пусто — поле остаётся плейсхолдером, этап красный', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(fieldProvider({})).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, false, 'этап не должен зеленеть с незаполненным files_to_touch');
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('‹path/to/file›'), 'плейсхолдер остаётся, когда и добор пуст');
  });

  it('без списка артефактов режим честно отказывается', async () => {
    const { root, artifact } = setup();
    const result = await exec(fieldProvider({})).run(
      request(root, artifact, { formArtifacts: [] }),
      hooks({ writes: [] }, true),
    );
    strictEqual(result.ok, false);
    ok(result.note.includes('не назвал артефактов'));
  });
});

describe('cleanFieldAnswer', () => {
  it('снимает fenced-блок и внешние кавычки, содержимое не редактирует', () => {
    strictEqual(cleanFieldAnswer('```markdown\n- **Итог:** готово\n```'), '- **Итог:** готово');
    strictEqual(cleanFieldAnswer('«- **Итог:** готово»'), '- **Итог:** готово');
    strictEqual(cleanFieldAnswer('  строка как есть  '), 'строка как есть');
  });
});

// ---------------------------------------------------------------------------
// Режим compact: схема формы вместо сплошного текста (`compactForms ∈ {fill, all}`)
// ---------------------------------------------------------------------------

const COMPACT_FORM = [
  '# Задача: demo',
  '',
  '- **Ветка витка:** ‹sdlc/слаг›',
  '- **Контур:** полный / мелкий — критерий в SDLC.md',
  '',
  '## Приёмочный лист',
  '',
  '| id | Пункт | Как проверить |',
  '|---|---|---|',
  '| claim-1 | ‹наблюдаемое поведение› | ‹процедура и критерий годности› |',
  '',
  '## Что придётся тронуть',
  '',
  '- ‹path/to/file› — ‹что здесь меняем›',
  '',
  '- **Одобрение:** ‹имя› · ‹дата› / **не одобрен**',
  '',
].join('\n');

function setupCompact(): { root: string; artifact: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-form-compact-'));
  roots.push(root);
  const artifact = join(root, 'intent.md');
  writeFileSync(artifact, COMPACT_FORM);
  return { root, artifact };
}

/** Провайдер: отвечает по id поля из карточки («- id: `...`») в последнем user-сообщении. */
function compactProvider(answers: Record<string, string>): ChatProvider {
  return {
    name: 'stub',
    async chat(req: ChatRequest) {
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const found = Object.entries(answers).find(([id]) => user.includes(`\`${id}\``));
      return {
        text: found?.[1] ?? '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider;
}

const execCompact = (provider: ChatProvider, stage: 'intent' | 'explore' = 'intent'): FormFillExecutor =>
  new FormFillExecutor({
    provider,
    maxResultBytes: 10_000,
    readRangeRequiredAboveBytes: 10_000,
    bashTimeoutMs: 1000,
    compact: true,
    stage,
  });

describe('режим compact: поля из схемы, ответ рисует applyFill', () => {
  it('scalar/choice/records заполняются без разметки в ответе модели, запись — через гейт', async () => {
    const { root, artifact } = setupCompact();
    const seen = { writes: [] as NormalizedCall[] };
    const result = await execCompact(
      compactProvider({
        'ветка витка': 'sdlc/oversize',
        контур: 'мелкий',
        'приемочный лист': '- пункт: код 200\n  как проверить: retryReturns200',
      }),
    ).run(request(root, artifact), hooks(seen, true));

    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('sdlc/oversize'));
    ok(text.includes('мелкий') && !text.includes('полный'), 'выбранная ветка меню заменяет обе');
    ok(text.includes('| claim-1 |'), 'записи приёмочного листа нумерует рантайм');
    ok(seen.writes.some((c) => c.kind === 'write'), 'запись идёт нормализованным Write через гейт');
    strictEqual(result.ok, false); // "Что придётся тронуть" (stageOnly: explore) и "Одобрение" (decision) остаются
  });

  it('поле stageOnly не спрашивается на чужом этапе, но спрашивается на своём', async () => {
    const { root, artifact } = setupCompact();
    const asked: string[] = [];
    const spy: ChatProvider = {
      name: 'spy',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        asked.push(user);
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(spy, 'intent').run(request(root, artifact), hooks({ writes: [] }, true));
    ok(!asked.some((u) => u.includes('что придется тронуть') || u.includes('что придётся тронуть')));
  });

  it('поле решения человека («Одобрение») не спрашивается ни в каком виде', async () => {
    const { root, artifact } = setupCompact();
    const asked: string[] = [];
    const spy: ChatProvider = {
      name: 'spy',
      async chat(req: ChatRequest) {
        asked.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        return {
          text: 'x',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(spy).run(request(root, artifact), hooks({ writes: [] }, true));
    ok(!asked.some((u) => u.includes('одобрение')));
  });

  it('лист приёмки ниже минимума добирается повторным запросом (compact)', async () => {
    const { root, artifact } = setupCompact();
    let claimCalls = 0;
    const provider: ChatProvider = {
      name: 'topup',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (user.includes('Добор поля')) {
          return {
            text: '- пункт: без ключа код 201 [edge]\n  как проверить: noKeyReturns201',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        if (user.includes('`приемочный лист`') || user.includes('приемочный лист')) {
          claimCalls++;
          return {
            text: '- пункт: код 200\n  как проверить: retryReturns200',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        return {
          text: 'x',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(provider).run(request(root, artifact, { maxTurns: 20 }), hooks({ writes: [] }, true));
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('claim-1') && text.includes('claim-2'), 'добор добавил вторую запись');
    strictEqual(claimCalls, 1, 'начальный ответ на лист запрошен один раз');
  });

  it('лист приёмки (compact): обе попытки добора не несут [edge] — честная заметка, не ложный успех', async () => {
    const { root, artifact } = setupCompact();
    let topUpCalls = 0;
    const provider: ChatProvider = {
      name: 'topup-fail',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (user.includes('Добор поля')) {
          topUpCalls++;
          return {
            text: '- пункт: без edge вовсе\n  как проверить: stillNoEdge',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        if (user.includes('приемочный лист')) {
          return {
            text: '- пункт: код 200\n  как проверить: returns200',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        return {
          text: 'x',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const result = await execCompact(provider).run(request(root, artifact, { maxTurns: 20 }), hooks({ writes: [] }, true));
    strictEqual(topUpCalls, 2, 'обе попытки добора должны быть исчерпаны — ни одна не закрыла [edge]');
    // `note` при незакрытом finishGuard — это жалоба стража («артефакт не заполнен» из-за
    // ДРУГИХ, не относящихся к листу, полей шаблона); честная заметка про [edge] живёт в
    // `finalText` — это одна и та же сводка `notes.join('; ')` в обеих ветках исхода.
    ok(result.finalText.includes('не закрыл минимум за 2 попытки'), result.finalText);
    const text = readFileSync(artifact, 'utf8');
    ok(!text.includes('[edge]'), 'в тексте не должно быть тега [edge] — ни одна попытка его не дала');
  });
});
