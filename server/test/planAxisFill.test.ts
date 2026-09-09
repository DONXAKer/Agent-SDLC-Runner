/**
 * Топ-ап осей плана (`planAxisFill.ts`) — узкий комбинированный вопрос по осям, о которых
 * секция «Последствия шагов» ничего не сказала. Устроено симметрично `claimFill.ts`
 * (добор ПОСЛЕ хода модели), см. докстринг модуля.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderEnvError, type ChatProvider } from '../src/provider/ChatProvider.ts';
import { fillPlanAxes, parsePlanAxesCombinedAnswer } from '../src/run/planAxisFill.ts';
import type { AxisName } from '../src/artifacts/planAxes.ts';

const AXES2: AxisName[] = ['Безопасность', 'Наблюдаемость'];

const USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: null,
  durationMs: 1,
  envBlocked: false,
};

function stubProvider(
  handler: (req: { messages: { role: string; content: string }[] }) => Promise<{ text: string }> | { text: string },
): ChatProvider {
  return {
    name: 'stub',
    async chat(req: { messages: { role: string; content: string }[] }) {
      const r = await handler(req);
      return { text: r.text, toolCalls: [], usage: USAGE, finishReason: 'end_turn' as const };
    },
  } as unknown as ChatProvider;
}

function baseInput(overrides: Partial<Parameters<typeof fillPlanAxes>[0]> = {}) {
  return {
    provider: stubProvider(() => ({ text: '' })),
    model: 'stub',
    params: null,
    system: 'ты планировщик',
    axes: AXES2,
    planText: '# План: тест',
    axisSupportText: '',
    claimIds: ['claim-1'],
    enabledGates: ['Тесты'],
    hasOpenQuestion: true,
    hasInvariants: true,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('разбор комбинированного ответа по осям', () => {
  it('трёхчастная строка «N. да/нет | что | исход» разбирается', () => {
    const answer = ['1. да | шаг 1 меняет валидацию входа | claim-1', '2. нет | метрик не добавляли | н/п — не затронута'].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 2);
    deepStrictEqual(
      answers.map((a) => a.axis),
      ['Безопасность', 'Наблюдаемость'],
    );
    strictEqual(answers[0]!.affectedText, 'да');
    strictEqual(answers[0]!.outcome, 'claim-1');
    strictEqual(answers[1]!.affectedText, 'нет');
  });

  it('шестичастная строка риска разбирается в answer.risk, outcome = «риск», «риск словами» не путается с «что именно в шагах»', () => {
    const answer =
      '2. да | шаг 2 пишет метрику | риск | алерт может не сработать | мониторинг чинится следующим витком | после первого инцидента';
    const { answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answers.length, 1);
    const a = answers[0]!;
    strictEqual(a.axis, 'Наблюдаемость');
    strictEqual(a.outcome, 'риск');
    strictEqual(a.what, 'шаг 2 пишет метрику');
    deepStrictEqual(a.risk, {
      what: 'алерт может не сработать',
      why: 'мониторинг чинится следующим витком',
      revisit: 'после первого инцидента',
    });
  });

  it('«риски» (множественное число) распознаётся как риск-ветка', () => {
    const answer = '2. да | шаг 2 | риски | алерт может не сработать | причина | срок';
    const { answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answers.length, 1);
    strictEqual(answers[0]!.outcome, 'риск');
  });

  it('старый пятичастный формат риска (regression) больше не принимается молча — переспрос честнее тихой порчи полей', () => {
    const answer = '2. да | шаг 2 пишет метрику | риск | алерт может не сработать | после первого инцидента';
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 0);
    strictEqual(answers.length, 0);
  });

  it('риск тремя частями (без причины/срока) — не разбирается', () => {
    const answer = '2. да | шаг 2 | риск';
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 0);
    strictEqual(answers.length, 0);
  });

  it('номер вне диапазона и дубль отбрасываются, остальное разбирается', () => {
    const answer = [
      '0. да | x | claim-1',
      '9. да | x | claim-1',
      '1. да | шаг 1 | claim-1',
      '1. нет | повтор | н/п — п',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    deepStrictEqual([...answeredIdx], [0]);
    strictEqual(answers.length, 1);
    strictEqual(answers[0]!.outcome, 'claim-1');
  });

  it('пустой исход или незаполненное «да/нет» — строка не считается ответом', () => {
    const answer = ['1. может быть | шаг 1 | claim-1', '2. да | | claim-2'].join('\n');
    const { answeredIdx } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 0);
  });
});

describe('fillPlanAxes: пустой список осей', () => {
  it('axes пуст — провайдер не вызывается вовсе', async () => {
    let called = false;
    const provider = stubProvider(() => {
      called = true;
      return { text: '' };
    });
    const result = await fillPlanAxes(baseInput({ provider, axes: [] }));
    strictEqual(called, false);
    deepStrictEqual(result, { answers: [], envFailure: null });
  });
});

describe('fillPlanAxes: вопрос только по проблемным осям', () => {
  it('вопрос перечисляет РОВНО заданные оси, доступных адресатов и опоры разведки', async () => {
    let asked = '';
    const provider = stubProvider((req) => {
      asked = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return { text: '1. да | шаг 1 | claim-1\n2. нет | н/п | н/п — не затронута' };
    });
    await fillPlanAxes(
      baseInput({
        provider,
        axisSupportText: 'Безопасность: src/auth.ts:checkToken',
        claimIds: ['claim-1', 'claim-4'],
        enabledGates: ['Секреты в diff'],
      }),
    );
    ok(asked.includes('### 1. Ось «Безопасность»'));
    ok(asked.includes('### 2. Ось «Наблюдаемость»'));
    ok(!asked.includes('Ресурсы и скорость'), 'в вопрос не должна попасть ось, которой не было в axes');
    ok(asked.includes('claim-1, claim-4'));
    ok(asked.includes('«Секреты в diff»'));
    ok(asked.includes('src/auth.ts:checkToken'));
  });

  it('без опор разведки секция про них в вопрос не попадает', async () => {
    let asked = '';
    const provider = stubProvider((req) => {
      asked = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return { text: '1. да | шаг 1 | claim-1\n2. нет | н/п | н/п — п' };
    });
    await fillPlanAxes(baseInput({ provider, axisSupportText: '' }));
    ok(!asked.includes('из разведки'));
  });
});

describe('fillPlanAxes: usage и ошибки среды', () => {
  it('usage успешного запроса уходит в onUsage', async () => {
    const usages: unknown[] = [];
    const provider = stubProvider(() => ({ text: '1. да | шаг 1 | claim-1\n2. нет | н/п | н/п — п' }));
    await fillPlanAxes(baseInput({ provider, onUsage: (u) => usages.push(u) }));
    strictEqual(usages.length, 1);
    deepStrictEqual(usages[0], USAGE);
  });

  it('ProviderEnvError возвращается полем envFailure, usage не зовётся', async () => {
    const provider = {
      name: 'stub',
      async chat() {
        throw new ProviderEnvError('ollama: ECONNREFUSED');
      },
    } as unknown as ChatProvider;
    const usages: unknown[] = [];
    const result = await fillPlanAxes(baseInput({ provider, onUsage: (u) => usages.push(u) }));
    strictEqual(result.envFailure, 'ollama: ECONNREFUSED');
    strictEqual(result.answers.length, 0);
    strictEqual(usages.length, 0);
  });

  it('обычная ошибка (не среды) даёт envFailure = null, но список ответов пуст', async () => {
    const provider = {
      name: 'stub',
      async chat() {
        throw new Error('модель вернула мусор');
      },
    } as unknown as ChatProvider;
    const notes: string[] = [];
    const result = await fillPlanAxes(baseInput({ provider, onProgress: (m) => notes.push(m) }));
    strictEqual(result.envFailure, null);
    strictEqual(result.answers.length, 0);
    ok(notes.some((m) => m.includes('оси плана не отвечены')));
  });

  it('ответ разобрался не полностью — прогресс отмечает недобор, но не роняет отданные ответы', async () => {
    const notes: string[] = [];
    const provider = stubProvider(() => ({ text: '1. да | шаг 1 | claim-1' })); // вторая ось молчит
    const result = await fillPlanAxes(baseInput({ provider, onProgress: (m) => notes.push(m) }));
    strictEqual(result.answers.length, 1);
    ok(notes.some((m) => m.includes('неполон') && m.includes('1 из 2')));
  });
});
