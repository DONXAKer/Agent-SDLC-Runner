/**
 * Режим «заполнение бланка по полям» (`FormFillExecutor`).
 *
 * Сторожится: плейсхолдеры заполняются ответами модели и артефакт уходит на диск ЧЕРЕЗ
 * гейт (нормализованный Write в `onToolRequest`); отказ гейта оставляет бланк нетронутым;
 * пустой ответ и ответ с плейсхолдером полем не считаются; последнее слово об исходе —
 * за стражем завершения, а не за счётчиком полей.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import { FormFillExecutor, cleanFieldAnswer, cleanRowAnswer, groupFields } from '../src/exec/FormFillExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';

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
