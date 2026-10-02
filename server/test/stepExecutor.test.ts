/**
 * Этап 5 по шагам плана (`StepExecutor`).
 *
 * Модель подставная — проверяется рантайм: новый файл пишется целиком, существующий —
 * блоками SEARCH/REPLACE через гейт; красная проверка после шага даёт ремонтный запрос с
 * текстом ошибки; отказ гейта окончателен; `БЕЗ ПРАВОК` помечает шаг ⏭; итог этапа
 * считается по шагам, а не по числу запросов; лимит ходов этапа действует.
 */

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import type { PlanStep } from '../src/artifacts/planSteps.ts';
import {
  StepExecutor,
  type StepCheck,
  mentionsFile,
  noChangeReason,
  parseFileContent,
  parseSearchReplace,
  plannedFunctionAddition,
  repairGuidance,
} from '../src/exec/StepExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';
import { git } from '../src/gates/git.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function step(over: Partial<PlanStep>): PlanStep {
  return {
    n: 1,
    title: 'шаг',
    file: 'src/a.ts',
    filePaths: ['src/a.ts'],
    isNew: false,
    symbol: null,
    isNewSymbol: false,
    action: 'сделать',
    claims: [],
    check: null,
    checkSpecified: false,
    expect: null,
    contractChange: null,
    contractSpecified: false,
    dependsOn: [],
    dependenciesSpecified: false,
    facts: null,
    explicit: true,
    ...over,
  };
}

/** Провайдер: по очереди отдаёт заготовленные ответы; помнит, что его спрашивали. */
function scripted(answers: string[]): ChatProvider & { asked: string[] } {
  const asked: string[] = [];
  return {
    name: 'stub',
    asked,
    async chat(req: ChatRequest) {
      asked.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
      const text = answers.shift() ?? 'БЕЗ ПРАВОК: ответы кончились';
      return {
        text,
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
        finishReason: 'end_turn' as const,
      };
    },
  } as unknown as ChatProvider & { asked: string[] };
}

function hooks(seen: { calls: NormalizedCall[]; warns: string[] }, allow = true): ExecHooks {
  return {
    onText: () => {},
    onThinking: () => {},
    onToolRequest: async (call: NormalizedCall) => {
      seen.calls.push(call);
      return allow
        ? { allowed: true, updatedInput: null, by: 'policy' as const }
        : { allowed: false, reason: 'вне files_to_touch', by: 'policy' as const };
    },
    onToolResult: () => {},
    onAskHuman: async () => ({}),
    onRecord: () => '',
    onUsage: () => {},
    onWarn: (m: string) => seen.warns.push(m),
    onFriction: () => {},
  } as unknown as ExecHooks;
}

function request(root: string, maxTurns = 10): ExecRequest {
  return {
    prompt: { presetNote: null, system: 'этап chunk', user: 'план', tools: [], editedByOperator: false },
    cwd: root,
    model: 'm',
    allowedTools: ['Read', 'Edit', 'Write'] as ToolName[],
    mcp: null,
    finishGuard: null,
    salvageFromText: null,
    readOnlyDirs: [],
    subagents: [],
    maxTurns,
    maxBudgetUsd: null,
    signal: new AbortController().signal,
  } as ExecRequest;
}

const A_TS = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';

function setup(content = A_TS): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-step-'));
  roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), content);
  return root;
}

type Check = ((s: PlanStep) => Promise<StepCheck>) | null;
const exec = (
  provider: ChatProvider,
  steps: PlanStep[],
  check: Check = async () => ({ status: 'ok' }),
  retryBrief: string | null = null,
  stepContext = false,
): StepExecutor =>
  new StepExecutor({
    provider,
    maxResultBytes: 12_000,
    readRangeRequiredAboveBytes: 120_000,
    bashTimeoutMs: 1000,
    stepContext,
    steps,
    planText: '# План\n\n## Шаги\n1. …',
    humanFacts: '## Факты от человека\n- ставка 90 %',
    retryBrief,
    check: check === null ? null : { name: 'Сборка', run: check },
  });

const SR = (oldStr: string, newStr: string): string =>
  `<<<<<<< SEARCH\n${oldStr}\n=======\n${newStr}\n>>>>>>> REPLACE`;

describe('разбор ответов шага', () => {
  it('SEARCH/REPLACE: несколько блоков, пустой REPLACE — удаление, пустой SEARCH — мимо', () => {
    const text = ['вот правки:', SR('  return a + b;', '  return a + b + 1;'), SR('лишняя строка', ''), SR('', 'x')].join('\n');
    deepStrictEqual(parseSearchReplace(text), [
      { oldStr: '  return a + b;', newStr: '  return a + b + 1;' },
      { oldStr: 'лишняя строка', newStr: '' },
    ]);
  });

  it('строка из знаков «=» внутри содержимого разделителем не считается', () => {
    const text = SR('// ==========\nconst x = 1;', '// ==========\nconst x = 2;');
    deepStrictEqual(parseSearchReplace(text), [
      { oldStr: '// ==========\nconst x = 1;', newStr: '// ==========\nconst x = 2;' },
    ]);
  });

  it('содержимое нового файла — первый fenced-блок с учётом вложенности; проза без fence — не файл', () => {
    strictEqual(parseFileContent('```ts\nconst a = 1;\n```\n\n```\nx\n```'), 'const a = 1;\n');
    strictEqual(parseFileContent('```md\n# Doc\n\n```ts\nconst a = 1;\n```\n\nafter\n```'), '# Doc\n\n```ts\nconst a = 1;\n```\n\nafter\n');
    strictEqual(parseFileContent('Вот файл: const a = 1;'), null);
    strictEqual(parseFileContent('const a = 1;\nconst b = 2;'), 'const a = 1;\nconst b = 2;\n');
  });

  it('«БЕЗ ПРАВОК: причина» — только когда это весь ответ', () => {
    strictEqual(noChangeReason('БЕЗ ПРАВОК: уже сделано'), 'уже сделано');
    strictEqual(noChangeReason('```\nБЕЗ ПРАВОК: требует решения человека: ставка\n```'), 'требует решения человека: ставка');
    strictEqual(noChangeReason(`${SR('x', 'y')}\nБЕЗ ПРАВОК: для второго символа`), null);
  });

  // Реальные ответы `omnicoder-9b`/`agents-a1-4b` под stepFill, 2026-09-03
  // (docs/model-runs.md) — маркер построен верно, но с хвостовым текстом на той же
  // строке. Терпимость добавлена намеренно: см. комментарий у парсера.
  it('маркер с хвостовым текстом на строке всё равно распознаётся (близкий промах формата)', () => {
    const text = [
      '```',
      '<<<<<<< SEARCH SEARCH: src/oversize.ts',
      '  return a + b;',
      '======= SEARCH: src/oversize.ts',
      '  return a + b + 1;',
      '>>>>>>> REPLACE',
      '```',
    ].join('\n');
    deepStrictEqual(parseSearchReplace(text), [{ oldStr: '  return a + b;', newStr: '  return a + b + 1;' }]);
  });

  it('но выдуманный формат без настоящих маркеров парсер не спасает', () => {
    const text = 'SEARCH: `  return a + b;`\nREPLACE: `  return a + b + 1;`\n\nПояснение вокруг.';
    deepStrictEqual(parseSearchReplace(text), []);
  });

  it('вложенные и незакрытые маркеры никогда не попадают в содержимое замены', () => {
    const nested = [
      '<<<<<<< SEARCH',
      'outer old',
      '=======',
      'outer new',
      '<<<<<<< SEARCH',
      'inner old',
      '=======',
      'inner new',
      '>>>>>>> REPLACE',
    ].join('\n');
    deepStrictEqual(parseSearchReplace(nested), [{ oldStr: 'inner old', newStr: 'inner new' }]);
    deepStrictEqual(parseSearchReplace('<<<<<<< SEARCH\nold\n=======\nnew'), []);
  });

  it('принимает только полный многострочный fenced-вариант SEARCH/REPLACE', () => {
    const answer = ['SEARCH:', '```ts', 'const old = 1;', '```', '', 'REPLACE:', '```ts', 'const next = 2;', '```'].join('\n');
    deepStrictEqual(parseSearchReplace(answer), [{ oldStr: 'const old = 1;', newStr: 'const next = 2;' }]);
    deepStrictEqual(parseSearchReplace('SEARCH: `const old = 1;`\nREPLACE: `const next = 2;`'), []);
  });
});

describe('planned function addition recovery', () => {
  it('converts a single planned function code block into a minimal append edit', () => {
    const current = 'export function isActive() {\n  return true;\n}\n';
    const answer = [
      '```typescript',
      '// src/hold.ts',
      'export function moveHold(hold: Hold, newSlot: Slot): Hold { return { ...hold, slot: newSlot }; }',
      '```',
      '',
      '```typescript',
      '// test/moveHold.test.ts',
      "describe('moveHold', () => {});",
      '```',
    ].join('\n');
    deepStrictEqual(plannedFunctionAddition(step({
      title: 'Implement moveHold', symbol: 'moveHold', isNewSymbol: true,
      action: 'Add function moveHold',
    }), current, answer), {
      oldStr: '}',
      newStr: '}\n\nexport function moveHold(hold: Hold, newSlot: Slot): Hold { return { ...hold, slot: newSlot }; }',
    });
  });

  it('rejects unplanned, already implemented, and ambiguous function output', () => {
    const current = 'export function isActive() {\n  return true;\n}\n';
    const answer = '```ts\nexport function moveHold() { return {}; }\n```';
    strictEqual(plannedFunctionAddition(step({ symbol: 'moveHold' }), current, answer), null);
    strictEqual(plannedFunctionAddition(step({ symbol: 'isActive', isNewSymbol: true, action: 'Add isActive' }), current, answer), null);
    strictEqual(plannedFunctionAddition(step({ symbol: 'moveHold', isNewSymbol: true, action: 'Add moveHold' }), current, `${answer}\n${answer}`), null);
  });
});

describe('исполнение по шагам', () => {
  it('новый файл пишется целиком через гейт, существующий — блоками замены', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['```ts\nexport const K = 90;\n```', SR('  return a + b;', '  return a + b + K;')]);
    const r = await exec(provider, [step({ n: 1, file: 'src/k.ts', isNew: true }), step({ n: 2, file: 'src/a.ts' })]).run(
      request(root),
      hooks(seen),
    );
    ok(r.ok, r.note);
    strictEqual(readFileSync(join(root, 'src/k.ts'), 'utf8'), 'export const K = 90;\n');
    ok(readFileSync(join(root, 'src/a.ts'), 'utf8').includes('a + b + K'));
    deepStrictEqual(seen.calls.map((c) => c.kind), ['write', 'edit']);
    ok(r.finalText.includes('✅ 1) src/k.ts'), r.finalText);
    ok(provider.asked[0]!.includes('ставка 90 %'));
    ok(provider.asked[0]!.includes('После этого шага будут изменены: `src/a.ts`'));
    ok(provider.asked[0]!.includes('не отказывайся из-за того, что будущий файл ещё не изменён'));
    ok(provider.asked[1]!.includes('<<<<<<< SEARCH'));
  });

  it('бриф ретрая доезжает до карточки шага, вместе с подсказкой про уже сделанное (r34)', async () => {
    // Живой прогон 2026-09-03: на попытке с брифом ретрая модель ответила пустым
    // REPLACE на строку, которая уже была верна с прошлой попытки, — стёрла то, что
    // сама же добавила раньше. Подсказка должна появляться ИМЕННО когда есть бриф
    // (иначе на первой попытке она вводит в заблуждение — прошлой попытки не было).
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['БЕЗ ПРАВОК: нечего']);
    await exec(provider, [step({})], null, '## Что не сошлось в прошлой попытке\n- claim-2 — опровергнут').run(request(root), hooks(seen));
    ok(provider.asked[0]!.includes('claim-2 — опровергнут'));
    ok(provider.asked[0]!.includes('БЕЗ ПРАВОК: уже сделано'), provider.asked[0]);
  });

  it('без брифа ретрая (первая попытка) подсказки про «уже сделано» нет', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return a + b + 1;')]);
    await exec(provider, [step({})]).run(request(root), hooks(seen));
    ok(!provider.asked[0]!.includes('уже сделано'), provider.asked[0]);
  });

  it('один неоднозначный блок не топит остальные — применяются все однозначные, ремонт не нужен', async () => {
    // 2026-09-25 (`d2-devstral-vat-rounding`, попытка 2, запрос `00021`): модель верно
    // убрала импорт типа и три аннотации блоками SEARCH/REPLACE, но один из шести блоков
    // совпадал в файле трижды — раньше это отклоняло ВСЕ шесть правок разом.
    const root = setup('const x = 1;\nconst dup = 1;\nconst dup = 1;\nconst y = 2;\n');
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const answer = [
      SR('const x = 1;', 'const x = 10;'),
      SR('const dup = 1;', 'const dup = 9;'), // встречается дважды — неоднозначно, пропускается
      SR('const y = 2;', 'const y = 20;'),
    ].join('\n');
    const provider = scripted([answer]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    strictEqual(provider.asked.length, 1, 'однозначных блоков хватило — ремонтный раунд не понадобился');
    strictEqual(readFileSync(join(root, 'src/a.ts'), 'utf8'), 'const x = 10;\nconst dup = 1;\nconst dup = 1;\nconst y = 20;\n');
  });

  it('ни один блок не применился чисто — прежнее поведение: реальный Edit решает сам (с мягким совпадением)', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    // Оба блока — не найденные фрагменты: keep пуст, значит уходят ВСЕ блоки как раньше,
    // и настоящий текст ошибки Edit'а (не моя грубая прикидка) доходит до модели.
    const answer = [SR('такого текста нет', 'x'), SR('и этого тоже нет', 'y')].join('\n');
    const provider = scripted([answer, 'БЕЗ ПРАВОК: не нашла место правки']);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(provider.asked[1]!.includes('фрагмент не найден'), provider.asked[1]);
  });

  it('диагноз гейта не теряется, когда следующая правка не применяется (checkProblem и applyProblem — раздельные блоки)', async () => {
    // 2026-09-25: модель починила SyntaxError по его тексту верно на первом ремонте, но
    // правка не легла из-за неоднозначного блока — следующий ремонт уже не нёс текста
    // исходной ошибки (общая переменная затирала диагноз гейта диагнозом применения), и
    // починка съехала мимо.
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([
      SR('  return a + b;', '  return a + b + 1;'), // раунд 0: применяется, гейт краснеет
      SR('текста, которого нет в файле', 'неважно'), // раунд 1: не применяется
      'БЕЗ ПРАВОК: нужный фрагмент вне показанной части файла', // раунд 2
    ]);
    let checks = 0;
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => {
      checks++;
      return { status: 'failed', problem: 'src/a.ts: ОРИГИНАЛЬНАЯ_ПРИЧИНА гейт «Тесты» красный на SyntaxError' };
    }).run(request(root), hooks(seen));
    strictEqual(checks, 1, 'check зовётся только после успешного apply — во втором раунде apply не удался');
    ok(provider.asked[1]!.includes('ОРИГИНАЛЬНАЯ_ПРИЧИНА'), provider.asked[1]);
    ok(!provider.asked[1]!.includes('Твоя правка не применилась'), provider.asked[1]);
    ok(provider.asked[2]!.includes('ОРИГИНАЛЬНАЯ_ПРИЧИНА'), provider.asked[2]);
    ok(provider.asked[2]!.includes('фрагмент не найден'), provider.asked[2]);
    ok(provider.asked[2]!.includes('Твоя правка не применилась'), provider.asked[2]);
  });

  it('промах SEARCH даёт ремонтный запрос с содержимым файла; второй ответ применяется', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a - b;', '  return 0;'), SR('  return a + b;', '  return 0;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    strictEqual(provider.asked.length, 2);
    // Ремонтный запрос — тоже обращение к модели; ходов цикла у исполнителя по шагам нет.
    strictEqual(r.modelRequests, 2);
    strictEqual(r.turns, undefined);
    ok(provider.asked[1]!.includes('фрагмент не найден'), provider.asked[1]);
    ok(readFileSync(join(root, 'src/a.ts'), 'utf8').includes('return 0;'));
  });

  it('пишет положительную метку корпуса только после механической проверки шага', async () => {
    const root = setup();
    const rawPath = join(root, 'exchange.json');
    const provider: ChatProvider = {
      name: 'stub-with-raw-log',
      async chat() {
        return {
          text: SR('  return a + b;', '  return a + b + 1;'),
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: 'end_turn',
          rawLogPath: rawPath,
        };
      },
    };
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const result = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({ status: 'ok' })).run(
      request(root),
      hooks(seen),
    );

    ok(result.ok, result.note);
    const label = JSON.parse(readFileSync(`${rawPath}.label.json`, 'utf8')) as Record<string, unknown>;
    deepStrictEqual(label, {
      accepted: true,
      oracle: 'gate:Сборка',
      target: 'plan-step',
      reason: 'check-passed',
    });
  });

  it('новый файл с красной проверкой чинится блоками замены, а не файлом целиком', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['```ts\nexport const K = 9;\n```', SR('export const K = 9;', 'export const K = 90;')]);
    let checks = 0;
    const r = await exec(provider, [step({ file: 'src/k.ts', isNew: true })], async () => {
      checks++;
      return checks === 1 ? { status: 'failed', problem: 'k.ts: K должно быть 90' } : { status: 'ok' };
    }).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    ok(provider.asked[1]!.includes('Файл теперь существует'), provider.asked[1]);
    strictEqual(readFileSync(join(root, 'src/k.ts'), 'utf8'), 'export const K = 90;\n');
  });

  it('трижды красная проверка по этому файлу — шаг ❌, но этап без единой правки красный, а с правкой — нет', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    let checks = 0;
    const provider = scripted([
      SR('  return a + b;', '  return a + b + 1;'),
      SR('  return a + b + 1;', '  return a + b + 2;'),
      SR('  return a + b + 2;', '  return a + b + 3;'),
    ]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => {
      checks++;
      return { status: 'failed', problem: `a.ts: гейт «Сборка» красный, попытка ${checks}` };
    }).run(request(root), hooks(seen));
    // Единственный шаг красный и ни один не применён — этап красный.
    strictEqual(r.ok, false);
    strictEqual(checks, 3);
    ok(provider.asked[1]!.includes('попытка 1'));
    ok(r.finalText.includes('❌'), r.finalText);
  });

  it('пустой ответ при обрезке по длине токенов получает целевой совет, а не общее «нет блоков»', async () => {
    // Живые прогоны 2026-09-03 (`omnicoder-9b`/`agents-a1-4b`, docs/model-runs.md):
    // 9–13 тысяч токенов на выходе и пустой финальный текст — модель тратит весь бюджет
    // на рассуждение, не успевая дойти до блоков замены. Сообщение обязано назвать
    // ИМЕННО эту причину, а не «Ответь блоками замены по формату» (подразумевает
    // незнание формата).
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const answers: { text: string; finishReason: 'max_tokens' | 'end_turn' }[] = [
      { text: '', finishReason: 'max_tokens' },
      { text: SR('  return a + b;', '  return a + b + 1;'), finishReason: 'end_turn' },
    ];
    const asked: string[] = [];
    const provider: ChatProvider = {
      name: 'stub-truncated',
      async chat(req: ChatRequest) {
        asked.push(req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '');
        const a = answers.shift()!;
        return {
          text: a.text,
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 12000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false },
          finishReason: a.finishReason,
        };
      },
    };
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    ok(asked[1]!.includes('обрезан лимитом длины'), asked[1]);
    ok(!asked[1]!.includes('Ответь блоками замены по формату'), asked[1]);
  });

  it('красный шаг рядом с применённым этап не роняет — красноту судит этап 6', async () => {
    // Красный шаг — дерево с красным тестом; в обычном цикле такое дерево уходит рецензенту,
    // и брифом на следующую попытку модель чинит то, что он назвал. Правило «красный шаг =
    // провал этапа» останавливало виток без вердикта при дереве, зелёном по эталону.
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([
      SR('  return a + b;', '  return a + b + 1;'),
      'export const два = 2;\n',
      'export const два = 3;\n',
      'export const два = 4;\n',
    ]);
    const r = await exec(provider, [step({ file: 'src/a.ts' }), step({ file: 'src/new.ts' })], async (s) =>
      s.file === 'src/new.ts' ? { status: 'failed', problem: 'new.ts: гейт «Сборка» красный' } : { status: 'ok' },
    ).run(request(root), hooks(seen));
    strictEqual(r.ok, true);
    ok(r.note.includes('применено 1'), r.note);
    ok(r.note.includes('красных 1'), r.note);
    ok(r.note.includes('на суд этапа 6'), r.note);
    ok(r.finalText.includes('❌'), r.finalText);
  });

  it('красная сборка вне файла шага ремонта не вызывает — шаг ✅ с пометкой', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return a + b + 1;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({
      status: 'failed',
      problem: 'src/other.ts(3,1): нет экспорта',
    })).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    strictEqual(provider.asked.length, 1);
    ok(r.finalText.includes('вне этого файла'), r.finalText);
  });

  it('несостоявшаяся проверка называется в отчёте, а не считается зелёной молча', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return a + b + 1;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({ status: 'skipped', note: 'нет tsc' })).run(
      request(root),
      hooks(seen),
    );
    strictEqual(r.ok, false, 'применённая, но непроверенная правка не закрывает шаг');
    ok(r.finalText.includes('проверка после шага не состоялась: нет tsc'), r.finalText);
    ok(r.finalText.includes('⏭'), r.finalText);
  });

  it('отсутствие проверки получает ⏭ и не закрывает шаг', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return a + b + 1;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], null).run(request(root), hooks(seen));
    strictEqual(r.ok, false);
    ok(r.finalText.includes('⏭'), r.finalText);
    ok(r.finalText.includes('нет включённого build/test-гейта'), r.finalText);
  });

  it('подписанная неприменимость прозрачна и не считается зелёной проверкой', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return a + b + 1;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({
      status: 'inapplicable',
      reason: 'шаг меняет только документацию',
      approvedBy: 'Иванов',
      approvedAt: '2026-09-30',
    })).run(request(root), hooks(seen));
    strictEqual(r.ok, false, 'неприменимость записана, но проверка не дала зелёного результата');
    ok(r.finalText.includes('⏭'), r.finalText);
    ok(r.finalText.includes('подтвердил Иванов, 2026-09-30'), r.finalText);
  });

  it('неполная подпись неприменимости превращает шаг в красный', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([
      SR('  return a + b;', '  return a + b + 1;'),
      SR('  return a + b + 1;', '  return a + b + 2;'),
      SR('  return a + b + 2;', '  return a + b + 3;'),
    ]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({
      status: 'inapplicable',
      reason: '  ',
      approvedBy: '',
      approvedAt: 'вчера',
    })).run(request(root), hooks(seen));
    strictEqual(r.ok, false);
    ok(r.finalText.includes('❌'), r.finalText);
    ok(r.finalText.includes('требует причины, имени утвердившего и даты YYYY-MM-DD'), r.finalText);
  });

  it('отказ гейта окончателен: ремонта нет, шаг ❌', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return 1;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen, false));
    strictEqual(r.ok, false);
    strictEqual(provider.asked.length, 1);
    ok(r.finalText.includes('запись отклонена'), r.finalText);
    ok(!readFileSync(join(root, 'src/a.ts'), 'utf8').includes('return 1;'));
  });

  it('SEARCH на весь файл отклоняется как переписывание', async () => {
    const LONG = `${A_TS}\nexport const ONE = 1;\nexport const TWO = 2;\nexport const THREE = 3;\nexport const FOUR = 4;\nexport const FIVE = 5;\n`;
    const root = setup(LONG);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR(LONG.trimEnd(), 'export const x = 1;'), SR('  return a + b;', '  return a - b;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    ok(provider.asked[1]!.includes('покрывает файл целиком'), provider.asked[1]);
    ok(readFileSync(join(root, 'src/a.ts'), 'utf8').includes('a - b'));
  });

  it('файл, которого нет в HEAD (создан этим chunk\'ом), переписывать целиком можно', async () => {
    // Рецензент велел «переписать свой тест через priceFor», модель принесла файл целиком,
    // гард отказал трижды — конфликт по построению: охрана нужна файлу, существовавшему ДО
    // chunk'а, а не тому, что создан в попытке 1 (bench, stepfill-v2).
    // Длиннее WHOLE_FILE_MIN_LINES — иначе охрана не действует и без git.
    const longA = ['export function add(a: number, b: number) {', '  return a + b;', '}', 'export function sub(a: number, b: number) {', '  return a - b;', '}', 'export const one = 1;', ''].join('\n');
    const root = setup(longA);
    await git(['init', '--initial-branch=main'], root);
    await git(['config', 'user.name', 'т'], root);
    await git(['config', 'user.email', 't@example.invalid'], root);
    await git(['add', '-A'], root);
    await git(['commit', '-m', 'база'], root);
    const fresh = ['export function t1() {', '  return 1;', '}', 'export function t2() {', '  return 2;', '}', 'export function t3() {', '  return 3;', '}', ''].join('\n');
    writeFileSync(join(root, 'src/fresh.ts'), fresh);
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR(fresh.trimEnd(), 'export const переписан = true;')]);
    const r = await exec(provider, [step({ file: 'src/fresh.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.finalText);
    ok(readFileSync(join(root, 'src/fresh.ts'), 'utf8').includes('переписан'));

    // Тот же приём на файле из HEAD по-прежнему отклоняется.
    const kept = scripted([SR(longA.trimEnd(), 'export const x = 1;'), SR(longA.trimEnd(), 'export const x = 1;'), SR(longA.trimEnd(), 'export const x = 1;')]);
    const r2 = await exec(kept, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    strictEqual(r2.ok, false);
    ok(r2.finalText.includes('❌'), r2.finalText);
    ok(!readFileSync(join(root, 'src/a.ts'), 'utf8').includes('export const x = 1;'));
  });

  it('дословно повторённый ответ в ремонтном раунде останавливает шаг сразу', async () => {
    // Третий раунд с тем же текстом стоил бы ещё один полный файл в контексте и ту же
    // проверку — модель замечание не слышит.
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const same = SR('  return a + b;', '  return a + b + 1;');
    const provider = scripted([same, same, same]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })], async () => ({ status: 'failed', problem: 'a.ts: красная' })).run(
      request(root),
      hooks(seen),
    );
    strictEqual(r.ok, false);
    strictEqual(provider.asked.length, 2, 'после второго одинакового ответа третьего запроса нет');
    ok(r.finalText.includes('повторён дословно'), r.finalText);
  });

  it('файл с CRLF получает правку в CRLF', async () => {
    const root = setup(A_TS.replace(/\n/g, '\r\n'));
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('export function add(a: number, b: number) {\n  return a + b;', 'export function add(a: number, b: number) {\n  return a * b;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    ok(readFileSync(join(root, 'src/a.ts'), 'utf8').includes('  return a * b;\r\n'));
  });

  it('«БЕЗ ПРАВОК» помечает шаг ⏭; этап без единой правки красный', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['БЕЗ ПРАВОК: уже реализовано в add']);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    strictEqual(r.ok, false);
    strictEqual(seen.calls.length, 0);
    ok(r.finalText.includes('⏭'), r.finalText);
    ok(r.note.includes('ни один шаг не дал правки'), r.note);
  });

  it('лимит ходов этапа обрывает исполнение с той же нотой, что у цикла', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a + b;', '  return 1;'), SR('  return 1;', '  return 2;')]);
    const r = await exec(provider, [step({ n: 1, file: 'src/a.ts' }), step({ n: 2, file: 'src/a.ts' })]).run(
      request(root, 1),
      hooks(seen),
    );
    strictEqual(r.ok, false);
    ok(/исчерпан лимит ходов этапа \(1\)/.test(r.note), r.note);
    strictEqual(provider.asked.length, 1);
  });

  it('путь наружу в контекст не читается: файл считается новым, а запись решает гейт', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['```\nx\ny\n```']);
    await exec(provider, [step({ file: '../outside.ts' })]).run(request(root), hooks(seen, false));
    ok(provider.asked[0]!.includes('(новый)'));
    ok(!provider.asked[0]!.includes('Текущее содержимое'));
  });
});

describe('stepContext (ModelDef.stepContext)', () => {
  it('явный opt-out: `buildStepContext` не подмешивается в промпт шага', async () => {
    const root = setup();
    writeFileSync(join(root, 'src/b.ts'), 'export function helper(): void {}\n');
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['БЕЗ ПРАВОК: уже реализовано']);
    await exec(provider, [step({ file: 'src/a.ts' })], null, null, false).run(request(root), hooks(seen));
    ok(!provider.asked[0]!.includes('## Контекст проекта для этого шага'), provider.asked[0]);
  });

  it('включён явно: карта экспортов проекта попадает в промпт шага', async () => {
    const root = setup();
    writeFileSync(join(root, 'src/b.ts'), 'export function helper(): void {}\n');
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['БЕЗ ПРАВОК: уже реализовано']);
    await exec(provider, [step({ file: 'src/a.ts' })], null, null, true).run(request(root), hooks(seen));
    ok(provider.asked[0]!.includes('## Контекст проекта для этого шага'), provider.asked[0]);
    ok(provider.asked[0]!.includes('src/b.ts'), provider.asked[0]);
  });
});

describe('mentionsFile', () => {
  it('явное место падения побеждает — своя строка возвращает true сразу, без substring-фолбэка', () => {
    // Живой текст (сокращённый) d2-devstral-vat-rounding, попытка 3: ошибка называет и
    // файл, где падает (test/vat.test.ts:4), и модуль, на который ссылается импорт
    // ('../src/lines.ts').
    const problem = [
      'гейт «Тесты» (node --test, код 1): 1 fail',
      'file:///C:/ws/test/vat.test.ts:4',
      'import { Line } from "../src/lines.ts";',
      "SyntaxError: The requested module '../src/lines.ts' does not provide an export named 'Line'",
      '✖ test\\vat.test.ts (166.0493ms)',
    ].join('\n');
    ok(mentionsFile(problem, 'test/vat.test.ts'));
  });

  it('места падения нашлись, но НЕ про этот файл — substring-фолбэк всё равно проверяется (code-review-all, 2026-09-26)', () => {
    // Прежняя версия при locations.length>0 возвращала false сразу, не пробуя substring —
    // и легитимный кадр file:/// из ЧУЖОГО места (например зависимости) гасил substring-
    // совпадение реального своего пути в тексте. Здесь `src/lines.ts` в местах падения не
    // числится (только `test/vat.test.ts`), но упомянут подстрокой в тексте импорта —
    // теперь тоже true: лучше лишний ремонт-раунд не туда, чем полная слепота своего файла.
    const problem = [
      'гейт «Тесты» (node --test, код 1): 1 fail',
      'file:///C:/ws/test/vat.test.ts:4',
      'import { Line } from "../src/lines.ts";',
      "SyntaxError: The requested module '../src/lines.ts' does not provide an export named 'Line'",
      '✖ test\\vat.test.ts (166.0493ms)',
    ].join('\n');
    ok(mentionsFile(problem, 'src/lines.ts'));
  });

  it('мест падения нет — прежнее правило: полный путь, иначе basename со своим каталогом', () => {
    ok(mentionsFile('src/other.ts(3,1): нет экспорта', 'src/other.ts'));
    // basename совпадает, но каталог перед ним — чужой (два разных index.ts).
    strictEqual(mentionsFile('server/src/tools/index.ts(5,1): ошибка', 'server/src/exec/index.ts'), false);
    // basename без всякого пути перед ним — второго кандидата в тексте нет, считается своим.
    ok(mentionsFile('index.ts(5,1): ошибка', 'server/src/exec/index.ts'));
  });
});

describe('repairGuidance', () => {
  it('объясняет необъявленный параметр и необъявленный импорт', () => {
    for (const name of ['opts', 'calculateVat']) {
      const hints = repairGuidance(`ReferenceError: ${name} is not defined`, '');
      ok(hints.join('\n').includes(name));
      ok(hints.join('\n').includes('параметр функции'));
      ok(hints.join('\n').includes('импорт'));
    }
  });
  it('показывает все текущие объявления повторённого идентификатора', () => {
    const hints = repairGuidance(
      "SyntaxError: Identifier 'sub' has already been declared",
      'const sub = subtotal(lines);\nconst invoice = {};\nconst sub = subtotal(lines);\n',
    );
    strictEqual(hints.length, 1);
    match(hints[0]!, /не добавляй ещё одно/);
    match(hints[0]!, /1: const sub/);
    match(hints[0]!, /3: const sub/);
  });

  it('даёт отдельные ограничения для ESM и отсутствующего экспорта', () => {
    const hints = repairGuidance(
      "require is not defined; module does not provide an export named 'Money'",
      null,
    );
    ok(hints.some((hint) => hint.includes('ESM')));
    ok(hints.some((hint) => hint.includes('Money')));
  });

  it('показывает строки вокруг позиции синтаксической ошибки', () => {
    const hints = repairGuidance(
      'file:///C:/work/src/a.ts:3\nSyntaxError: Expression expected',
      'export function a() {\n  return 1;\n}\n}\n',
    );
    ok(hints.some((hint) => hint.includes('строки 3') && hint.includes('4: }')));
  });
});
