/**
 * Пошаговый добор осей плана (`planAxisStepwise.ts`): одна степень свободы на вопрос.
 * Класс, который он закрывает, — test27–test29 (2026-09-22…23): комбинированный топ-ап
 * состоялся технически и не дал ни одной разобранной клетки.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderEnvError, type ChatProvider } from '../src/provider/ChatProvider.ts';
import {
  affectedQuestion,
  fillPlanAxesStepwise,
  outcomeOptions,
  parseAffected,
  parseNumberedLines,
  parseOutcomeChoice,
  parseRiskFields,
  reasonsQuestion,
} from '../src/run/planAxisStepwise.ts';
import type { PlanAxisFillInput } from '../src/run/planAxisFill.ts';
import { planAxisProblems, type AxisName } from '../src/artifacts/planAxes.ts';
import { applyAxisAnswers } from '../src/artifacts/renderAxes.ts';

const AXES3: AxisName[] = ['Безопасность', 'Ресурсы и скорость', 'Наблюдаемость'];

const USAGE = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, durationMs: 1, envBlocked: false };

/** Провайдер-заглушка: отвечает по заголовку вопроса, запоминает все вопросы. */
function stub(byStep: Record<string, string | ((user: string) => string)>, asked: string[] = []): ChatProvider {
  return {
    name: 'stub',
    async chat(req: { messages: { role: string; content: string }[] }) {
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      asked.push(user);
      // Заголовок шага стоит ПОСЛЕ общего контекста (порядок ради префиксного кэша).
      const head = user.split('\n').find((l) => l.startsWith('## Разбор последствий')) ?? '';
      const key = Object.keys(byStep).find((k) => head.includes(k));
      if (key === undefined) throw new Error(`нет ответа на вопрос: ${head}`);
      const v = byStep[key]!;
      return { text: typeof v === 'function' ? v(user) : v, toolCalls: [], usage: USAGE, finishReason: 'end_turn' as const };
    },
  } as unknown as ChatProvider;
}

function input(over: Partial<PlanAxisFillInput> = {}): PlanAxisFillInput {
  return {
    provider: stub({}),
    model: 'stub',
    params: null,
    system: 'ты планировщик',
    axes: AXES3,
    planText: '## Шаги\n1. src/pricing.ts:priceFor — читать лимит из env',
    axisSupportText: '',
    claimIds: ['claim-1', 'claim-2'],
    enabledGates: ['Тесты', 'Секреты в diff'],
    hasOpenQuestion: false,
    hasInvariants: true,
    signal: new AbortController().signal,
    ...over,
  };
}

describe('разбор пронумерованных строк', () => {
  it('`N.`, `N)`, `N:` и маркеры списка; повтор номера — побеждает последняя (самокоррекция); номер вне диапазона — мимо', () => {
    const m = parseNumberedLines(3, ['1. да', '- 2) нет', '3: **да**', '1. нет', '7. да', 'проза без номера'].join('\n'));
    deepStrictEqual([...m.entries()], [[0, 'нет'], [1, 'нет'], [2, 'да']]);
  });

  it('parseAffected: «да»/«нет», «н/п» читается как «нет», прочее — не ответ', () => {
    const m = parseAffected(4, ['1. да — меняет env', '2. н/п', '3. Нет', '4. возможно'].join('\n'));
    deepStrictEqual([...m.entries()], [[0, true], [1, false], [2, false]]);
  });
});

describe('исход одним ключом из конкретных адресатов', () => {
  const options = outcomeOptions(input());

  it('список адресатов — только существующие: пункты, инвариант, включённые гейты, риск; без «следующего витка» и «н/п»', () => {
    deepStrictEqual(
      options.map((o) => o.cell),
      ['claim-1', 'claim-2', 'инвариант', 'гейт «Тесты»', 'гейт «Секреты в diff»', 'риск'],
    );
    const withQuestion = outcomeOptions(input({ hasOpenQuestion: true, hasInvariants: false, enabledGates: [] }));
    deepStrictEqual(withQuestion.map((o) => o.cell), ['claim-1', 'claim-2', 'следующий виток', 'риск']);
  });

  it('claim: существующий id — ответ, несуществующий — нет', () => {
    strictEqual(parseOutcomeChoice('`claim-2`', options)?.cell, 'claim-2');
    strictEqual(parseOutcomeChoice('- Claim-1 — уже проверяет', options)?.cell, 'claim-1');
    strictEqual(parseOutcomeChoice('claim-9', options), null);
  });

  it('гейт: по имени в кавычках или без кавычек, только из включённых', () => {
    strictEqual(parseOutcomeChoice('гейт «Секреты в diff»', options)?.cell, 'гейт «Секреты в diff»');
    strictEqual(parseOutcomeChoice('гейт "Тесты"', options)?.cell, 'гейт «Тесты»');
    strictEqual(parseOutcomeChoice('гейт тесты', options)?.cell, 'гейт «Тесты»');
    strictEqual(parseOutcomeChoice('гейт «Линт»', options), null);
  });

  it('инвариант/риск — ключом; «н/п» и проза — не ответ; берётся первая содержательная строка', () => {
    strictEqual(parseOutcomeChoice('**Инвариант**', options)?.cell, 'инвариант');
    strictEqual(parseOutcomeChoice('\n\nриск — принимаем', options)?.cell, 'риск');
    strictEqual(parseOutcomeChoice('н/п — не затронута', options), null);
    strictEqual(parseOutcomeChoice('думаю, всё хорошо', options), null);
    strictEqual(parseOutcomeChoice('следующий виток', options), null, 'открытого вопроса в задаче нет — адресата нет');
  });

  it('три поля риска: по подписям, порядковой формой, любое пустое — не ответ', () => {
    deepStrictEqual(parseRiskFields('что: N+1\nпочему допустимо: индекс есть\nкогда вернуться: после нагрузки'), {
      what: 'N+1',
      why: 'индекс есть',
      revisit: 'после нагрузки',
    });
    deepStrictEqual(parseRiskFields('1. N+1\n2. индекс есть\n3. после нагрузки')?.revisit, 'после нагрузки');
    strictEqual(parseRiskFields('что: N+1\nпочему: индекс есть'), null);
  });
});

describe('fillPlanAxesStepwise: конвейер', () => {
  it('затронутые и незатронутые оси собираются в строки, которые страж плана читает без претензий', async () => {
    const asked: string[] = [];
    const provider = stub(
      {
        'шаг 1 из 4': '1. да\n2. нет\n3. да',
        'шаг 2 из 4': '1. метрик шаги не добавляют',
        'шаг 3 из 4': '1. src/pricing.ts:priceFor — читает лимит из env\n2. src/pricing.ts:priceFor — цикл по позициям',
        'исход по оси «Безопасность»': 'claim-2',
        'исход по оси «Наблюдаемость»': 'риск',
        'принятый риск по оси «Наблюдаемость»': 'что: лог без лимита\nпочему допустимо: объём мал\nкогда вернуться: при первой жалобе',
      },
      asked,
    );
    const r = await fillPlanAxesStepwise(input({ provider }));
    strictEqual(r.envFailure, null);
    deepStrictEqual(
      r.answers.map((a) => [a.axis, a.affectedText, a.outcome]),
      [
        ['Ресурсы и скорость', 'нет', 'н/п — метрик шаги не добавляют'],
        ['Безопасность', 'да', 'claim-2'],
        ['Наблюдаемость', 'да', 'риск'],
      ],
    );
    strictEqual(asked.length, 6, 'по одному запросу на шаг 1–3, на исход каждой затронутой оси и на риск');
    ok(asked[3]!.includes('- `claim-2`') && asked[3]!.includes('- `гейт «Тесты»`') && !asked[3]!.includes('н/п'), asked[3]);

    // Строки читаются обратно читателем плана без претензий по этим осям.
    const plan = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '| ‹имя оси из канона› | ‹да/нет› | ‹что› | ‹исход› |',
      '',
      '### Принятые риски',
      '',
      '| Ось | Риск | Почему допустимо | Когда вернуться |',
      '|---|---|---|---|',
      '',
    ].join('\n');
    const written = applyAxisAnswers(plan, r.answers);
    const problems = planAxisProblems(written, { claimIds: ['claim-1', 'claim-2'], enabledGates: ['Тесты', 'Секреты в diff'], hasInvariants: true, hasOpenQuestion: false });
    const ours = problems.filter((p) => AXES3.some((a) => p.includes(`«${a}»`)));
    deepStrictEqual(ours, [], problems.join('\n'));
  });

  it('исход не из списка адресатов — ось остаётся открытой, остальные записываются', async () => {
    const provider = stub({
      'шаг 1 из 4': '1. да\n2. нет\n3. нет',
      'шаг 2 из 4': '1. циклов нет\n2. логов нет',
      'шаг 3 из 4': '1. src/a.ts:f — валидация',
      'исход по оси «Безопасность»': 'claim-7 — добавим позже',
    });
    const notes: string[] = [];
    const r = await fillPlanAxesStepwise(input({ provider, onProgress: (n) => notes.push(n) }));
    deepStrictEqual(r.answers.map((a) => a.axis), ['Ресурсы и скорость', 'Наблюдаемость']);
    ok(notes.some((n) => n.includes('не из списка адресатов')), notes.join('\n'));
  });

  it('незатронутая ось без причины не записывается: «н/п» без причины страж всё равно отверг бы', async () => {
    const provider = stub({ 'шаг 1 из 4': '1. нет\n2. нет\n3. нет', 'шаг 2 из 4': '2. метрик нет' });
    const r = await fillPlanAxesStepwise(input({ provider }));
    deepStrictEqual(r.answers.map((a) => a.axis), ['Ресурсы и скорость']);
  });

  it('сбой среды на любом шаге — envFailure, уже собранные ответы не теряются', async () => {
    let calls = 0;
    const provider = {
      name: 'stub',
      async chat() {
        calls += 1;
        if (calls === 1) return { text: '1. да\n2. нет\n3. нет', toolCalls: [], usage: USAGE, finishReason: 'end_turn' as const };
        if (calls === 2) return { text: '1. циклов нет\n2. логов нет', toolCalls: [], usage: USAGE, finishReason: 'end_turn' as const };
        throw new ProviderEnvError('движок упал');
      },
    } as unknown as ChatProvider;
    const r = await fillPlanAxesStepwise(input({ provider }));
    strictEqual(r.envFailure, 'движок упал');
    strictEqual(r.answers.length, 2);
  });

  it('пустой список осей — провайдер не зовётся', async () => {
    let called = false;
    const provider = stub({ x: () => ((called = true), '') });
    const r = await fillPlanAxesStepwise(input({ provider, axes: [] }));
    strictEqual(called, false);
    deepStrictEqual(r, { answers: [], envFailure: null });
  });
});

describe('пошаговый добор: исправления code-review-all 2026-09-23', () => {
  it('«не затронута» читается как «нет»', () => {
    deepStrictEqual([...parseAffected(3, '1. да\n2. не затронута\n3. Не затрагивается')], [[0, true], [1, false], [2, false]]);
  });

  it('подписи риска с номерами и в форме плейсхолдера разбираются без меток в значениях', () => {
    deepStrictEqual(parseRiskFields('1. что: X\n2. почему допустимо: Y\n3. когда вернуться: Z'), { what: 'X', why: 'Y', revisit: 'Z' });
    deepStrictEqual(parseRiskFields('что: X\nпочему допустимо сейчас: Y\nкогда вернуться: Z'), { what: 'X', why: 'Y', revisit: 'Z' });
  });

  it('гейт — только дословное имя из набора; отрицание не выбирает отвергнутый ключ', () => {
    const options = outcomeOptions(input());
    strictEqual(parseOutcomeChoice('гейт «Тесты»', options)?.cell, 'гейт «Тесты»');
    strictEqual(parseOutcomeChoice('гейт Тесты', options)?.cell, 'гейт «Тесты»');
    strictEqual(parseOutcomeChoice('гейт «Тесты на граничные значения»', options), null);
    strictEqual(parseOutcomeChoice('не риск, а claim-1', options)?.cell, 'claim-1');
  });

  it('причина «—» не записывается: строку отверг бы читатель плана', async () => {
    const provider = stub({ 'шаг 1 из 4': '1. нет\n2. нет\n3. нет', 'шаг 2 из 4': '1. —\n2. ‹почему›\n3. метрик нет' });
    const r = await fillPlanAxesStepwise(input({ provider }));
    deepStrictEqual(r.answers.map((a) => a.axis), ['Наблюдаемость']);
  });

  it('отмена посреди добора — ответов нет, дальше не спрашивает', async () => {
    const ac = new AbortController();
    const asked: string[] = [];
    const provider = stub(
      {
        'шаг 1 из 4': '1. нет\n2. да\n3. да',
        'шаг 2 из 4': () => {
          ac.abort();
          return '1. входа нет';
        },
        'шаг 3 из 4': '1. a\n2. b',
      },
      asked,
    );
    const r = await fillPlanAxesStepwise(input({ provider, signal: ac.signal }));
    deepStrictEqual(r.answers, []);
    strictEqual(asked.length, 2, 'после отмены вопросов нет');
  });

  it('заголовок шага идёт после общего контекста — префикс вопросов общий', () => {
    const q1 = affectedQuestion(input());
    const q2 = reasonsQuestion(input(), ['Безопасность']);
    const common = q1.slice(0, q1.indexOf('## Разбор последствий'));
    ok(common.length > 0 && q2.startsWith(common));
  });
});
