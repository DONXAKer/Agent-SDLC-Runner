/**
 * Режим «заполнение бланка по полям» (`FormFillExecutor`).
 *
 * Сторожится: плейсхолдеры заполняются ответами модели и артефакт уходит на диск ЧЕРЕЗ
 * гейт (нормализованный Write в `onToolRequest`); отказ гейта оставляет бланк нетронутым;
 * пустой ответ и ответ с плейсхолдером полем не считаются; последнее слово об исходе —
 * за стражем завершения, а не за счётчиком полей.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import {
  FormFillExecutor,
  cleanFieldAnswer,
  cleanRowAnswer,
  compactFieldGroups,
  compactGroupResponseFormat,
  conditionalFieldEmptyAlternative,
  deferredIntentMethodProblem,
  groupFields,
  parseCompactGroupResponse,
  planApproachEvidenceProblem,
  planStepInventedFileCompact,
  renderBasisReferences,
  structuredClaimResponseFormat,
} from '../src/exec/FormFillExecutor.ts';
import { deriveSchema, modelFields, type FormField } from '../src/artifacts/formSchema.ts';
import { normalizePreparationTables, requirementProblem } from '../src/artifacts/preparation.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import { ESTIMATE_MARGIN_TOKENS, estimateMessageTokens } from '../src/exec/contextBudget.ts';

const roots: string[] = [];
it('guided reviews acceptance before writing it and retries concrete semantic errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-intent-review-')); roots.push(root);
  const artifact = join(root, 'intent.md');
  writeFileSync(artifact, '<!-- sdlc-template: intent v1 -->\n<!-- sdlc-json:acceptance:start -->\n‹acceptance_json›\n<!-- sdlc-json:acceptance:end -->');
  let drafts = 0, audits = 0;
  const provider = { name: 'semantic-spy', async chat(req: ChatRequest) {
    const audit = req.messages[0]?.content.startsWith('Проверь черновик приёмки');
    let text: string;
    if (audit) {
      audits++;
      const data = JSON.parse(req.messages.at(-1)!.content);
      strictEqual(data.phase,'BEFORE_IMPLEMENTATION'); strictEqual('sourceFacts' in data,false);
      text = JSON.stringify({ issues: audits === 1 ? [{claimId:'claim-1',problem:'valid input must not fail',basis:'valid allowed',counterexample:'valid input expected refusal'}] : [] });
    } else {
      drafts++;
      if (drafts > 1) ok(req.messages.at(-1)?.content.includes('valid input must not fail'));
      text = JSON.stringify([{id:'claim-1',behavior:'valid input allowed',procedure:'use valid input',expected:drafts === 1 ? 'refuse' : 'allow'}]);
    }
    return { text, toolCalls: [], finishReason:'end_turn' as const, usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:null,durationMs:1} };
  }} as unknown as ChatProvider;
  const result = await new FormFillExecutor({provider,maxResultBytes:10000,readRangeRequiredAboveBytes:10000,bashTimeoutMs:1000,
    compact:true,preparationV2:true,reviewIntentClaims:true,stage:'intent'}).run(request(root,artifact), hooks({writes:[]},true));
  strictEqual(result.ok,true,result.note); strictEqual(drafts,2); strictEqual(audits,2);
  ok(readFileSync(artifact,'utf8').includes('"expected":"allow"')); ok(!readFileSync(artifact,'utf8').includes('"expected":"refuse"'));
});
it('guided does not close acceptance when its semantic review is malformed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-intent-review-fail-')); roots.push(root);
  const artifact = join(root,'intent.md');
  writeFileSync(artifact,'<!-- sdlc-template: intent v1 -->\n<!-- sdlc-json:acceptance:start -->\n‹acceptance_json›\n<!-- sdlc-json:acceptance:end -->');
  const provider = {name:'incomplete-audit',async chat(req:ChatRequest) {
    return {text:req.messages[0]?.content.startsWith('Проверь черновик приёмки') ? '{}' : '[{"id":"claim-1","behavior":"valid","procedure":"check","expected":"allow"}]',
      toolCalls:[],finishReason:'end_turn' as const,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0,costUsd:null,durationMs:1}};
  }} as unknown as ChatProvider;
  const result = await new FormFillExecutor({provider,maxResultBytes:10000,readRangeRequiredAboveBytes:10000,bashTimeoutMs:1000,
    compact:true,preparationV2:true,reviewIntentClaims:true,stage:'intent'}).run(request(root,artifact),hooks({writes:[]},true));
  strictEqual(result.ok,false); ok(readFileSync(artifact,'utf8').includes('‹acceptance_json›'));
});
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

it('guided lists travel as JSON items and the runtime renders the document', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-guided-items-')); roots.push(root);
  const artifact = join(root, 'intent.md'); writeFileSync(artifact, '# Task\n\n## Что делаем\n- ‹пункт›\n');
  const provider: ChatProvider = { name: 'test', async chat(req) {
    const input = JSON.parse(req.messages[1]!.content);
    ok(input.questionId); ok(!req.messages[1]!.content.includes('‹пункт›'));
    ok(!req.messages[1]!.content.includes('строка бланка'));
    return { text: JSON.stringify({ items: ['Сохранить заданное поведение'] }), toolCalls: [], finishReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1 } };
  } };
  const result = await new FormFillExecutor({ provider, maxResultBytes: 10000, readRangeRequiredAboveBytes: 10000,
    bashTimeoutMs: 1000, compact: true, stage: 'intent' }).run(request(root, artifact, {
      prompt: { presetNote: null, system: '', user: JSON.stringify({ data: { requests: ['Сохранить поведение'] } }),
        tools: [], editedByOperator: false, guidedProtocol: true },
    }), hooks({ writes: [] }, true));
  strictEqual(result.ok, true, result.note);
  ok(readFileSync(artifact, 'utf8').includes('- Сохранить заданное поведение'));
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

/**
 * Провайдер: тот же поиск по подстроке, что у `fieldProvider`, но каждый ответ несёт СВОЙ
 * `rawLogPath` — только так тест может отличить метку исходного обмена от метки топ-апа
 * (до этого стаб всегда возвращал один путь на все ответы пачки, и тест не мог поймать
 * находку «метка приклеена к обмену до топ-апа, а не после», code-review-all, 2026-09-27).
 */
function fieldProviderTraced(answers: Record<string, { text: string; rawLogPath: string | null }>): ChatProvider {
  return {
    name: 'stub-traced',
    async chat(req: ChatRequest) {
      const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      const found = Object.entries(answers).find(([needle]) => user.includes(needle));
      return {
        text: found?.[1].text ?? '',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
        rawLogPath: found?.[1].rawLogPath ?? null,
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

describe('карточка поля не несёт инструментов (2026-09-23)', () => {
  it('каждый запрос поля уходит с tools: [] — модель не может уйти в разведку вместо ответа', async () => {
    // Живой класс (`ornith-1.5-9b`, test28d/test30, 2026-09-23): модель в свободном ходу
    // тратит 400–800 с на поле, читая шаблон инструментами вместо ответа. Карточка
    // намеренно не даёт ей чем читать — регрессия здесь означала бы, что кто-то дал
    // карточке `req.prompt.tools` или инструменты этапа по ошибке.
    const { root, artifact } = setup();
    const seenTools: unknown[][] = [];
    const provider: ChatProvider = {
      name: 'stub',
      async chat(req: ChatRequest) {
        seenTools.push([...req.tools]);
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        const text = user.includes('что должно стать правдой')
          ? '- **Итог:** цена считается на границе 300 см'
          : user.includes('почему сейчас')
            ? '- **Зачем:** теряем заказы'
            : '';
        return {
          text,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    ok(seenTools.length > 0, 'ни одного запроса поля не было — тест не проверил ничего');
    for (const tools of seenTools) deepStrictEqual(tools, [], JSON.stringify(seenTools));
  });
});

describe('заполнение бланка по полям', () => {
  it('uses the actual provider for local reasoning defaults and preserves explicit effort', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-local-effort-')); roots.push(root);
    const artifact = join(root, 'intent.md');
    const model = fieldProvider({ 'название': 'Демо' });
    const seen: unknown[] = [];
    const local = { ...model, name: 'ollama', async chat(input: ChatRequest) {
      seen.push(input.params?.['reasoning_effort']); return model.chat(input);
    } };
    const options = { provider: local, maxResultBytes: 10000, readRangeRequiredAboveBytes: 10000, bashTimeoutMs: 1000, compact: true };
    writeFileSync(artifact, '# Задача: ‹название›');
    strictEqual((await new FormFillExecutor(options).run(request(root, artifact, { model: 'local-tag' }), hooks({ writes: [] }, true))).ok, true);
    deepStrictEqual(seen, ['none']);
    seen.length = 0; writeFileSync(artifact, '# Задача: ‹название›');
    strictEqual((await new FormFillExecutor({ ...options, params: { reasoning_effort: 'low' } }).run(request(root, artifact), hooks({ writes: [] }, true))).ok, true);
    deepStrictEqual(seen, ['low']);
  });

  it('повтор после обрезки max_tokens идёт с тем же reasoning_effort и поднятым лимитом', async () => {
    // Разбор прогонов 2026-10-05: повтор молча понижал medium/high до low — параметр
    // эксперимента менялся посреди измерения. Теперь растёт только лимит длины.
    const root = mkdtempSync(join(tmpdir(), 'sdlc-effort-retry-')); roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Задача: ‹название›');
    const calls: Record<string, unknown>[] = [];
    const provider = {
      name: 'ollama',
      async chat(req: ChatRequest) {
        calls.push({ ...(req.params ?? {}) });
        const truncated = calls.length === 1;
        return {
          text: truncated ? '' : 'Демо', toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: truncated ? 'max_tokens' as const : 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const result = await new FormFillExecutor({
      provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000,
      compact: true, params: { reasoning_effort: 'high' },
    }).run(request(root, artifact), hooks({ writes: [] }, true));
    strictEqual(result.ok, true, result.note);
    strictEqual(calls.length, 2, JSON.stringify(calls));
    strictEqual(calls[0]!['reasoning_effort'], 'high');
    strictEqual(calls[1]!['reasoning_effort'], 'high');
    strictEqual(Number(calls[1]!['max_tokens']), Math.min(8192, Number(calls[0]!['max_tokens']) * 2));
  });

  it('непоправимая обрезка поля — трение truncated в метриках, а не молчаливый приём', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-truncated-friction-')); roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Задача: ‹название›');
    const provider = {
      name: 'ollama',
      async chat() {
        return {
          text: '', toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'max_tokens' as const,
        };
      },
    } as unknown as ChatProvider;
    const frictions: string[] = [];
    const h = { ...hooks({ writes: [] }, true), onFriction: (kind: string) => { frictions.push(kind); } } as unknown as ExecHooks;
    const result = await new FormFillExecutor({
      provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000, compact: true,
    }).run(request(root, artifact), h);
    strictEqual(result.ok, false);
    ok(frictions.includes('truncated'), JSON.stringify(frictions));
  });

  it('дублирует точную форму JSON в карточках intent acceptance и basis', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-preparation-json-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, [
      '<!-- sdlc-template: intent v1 -->',
      '<!-- sdlc-json:acceptance:start -->', '‹acceptance_json›', '<!-- sdlc-json:acceptance:end -->',
      '<!-- sdlc-json:basis:start -->', '‹basis_json›', '<!-- sdlc-json:basis:end -->',
    ].join('\n'));
    const questions: string[] = [];
    const reasoningEfforts: unknown[] = [];
    const provider: ChatProvider = {
      name: 'capture-json-card',
      async chat(req: ChatRequest) {
        const question = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        questions.push(question);
        reasoningEfforts.push(req.params?.['reasoning_effort']);
        const format = req.params?.['response_format'] as any;
        strictEqual(format.json_schema.schema.type, 'array');
        const items = format.json_schema.schema.items;
        if (items.oneOf !== undefined) {
          deepStrictEqual(items.oneOf.map((row: any) => row.properties.id.const), ['claim-1']);
          strictEqual(items.oneOf[0].additionalProperties, false);
        } else {
          strictEqual(items.additionalProperties, false);
        }
        ok(Number(req.params?.['max_tokens']) >= 4096);
        const answer = question.includes('acceptance_json')
          ? '[{"id":"claim-1","behavior":"one","procedure":"check one","expected":"one"}]'
          : '[{"id":"claim-1","basis":{"file":"request-1","lines":[1,1]},"scenario":"when","counterexample":"else"}]';
        return {
          text: answer, toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const result = await new FormFillExecutor({
      provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000, compact: true,
    }).run(request(root, artifact), hooks({ writes: [] }, true));
    strictEqual(result.ok, true, result.note);
    const acceptanceIndex = questions.findIndex((q) => q.includes('только JSON-массив') && q.toLowerCase().includes('не добавляй внешний объект') && q.includes('"procedure"'));
    const basisIndex = questions.findIndex((q) => q.includes('ссылка на строки показанного исходного запроса') && q.includes('"counterexample"'));
    ok(acceptanceIndex >= 0, questions.join('\n---\n'));
    ok(basisIndex > acceptanceIndex, questions.join('\n---\n'));
    ok(questions[basisIndex]!.includes('claim-1 → one'), questions[basisIndex]);
    deepStrictEqual(reasoningEfforts, ['none', 'none']);
  });

  it('переспрашивает malformed claim JSON с конкретной причиной до закрытия intent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-preparation-json-repair-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, [
      '<!-- sdlc-template: intent v1 -->',
      '<!-- sdlc-json:acceptance:start -->', '‹acceptance_json›', '<!-- sdlc-json:acceptance:end -->',
      '<!-- sdlc-json:basis:start -->', '‹basis_json›', '<!-- sdlc-json:basis:end -->',
    ].join('\n'));
    const questions: string[] = [];
    let acceptanceCalls = 0;
    const provider: ChatProvider = {
      name: 'repair-json-card',
      async chat(req: ChatRequest) {
        const question = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        questions.push(question);
        const acceptance = question.includes('acceptance_json');
        acceptanceCalls += acceptance ? 1 : 0;
        const answer = acceptance
          ? acceptanceCalls === 1
            ? '[{"id":"claim-1","buffer":"missing behavior","procedure":"check","expected":"ok"}]'
            : '[{"id":"claim-1","behavior":"one","procedure":"check","expected":"ok"}]'
          : '[{"id":"claim-1","basis":{"file":"request-1","lines":[1,1]},"scenario":"use","counterexample":"wrong"}]';
        return {
          text: answer, toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const result = await new FormFillExecutor({
      provider, maxResultBytes: 10_000, readRangeRequiredAboveBytes: 10_000, bashTimeoutMs: 1000,
      compact: true, preparationV2: true,
    }).run(request(root, artifact), hooks({ writes: [] }, true));
    strictEqual(result.ok, true, result.note);
    strictEqual(acceptanceCalls, 2);
    ok(questions.some((question) => question.includes('Прошлая попытка этого поля отклонена') && question.includes('лишние ключи запрещены')), questions.join('\n---\n'));
    ok(!readFileSync(artifact, 'utf8').includes('‹acceptance_json›'));
  });

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

  it('JSON-конверт вместо значения — второй проход получает подсказку и заполняет поле', async () => {
    const { root, artifact } = setup();
    const result = await exec(
      fieldProvider({
        'что должно стать правдой': '- **Итог:** цена считается на границе 300 см',
        // Ключ раньше 'почему сейчас' в словаре: на втором проходе строка-плейсхолдер
        // ('почему сейчас') всё ещё в промпте карточки, но подсказка о прошлом отказе
        // обязана матчиться первой — иначе тест проверял бы старое поведение.
        'Прошлая попытка': '- **Зачем:** обновлённая причина после подсказки',
        'почему сейчас': '{"tool":"Read","arguments":{"file_path":"./x.ts"}}',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('обновлённая причина'), text);
    ok(!text.includes('‹'), 'плейсхолдеры не должны остаться');
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

  it('files_to_touch: путь похож по форме, но файла нет и он не помечен новым — добор срабатывает', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        'Добор files_to_touch': '| `src/real.ts` | добавить проверку |',
        'ОБРАЗЕЦ': '| `src/does-not-exist.ts` | поправить валидацию |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('src/real.ts'), text);
    ok(!text.includes('does-not-exist'), 'выдуманный путь не должен остаться после добора');
  });

  it('files_to_touch: путь не существует, но помечен как новый файл — добор НЕ срабатывает', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    // Если бы добор всё же случился, провайдер отдал бы этот путь — тест ловит его в тексте,
    // не считая вызовы (значения объекта вычисляются сразу, а не по обращению к ключу).
    const result = await exec(
      fieldProvider({
        'Добор files_to_touch': '| `src/should-not-be-asked.ts` | х |',
        'ОБРАЗЕЦ': '| `src/new-module.ts` | создать новый модуль расчёта |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('src/new-module.ts'), text);
    ok(!text.includes('should-not-be-asked'), 'файл, явно помеченный новым, не должен провоцировать добор');
  });

  it('files_to_touch: путь реально существует на диске — добор НЕ срабатывает', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.ts'), 'export {};\n');
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        'Добор files_to_touch': '| `src/should-not-be-asked.ts` | х |',
        'ОБРАЗЕЦ': '| `src/real.ts` | добавить проверку |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(!text.includes('should-not-be-asked'), 'существующий путь не должен провоцировать добор');
  });

  it('files_to_touch: нумерованная таблица — путь ищется по ВСЕМ ячейкам строки, не только по первой (code-review-all, 2026-09-18)', async () => {
    // `filesToTouchInventedPaths` изначально брала `cells[0]` — на нумерованной таблице
    // это номер строки («1»), не путь, и проверка молча пропускала строку целиком. Тот же
    // класс регресса уже когда-то чинился в `extractFilesToTouch`/`pathFromRow`
    // (`planFiles.ts`, докстринг файла) — вторая копия наивного разбора вернула его назад.
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        'Добор files_to_touch': '| `src/real.ts` | добавить проверку |',
        'ОБРАЗЕЦ': '| 1 | `src/does-not-exist.ts` | поправить валидацию |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('src/real.ts'), text);
    ok(!text.includes('does-not-exist'), 'выдуманный путь в нумерованной строке должен был найтись и обменяться добором');
  });

  it('files_to_touch: мусор класса «не похоже на путь» не попадает в новую ветку добора', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const result = await exec(
      fieldProvider({
        'Добор files_to_touch': '| `src/should-not-be-asked.ts` | х |',
        'ОБРАЗЕЦ': '| `/sendNotification.*to,phone,text/` | х |',
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const text = readFileSync(artifact, 'utf8');
    ok(
      !text.includes('should-not-be-asked'),
      'явный не-путь (класс looksLikePath) — не предмет фикса 3, добор не должен реагировать',
    );
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

describe('метка корпуса T2 (`docs/model-tuning.md`): исход ответа на поле разметчик пишет рядом с сырым дампом', () => {
  it('принятый ответ поля помечается accepted: true', async () => {
    const { root, artifact } = setup();
    const rawPath = join(root, 'exchange.json');
    const provider: ChatProvider = {
      name: 'stub-with-raw-log',
      async chat() {
        return {
          text: 'Демо работает',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
          rawLogPath: rawPath,
        };
      },
    };
    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));
    ok(result.ok, result.note);
    const label = JSON.parse(readFileSync(`${rawPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(label, { accepted: true, oracle: 'form-field-checks', target: 'form-field', reason: 'accepted' });
  });

  it('пустой ответ помечается accepted: false, полем не считается', async () => {
    const { root, artifact } = setup();
    const rawPath = join(root, 'exchange-empty.json');
    const provider: ChatProvider = {
      name: 'stub-empty',
      async chat() {
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
          rawLogPath: rawPath,
        };
      },
    };
    const result = await exec(provider).run(request(root, artifact), hooks({ writes: [] }, true));
    strictEqual(result.ok, false);
    const label = JSON.parse(readFileSync(`${rawPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(label, { accepted: false, oracle: 'form-field-checks', target: 'form-field', reason: 'empty-or-placeholder' });
  });

  it('без rawLogPath (дамп выключен) исполнение поля не падает и метки не появляется', async () => {
    const { root, artifact } = setup();
    const result = await exec(
      fieldProvider({ 'что должно стать правдой': 'Демо работает', 'почему сейчас': 'Нужно к релизу' }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));
    strictEqual(result.ok, true, result.note);
  });

  it('files_to_touch: топ-ап переезжает на СВОЙ обмен — исходный дефицитный отмечен отказом, топ-ап принят', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const originalPath = join(root, 'original.json');
    const topupPath = join(root, 'topup.json');
    const result = await exec(
      fieldProviderTraced({
        'Добор files_to_touch': { text: '| `src/real.ts` | добавить проверку |', rawLogPath: topupPath },
        'ОБРАЗЕЦ': { text: '| `src/does-not-exist.ts` | поправить валидацию |', rawLogPath: originalPath },
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const originalLabel = JSON.parse(readFileSync(`${originalPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(originalLabel, {
      accepted: false,
      oracle: 'files-to-touch-paths',
      target: 'form-field',
      reason: 'invented-path',
    });
    const topupLabel = JSON.parse(readFileSync(`${topupPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(topupLabel, { accepted: true, oracle: 'files-to-touch-paths', target: 'form-field', reason: 'accepted' });
  });

  it('files_to_touch: топ-ап реально провалился (пуст) — метка остаётся отказом, а не «принят» (code-review-all, 2026-09-27)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const originalPath = join(root, 'original.json');
    const result = await exec(
      fieldProviderTraced({
        'Добор files_to_touch': { text: '', rawLogPath: join(root, 'topup.json') },
        'ОБРАЗЕЦ': { text: '| `src/does-not-exist.ts` | поправить валидацию |', rawLogPath: originalPath },
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    // Провалившийся добор не мешает записи артефакта: невалидный путь всё равно уходит в
    // текст как есть (`pathScope` политики на chunk — вот кто на самом деле его отклонит),
    // и это НЕ регрессия фикса. Регрессией было бы то, что до фикса `accepted: true` шло на
    // этот же обмен, потому что итоговая метка вообще не знала о `files_to_touch`.
    strictEqual(result.ok, true, result.note);
    const originalLabel = JSON.parse(readFileSync(`${originalPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(originalLabel, {
      accepted: false,
      oracle: 'files-to-touch-paths',
      target: 'form-field',
      reason: 'invented-path',
    });
  });

  it('приёмочный лист: добор закрыл минимум — исходный обмен и незакрывшая попытка отмечены отказом, последний топ-ап принят', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(
      artifact,
      ['## Приёмочный лист', '', '| id | что проверяем |', '|---|---|', '| ‹claim-N› | ‹проверка› |', ''].join('\n'),
    );
    const originalPath = join(root, 'original.json');
    const topupPath = join(root, 'topup.json');
    const result = await exec(
      fieldProviderTraced({
        'Добор приёмочного листа': {
          text: '| `claim-3 [edge]` | ещё случай |\n| `claim-4 [edge]` | четвёртый |',
          rawLogPath: topupPath,
        },
        'ОБРАЗЕЦ': {
          text: '| `claim-1 [edge]` | базовый случай |\n| `claim-2` | ещё один |',
          rawLogPath: originalPath,
        },
      }),
    ).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(result.ok, true, result.note);
    const originalLabel = JSON.parse(readFileSync(`${originalPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(originalLabel, {
      accepted: false,
      oracle: 'claims-minimum',
      target: 'form-field',
      reason: 'claims-below-minimum',
    });
    const topupLabel = JSON.parse(readFileSync(`${topupPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(topupLabel, { accepted: true, oracle: 'claims-minimum', target: 'form-field', reason: 'accepted' });
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

const execCompact = (provider: ChatProvider, stage: 'intent' | 'explore' | 'plan' = 'intent', preparationV2 = false): FormFillExecutor =>
  new FormFillExecutor({
    provider,
    maxResultBytes: 10_000,
    readRangeRequiredAboveBytes: 10_000,
    bashTimeoutMs: 1000,
    compact: true,
    stage,
    preparationV2,
  });

describe('режим compact: поля из схемы, ответ рисует applyFill', () => {
  it('даёт критичному отклонённому полю третий ограниченный шанс в preparation v2', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-third-retry-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Задача\n\n## Что делаем\n‹наблюдаемое изменение›\n');
    const answers = [
      'Обновляем существующую бронь, меняя слот.',
      'Изменяем существующий объект брони, чтобы назначить новый слот.',
      'Клиент может перенести бронь на другой слот, сохраняя её идентификатор и срок действия.',
    ];
    let calls = 0;
    const provider: ChatProvider = {
      name: 'local-spy',
      async chat() {
        const text = answers[calls++] ?? answers.at(-1)!;
        return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false }, finishReason: 'end_turn' as const };
      },
    } as unknown as ChatProvider;
    const runRequest = request(root, artifact, { prompt: { presetNote: null, system: '', user: 'Выбор способа зафиксируй в плане после исследования исходников.', tools: [], editedByOperator: false } });
    const result = await execCompact(provider, 'intent', true).run(runRequest, hooks({ writes: [] }, true));
    strictEqual(result.ok, true, result.note);
    strictEqual(calls, 3);
    ok(readFileSync(artifact, 'utf8').includes('Клиент может перенести'));
  });

  it('задаёт Ollama низкое reasoning и лимит по виду поля; поднимает лимит один раз при truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-local-params-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Задача\n\n- **Тема:** ‹тема›\n');
    const seen: (Record<string, unknown> | null | undefined)[] = [];
    let calls = 0;
    const provider: ChatProvider = {
      name: 'local-spy',
      async chat(req: ChatRequest) {
        seen.push(req.params);
        calls++;
        return {
          text: calls === 1 ? '{"тема":"дем' : '{"тема":"демо"}',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: calls === 1 ? 'max_tokens' as const : 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const warnings: string[] = [];
    const h = { ...hooks({ writes: [] }, true), onWarn: (warning: string) => warnings.push(warning) } as ExecHooks;
    const result = await execCompact(provider).run(request(root, artifact, { model: 'ollama:unit-test' }), h);
    strictEqual(result.ok, true);
    strictEqual(calls, 2);
    strictEqual(seen[0]?.['reasoning_effort'], 'none');
    strictEqual(seen[1]?.['reasoning_effort'], 'none');
    strictEqual(seen[0]?.['max_tokens'], 320);
    strictEqual(seen[1]?.['max_tokens'], 640);
    ok(warnings.some((warning) => warning.includes('обрезан')));
    ok(readFileSync(artifact, 'utf8').includes('демо'));
  });

  it('содержательное scalar-поле получает низкое reasoning и больший безопасный лимит', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-local-substantive-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Задача\n\n- **Зачем:** ‹почему›\n');
    let params: Record<string, unknown> | null | undefined;
    const provider: ChatProvider = {
      name: 'local-spy',
      async chat(req: ChatRequest) {
        params = req.params;
        return {
          text: '{"зачем":"Нужно включить расчёт налога"}', toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const result = await execCompact(provider).run(request(root, artifact, { model: 'ollama:unit-test' }), hooks({ writes: [] }, true));
    strictEqual(result.ok, true);
    strictEqual(params?.['reasoning_effort'], 'low');
    strictEqual(params?.['max_tokens'], 900);
  });

  it('LM Studio compact fills disable reasoning when the profile leaves it unset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-lmstudio-params-'));
    roots.push(root);
    const artifact = join(root, 'intent.md');
    writeFileSync(artifact, '# Task\n\n- **Topic:** \u2039topic\u203a\n');
    let params: Record<string, unknown> | null | undefined;
    const provider: ChatProvider = {
      name: 'lmstudio-spy',
      async chat(req: ChatRequest) {
        params = req.params;
        return {
          text: '{"topic":"demo"}', toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;
    const result = await execCompact(provider).run(request(root, artifact, { model: 'lmstudio:unit-test' }), hooks({ writes: [] }, true));
    strictEqual(result.ok, true);
    strictEqual(params?.['reasoning_effort'], 'none');
    strictEqual(params?.['max_tokens'], 320);
  });

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

  it('compact: JSON-конверт вместо значения — второй запрос несёт подсказку о прошлом отказе', async () => {
    const { root, artifact } = setupCompact();
    let branchCalls = 0;
    let secondCallPrompt = '';
    const provider: ChatProvider = {
      name: 'echo-then-fix',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (req.params?.['response_format'] !== undefined) {
          const ids = [...user.matchAll(/### Поле `([^`]+)`/g)].map((match) => match[1]!);
          if (ids.length === 0) {
            const singleId = /- id: `([^`]+)`/.exec(user)?.[1];
            if (singleId !== undefined) ids.push(singleId);
          }
          const grouped = Object.fromEntries(ids.map((id) => {
            if (!/ветка витка/i.test(id)) return [id, 'готово'];
            branchCalls++;
            const value = branchCalls === 1
              ? '{"tool":"Read","arguments":{"file_path":"./x.ts"}}'
              : 'sdlc/oversize';
            if (branchCalls > 1) secondCallPrompt = user;
            return [id, value];
          }));
          return {
            text: JSON.stringify(grouped),
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        if (user.includes('`ветка витка`')) {
          branchCalls++;
          if (branchCalls === 1) {
            return {
              text: '{"tool":"Read","arguments":{"file_path":"./x.ts"}}',
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
              finishReason: 'end_turn' as const,
            };
          }
          secondCallPrompt = user;
          return {
            text: 'sdlc/oversize',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(provider).run(request(root, artifact), hooks({ writes: [] }, true));

    strictEqual(branchCalls, 2, 'поле обязано быть переспрошено на втором проходе');
    ok(secondCallPrompt.includes('Прошлая попытка'), secondCallPrompt);
    ok(secondCallPrompt.includes('JSON-конверт'), secondCallPrompt);
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('sdlc/oversize'), text);
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

  it('compact: files_to_touch — выдуманный путь переспрашивается (до фикса эта проверка в compact вообще не исполнялась, code-review-all, 2026-09-18)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-compact-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'real.ts'), 'export {};\n');
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    let topUpCalls = 0;
    const provider: ChatProvider = {
      name: 'invented-then-fix',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (user.includes('Добор поля')) {
          topUpCalls++;
          return {
            text: '| `src/real.ts` | добавить проверку |',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        if (user.includes('`filestotouch`')) {
          return {
            text: '| `src/does-not-exist.ts` | поправить валидацию |',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
          };
        }
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(provider, 'plan').run(request(root, artifact, { maxTurns: 20 }), hooks({ writes: [] }, true));

    strictEqual(topUpCalls, 1, 'выдуманный путь обязан вызвать один добор');
    const text = readFileSync(artifact, 'utf8');
    ok(text.includes('src/real.ts'), text);
    ok(!text.includes('does-not-exist'), 'выдуманный путь не должен остаться в артефакте');
  });

  it('compact: метка корпуса T2 появляется у обычного поля (accepted: true, оракул apply-fill) — до фикса этот путь не размечал ничего (code-review-all, 2026-09-27)', async () => {
    const { root, artifact } = setupCompact();
    const rawPath = join(root, 'exchange.json');
    const provider: ChatProvider = {
      name: 'stub-compact-traced',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        return {
          text: user.includes('`ветка витка`') ? 'sdlc/oversize' : '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
          rawLogPath: user.includes('`ветка витка`') ? rawPath : null,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(provider).run(request(root, artifact), hooks({ writes: [] }, true));
    const label = JSON.parse(readFileSync(`${rawPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(label, { accepted: true, oracle: 'apply-fill', target: 'form-field', reason: 'accepted' });
  });

  it('compact: files_to_touch — метка переезжает на обмен топ-апа, исходный дефицитный отмечен отказом', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-form-compact-'));
    roots.push(root);
    const artifact = join(root, 'plan.md');
    writeFileSync(
      artifact,
      ['## files_to_touch', '', '| Путь | Что делаем |', '|---|---|', '| ‹path/to/file› | ‹что делаем› |', ''].join('\n'),
    );
    const originalPath = join(root, 'original.json');
    const topupPath = join(root, 'topup.json');
    const provider: ChatProvider = {
      name: 'invented-then-fix-traced',
      async chat(req: ChatRequest) {
        const user = req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
        if (user.includes('Добор поля')) {
          return {
            text: '| `src/real.ts` | добавить проверку |',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
            rawLogPath: topupPath,
          };
        }
        if (user.includes('`filestotouch`')) {
          return {
            text: '| `src/does-not-exist.ts` | поправить валидацию |',
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
            finishReason: 'end_turn' as const,
            rawLogPath: originalPath,
          };
        }
        return {
          text: '',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn' as const,
        };
      },
    } as unknown as ChatProvider;

    await execCompact(provider, 'plan').run(request(root, artifact, { maxTurns: 20 }), hooks({ writes: [] }, true));

    const originalLabel = JSON.parse(readFileSync(`${originalPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(originalLabel, {
      accepted: false,
      oracle: 'files-to-touch-paths',
      target: 'form-field',
      reason: 'invented-path',
    });
    const topupLabel = JSON.parse(readFileSync(`${topupPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(topupLabel, { accepted: true, oracle: 'apply-fill', target: 'form-field', reason: 'accepted' });
  });
});

describe('адаптивное заполнение формы', () => {
  it('отклоняет несуществующий файл в шаге плана, но принимает существующий исходник и новый тест', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-plan-file-guard-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'hold.ts'), 'export {};');
    const stepField = deriveSchema([
      '## Шаги',
      '### Шаг 1 — Реализовать изменение',
      '- **Файл:** ‹точный файл›',
    ].join('\n'), 'plan.template.md').fields[0]!;
    ok(planStepInventedFileCompact(stepField, 'clarification-report.md', root)?.includes('не существует'));
    strictEqual(planStepInventedFileCompact(stepField, 'src/hold.ts', root), null);
    strictEqual(planStepInventedFileCompact(stepField, 'test/hold.test.ts', root), null);
  });

  it('требует конкретные источники для сравнения подходов', () => {
    const field = deriveSchema('## Подход\n‹обоснуй›', 'plan.template.md').fields[0]!;
    ok(planApproachEvidenceProblem(field, 'Возврат нового объекта совместим с архитектурой и тестами.')?.includes('путь:символ'));
    const root = mkdtempSync(join(tmpdir(), 'sdlc-plan-approach-'));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'src', 'hold.ts'), 'export function makeHold() {}');
    writeFileSync(join(root, 'test', 'hold.test.ts'), 'test("does not mutate", () => {});');
    strictEqual(planApproachEvidenceProblem(field,
      'Выбранный: src/hold.ts:makeHold — значение;\nОтвергнутый: test/hold.test.ts:moveHold — мутация нарушает тест.', root), null);
    const grounding = 'src/hold.ts:source (L7): Hold — значение\ntest/hold.test.ts:не-мутирует-аргументы-и-возвращает-новый-объект (L39): тест контракта';
    strictEqual(planApproachEvidenceProblem(field,
      'Выбранный: src/hold.ts:source — значение\nОтвергнутый: test/hold.test.ts:не-мутирует-аргументы-и-возвращает-новый-объект — контрпример', root, grounding), null);
    ok(planApproachEvidenceProblem(field,
      'Выбранный: src/hold.ts:moveHold — новый объект\nОтвергнутый: test/hold.test.ts:claim-1 — мутация', root, grounding)?.includes('Цитируй точно из этого списка'));
    ok(planApproachEvidenceProblem(field,
      'Выбранный: возвращает новый объект — test/hold.test.ts:moveHold; отвергнутый: мутирует — test/hold.test.ts:moveHold', root)?.includes('два разных существующих файла'));
    ok(planApproachEvidenceProblem(field,
      'Выбранный: test/hold.test.ts:moveHold; отвергнутый: src/hold.test.ts:moveHold', root)?.includes('отсутствующие пути'));
    ok(planApproachEvidenceProblem(field,
      'Выбранный: изменить существующий объект и вернуть новый; src/hold.ts:Hold; test/hold.test.ts:moveHold\nОтвергнутый: другой способ; src/hold.ts:makeHold; test/hold.test.ts:Hold') !== null);
  });

  it('откладывает выбор реализации из Intent, если пользователь прямо оставил его для Plan', () => {
    const field = deriveSchema('## Что делаем\n‹поведение›', 'intent.template.md').fields[0]!;
    const prompt = 'Изучи исходники и зафиксируй выбор способа в плане после исследования.';
    ok(deferredIntentMethodProblem(field, 'Переносим бронь через изменение существующего объекта.', prompt)?.includes('Пользователь может'));
    ok(deferredIntentMethodProblem(field, 'Обновляем функцию так, чтобы она изменяла существующую бронь, обновляя её слот.', prompt)?.includes('Пользователь может'));
    ok(deferredIntentMethodProblem(field, 'Ветка витка: sdlc/two-right-answers', prompt)?.includes('метаданных'));
    strictEqual(deferredIntentMethodProblem(field, 'Перенос брони на другой слот без изменения идентификатора и срока действия, сохраняя старые значения id и expiresIso.', prompt), null);
    strictEqual(deferredIntentMethodProblem(field, 'Клиент может перенести бронь, сохранив её идентификатор.', prompt), null);
    strictEqual(deferredIntentMethodProblem(field, 'Изменить объект.', 'Перенести бронь на другой слот.'), null);
  });

  it('собирает ячейки одной оси последствий в один JSON-ответ', () => {
    const plan = [
      '## Последствия шагов',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '| Безопасность | ‹да/нет› | ‹файл:символ› | ‹claim-N / н/п — причина› |',
    ].join('\n');
    const fields = modelFields(deriveSchema(plan, 'plan.template.md'), 'plan');
    const groups = compactFieldGroups(fields);
    strictEqual(groups.length, 1, JSON.stringify(groups.map((group) => group.map((field) => ({ id: field.id, kind: field.kind, key: field.compactGroup, range: field.range, section: field.section, label: field.label }))), null, 2));
    strictEqual(groups[0]?.length, 3);
  });

  it('группирует только поля с явной меткой группы и отделяет решения повышенного риска', () => {
    const fields = deriveSchema([
      '# Задача',
      '## Базовые сведения',
      '- **Цель:** ‹цель›',
      '## Безопасность',
      '- **Контроль:** ‹если применимо, проверить доступ›',
      '## Продолжение',
      '- **Ветка:** ‹ветка›',
    ].join('\n'), 'intent.template.md').fields;
    fields[0]!.compactGroup = 'goal';
    fields[2]!.compactGroup = 'goal';
    const groups = compactFieldGroups(fields);
    deepStrictEqual(groups.map((group) => group.length), [2, 1]);
    deepStrictEqual(groups[0]!.map((field) => field.id), [fields[0]!.id, fields[2]!.id]);
    strictEqual(compactGroupResponseFormat(groups[0]!)['type'], 'json_schema');
    const choice = deriveSchema('# T\n## S\n- **Contour:** full / minor', 'intent.template.md').fields[0]!;
    const choiceFormat = compactGroupResponseFormat([choice]);
    const choiceSchema = (choiceFormat['json_schema'] as { schema: { properties: Record<string, { enum?: string[] }> } }).schema;
    deepStrictEqual(choiceSchema.properties[choice.id]?.enum, ['full', 'minor']);
  });

  it('принимает только полный JSON-объект с точным набором id полей', () => {
    const fields = deriveSchema('# T\n## S\n- **A:** ‹a›\n- **B:** ‹b›', 'intent.template.md').fields;
    fields.forEach((field) => { field.compactGroup = 'same'; });
    const group = compactFieldGroups(fields)[0]!;
    const good = Object.fromEntries(group.map((field, i) => [field.id, `value-${i}`]));
    deepStrictEqual(parseCompactGroupResponse(JSON.stringify(good), group), good);
    strictEqual(parseCompactGroupResponse(JSON.stringify({ [group[0]!.id]: 'one' }), group), null);
    strictEqual(parseCompactGroupResponse(JSON.stringify({ ...good, [group[1]!.id]: 2 }), group), null);
    strictEqual(parseCompactGroupResponse(JSON.stringify({ ...good, extra: 'x' }), group), null);
  });

  it('снимает условное необязательное поле только по явной пустой альтернативе и отсутствию риска', () => {
    const field = {
      section: 'Безопасность',
      hint: 'если применимо: доступ, секреты',
      emptyAlternative: 'н/п — нет изменения доступа или секретов',
    };
    strictEqual(conditionalFieldEmptyAlternative(field, 'Добавить сортировку каталога'), field.emptyAlternative);
    strictEqual(conditionalFieldEmptyAlternative(field, 'Добавить авторизацию пользователя'), null);
    strictEqual(conditionalFieldEmptyAlternative({ section: field.section, hint: field.hint }, 'обычная задача'), null);
  });
});

const basisJsonField = { id: 'основания и сценарии', label: null, placeholders: [{ text: '‹basis_json›' }] } as unknown as FormField;

it('basis schema pins one row per accepted claim ID and degrades safely without them', () => {
  const format = structuredClaimResponseFormat(basisJsonField, ['# Запрос\nстрока 2\nстрока 3'], ['claim-1', 'claim-2']) as {
    json_schema: { schema: { minItems: number; maxItems: number; items: { oneOf: { properties: { id: { const: string } } }[] } } };
  };
  strictEqual(format.json_schema.schema.minItems, 2);
  strictEqual(format.json_schema.schema.maxItems, 2);
  deepStrictEqual(format.json_schema.schema.items.oneOf.map((row) => row.properties.id.const), ['claim-1', 'claim-2']);
  const free = structuredClaimResponseFormat(basisJsonField, ['# Запрос']) as {
    json_schema: { schema: { minItems: number; maxItems: number; items: { oneOf?: unknown } } } };
  strictEqual(free.json_schema.schema.minItems, 1);
  strictEqual(free.json_schema.schema.maxItems, 24);
  strictEqual(free.json_schema.schema.items.oneOf, undefined, 'без списка claim-id — свободная схема');
  strictEqual(JSON.stringify(free).includes('"oneOf":[]'), false, 'пустой oneOf запрещён для Ollama');
});

it('многострочная цитата основания не ломает таблицу: корректный ответ проходит гейт (отказ r1)', () => {
  const requests = ['# Валидация покупателя\n\nСчета выставляются на данные из формы заказа как есть'];
  const acceptance = [
    { id: 'claim-1', behavior: 'Неизвестная зона даёт пустой результат', procedure: 'вызвать list с неизвестной зоной', expected: 'пустой список' },
    { id: 'claim-2', behavior: 'Известная зона фильтрует строки', procedure: 'вызвать list с зоной nord', expected: 'только строки зоны' },
  ];
  const answer = JSON.stringify(acceptance.map((row) => ({ id: row.id,
    basis: { file: 'request-1', lines: [1, 3] }, scenario: `сценарий ${row.id}\nс переносом`, counterexample: `контрпример ${row.id} | с чертой` })));
  const rendered = renderBasisReferences(basisJsonField, answer, requests)!;
  const rows = JSON.parse(rendered) as { basis: string; scenario: string; counterexample: string }[];
  strictEqual(rows[0]!.basis, 'request-1:L1-L3 «# Валидация покупателя Счета выставляются на данные из формы заказа как есть»');
  strictEqual(rows[0]!.scenario.includes('\n'), false);
  strictEqual(rows[0]!.counterexample.includes('|'), false);
  const intent = [
    '# Задача: фильтр', '## Коротко', 'Фильтрация списка.', '## Зачем', 'Убрать несовпадающие элементы.',
    '## Что делаем', 'Добавить фильтр.', '## Чего не делаем', 'Не менять формат результата.',
    '## Инварианты', 'Стабильный порядок элементов.',
    '## Приёмочный лист', '<!-- sdlc-json:acceptance:start -->', JSON.stringify(acceptance), '<!-- sdlc-json:acceptance:end -->',
    '## Основания и сценарии', '<!-- sdlc-json:basis:start -->', rendered, '<!-- sdlc-json:basis:end -->',
  ].join('\n');
  const normalized = normalizePreparationTables(intent);
  strictEqual(normalized.problem, null);
  strictEqual(normalized.text.split('\n').filter((line) => line.startsWith('| request-1:')).length, 2,
    'каждая строка основания остаётся одной строкой таблицы');
  strictEqual(requirementProblem(normalized.text), null);
});
