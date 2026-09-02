/**
 * Этап 5 по шагам плана (`StepExecutor`).
 *
 * Модель подставная — проверяется рантайм: новый файл пишется целиком, существующий —
 * блоками SEARCH/REPLACE через гейт; красная проверка после шага даёт ремонтный запрос с
 * текстом ошибки; отказ гейта окончателен; `БЕЗ ПРАВОК` помечает шаг ⏭; итог этапа
 * считается по шагам, а не по числу запросов; лимит ходов этапа действует.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, ToolName } from '@sdlc-runner/shared';

import type { PlanStep } from '../src/artifacts/planSteps.ts';
import {
  StepExecutor,
  type StepCheck,
  noChangeReason,
  parseFileContent,
  parseSearchReplace,
} from '../src/exec/StepExecutor.ts';
import type { ExecHooks, ExecRequest } from '../src/exec/StageExecutor.ts';
import type { ChatProvider, ChatRequest } from '../src/provider/ChatProvider.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function step(over: Partial<PlanStep>): PlanStep {
  return {
    n: 1,
    title: 'шаг',
    file: 'src/a.ts',
    isNew: false,
    symbol: null,
    action: 'сделать',
    claims: [],
    check: null,
    expect: null,
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
const exec = (provider: ChatProvider, steps: PlanStep[], check: Check = null, retryBrief: string | null = null): StepExecutor =>
  new StepExecutor({
    provider,
    maxResultBytes: 12_000,
    readRangeRequiredAboveBytes: 120_000,
    bashTimeoutMs: 1000,
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
    ok(provider.asked[1]!.includes('<<<<<<< SEARCH'));
  });

  it('бриф ретрая доезжает до карточки шага', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted(['БЕЗ ПРАВОК: нечего']);
    await exec(provider, [step({})], null, '## Что не сошлось в прошлой попытке\n- claim-2 — опровергнут').run(request(root), hooks(seen));
    ok(provider.asked[0]!.includes('claim-2 — опровергнут'));
  });

  it('промах SEARCH даёт ремонтный запрос с содержимым файла; второй ответ применяется', async () => {
    const root = setup();
    const seen = { calls: [] as NormalizedCall[], warns: [] as string[] };
    const provider = scripted([SR('  return a - b;', '  return 0;'), SR('  return a + b;', '  return 0;')]);
    const r = await exec(provider, [step({ file: 'src/a.ts' })]).run(request(root), hooks(seen));
    ok(r.ok, r.note);
    strictEqual(provider.asked.length, 2);
    ok(provider.asked[1]!.includes('фрагмент не найден'), provider.asked[1]);
    ok(readFileSync(join(root, 'src/a.ts'), 'utf8').includes('return 0;'));
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

  it('трижды красная проверка по этому файлу — шаг ❌ и этап красный', async () => {
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
    strictEqual(r.ok, false);
    strictEqual(checks, 3);
    ok(provider.asked[1]!.includes('попытка 1'));
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
    ok(r.ok);
    ok(r.finalText.includes('проверка после шага не состоялась: нет tsc'), r.finalText);
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
