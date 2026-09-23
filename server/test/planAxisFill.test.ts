/**
 * Топ-ап осей плана (`planAxisFill.ts`) — узкий комбинированный вопрос по осям, о которых
 * секция «Последствия шагов» ничего не сказала. Устроено симметрично `claimFill.ts`
 * (добор ПОСЛЕ хода модели), см. докстринг модуля.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ProviderEnvError, type ChatProvider } from '../src/provider/ChatProvider.ts';
import { fillPlanAxes, parsePlanAxesCombinedAnswer } from '../src/run/planAxisFill.ts';
import { axisOutcomePromptOptions, matchAxisOutcome } from '../src/run/axisOutcomes.ts';
import { planAxisProblems, unansweredAxes, type AxisName } from '../src/artifacts/planAxes.ts';
import { applyAxisAnswers } from '../src/artifacts/renderAxes.ts';

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

  it('ответ по ИМЕНАМ осей (без номеров) разбирается тем же словарём', () => {
    const answer = [
      'Безопасность | да | шаг 1 меняет валидацию входа | claim-1',
      'Наблюдаемость | нет | метрик не добавляли | н/п — не затронута',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 2);
    deepStrictEqual(answers.map((a) => a.axis), ['Безопасность', 'Наблюдаемость']);
    strictEqual(answers[0]!.outcome, 'claim-1');
    strictEqual(answers[1]!.affectedText, 'нет');
  });

  it('строка по имени оси добирает только то, что не закрыл нумерованный блок', () => {
    const answer = ['1. да | шаг 1 | claim-1', 'Наблюдаемость | нет | метрик нет | н/п — не затронута'].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 2);
    deepStrictEqual(answers.map((a) => a.axis), ['Безопасность', 'Наблюдаемость']);
  });

  it('проза про оси — не ответ: ни «имя без разделителя», ни текст вокруг блока', () => {
    const answer = [
      'Смотрю на оси ещё раз.',
      'Безопасность здесь не затронута совершенно точно',
      '1. да | шаг 1 | claim-1',
      'Наблюдаемость — важная ось, но не здесь',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    deepStrictEqual([...answeredIdx], [0]);
    strictEqual(answers.length, 1);
  });

  it('мусорный ответ без единой строки формата — ничего не записывается', () => {
    const answer = [
      'Я посмотрел на шаги плана и думаю, что всё в порядке.',
      '- оси разобраны выше',
      '### Итог',
      'претензий нет',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 0);
    strictEqual(answers.length, 0);
  });

  it('самокоррекция: из двух ПОЛНЫХ блоков берётся ПОСЛЕДНИЙ, проза между ними игнорируется', () => {
    const answer = [
      '1. да | первая версия — отозвана | claim-1',
      '2. нет | первая версия — отозвана | н/п — п',
      'Стоп, первая версия неверна, вот исправленный ответ:',
      '',
      '1. да | исправлено: валидация входа | claim-1',
      '2. нет | исправлено: метрик нет | н/п — не затронута',
      '',
      '### Обоснование',
      'дальше проза, не ответ',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 2);
    strictEqual(answers.length, 2);
    ok(answers[0]!.what.includes('исправлено'), 'взята первая (отозванная) версия блока');
    ok(answers[1]!.what.includes('исправлено'), 'взята первая (отозванная) версия блока');
  });
});

/**
 * Ответ из живого дампа `bench/traces/raw/test24e-ministral-st60-selfreview-freeship/
 * 00107-plan-planAxisFill.json` (2026-09-22) — ДОСЛОВНО: первый блок с осями вразнобой
 * (1,4,3,6,2,5), проза самопроверки, «Исправленный полноценный ответ» блоком 1..6 и
 * проза-обоснование в хвосте. На момент прогона рантайм не доносил такой ответ до
 * таблицы — этот разбор обязан закрывать все 6 осей.
 */
const DUMP_00107_ANSWER = [
  '1. да | что именно в шагах: проверка уровня клиента ("gold") и весовой ступени 3 в `src/freeship.ts:isFreeShipmentEligible(tier, weightG)` | исход: claim-2',
  '4. нет | нет вводов новой настройки в шагах плана (ограничения жестко прописаны в `freeship.ts`) | н/п — граница весов (2–5 кг) зафиксирована в логике без внешних конфиг-файлов',
  '3. нет | нет вызовов внешних зависимостей или дисковой/сетевой I/O в `freeship.ts` или `priceFor` (весовый расчёт локален) | н/п — все условия проверяются через параметры-аргументы',
  '6. да | добавление теста с префиксом `freeship` в `test/tariffs.test.ts` для нового функционала | исход: claim-5',
  '2. нет | добавлен локальный вызов `isEligible` без циклов или обращений к ресурсам в `src/tariffs.ts` | н/п — логика использует только параметры веса и уровня без дисковой/сетевой I/O',
  '5. да | модификация внутренней логики `freeship.ts` без изменения схем данных тарифов/скидок или контрактных сигнатур | исход: инвариант',
  '4 строки (ОШИБКА ПФ) **недействительно**, так как в данном списке отсутствует ось "Настройки" под номером 4: все оси сгруппированы в том порядке, который проставлен в инструктаже.',
  '**Исправленный полноценный ответ:**',
  '',
  '1. да | что именно в шагах: фильтрация в `src/freeship.ts:isFreeShipmentEligible(tier, weightG)` не содержит чужих данных/секретов. Данные уровней и веса — локальные аргументы | исход: claim-2',
  '2. нет | локальная проверка без циклов/сетевых запросов в `freeship.ts:isEligible` и `tariffs.ts:priceFor` | н/п — затраты равны O(1) по параметрам веса (2001–5000г) и уровня gold',
  '3. нет | модификация в `src/freeship.ts` и `src/tariffs.ts` не использует внешние вызовы | исход: claim-4',
  '4. нет | жестко прописаны пороги и правило gold-only в `freeship.ts` | н/п — границы (2–5кг) зафиксированы без внешних настроек',
  '5. да | логика сохраняет сигнатуру `priceFor()` без схемных изменений в публичных контрактах | исход: инвариант',
  '6. да | тест на покрытие нового модуля в `test/tariffs.test.ts` добавляет лог-функции и метрику `total === 0` при gold/вес≥2000г | исход: claim-5',
  '',
  '---',
  '### Обоснование "н/п":',
  'Слова `нотапп` — отсутствие новых файлов, циклов, схемных изменений и настроек в шагах 1–6.',
  '### Для «исходов»:',
  '- Закрытые словарные значения (claim-2, -5) относятся к действующим пунктам в `intent.md`, не требуя расширения списка.',
  '- Инварианты проверены через существующую миграцию (защищёно от дублирования веса в `tariffs.ts:legacyConstraints`).',
].join('\n');

describe('разбор ответа из дампа 00107 (самокоррекция + оси вразнобой + проза)', () => {
  const CANON: AxisName[] = [
    'Безопасность',
    'Ресурсы и скорость',
    'Отказы зависимостей',
    'Настройки',
    'Совместимость и данные',
    'Наблюдаемость',
  ];

  it('все 6 осей разбираются, из ИСПРАВЛЕННОГО (последнего полного) блока', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(CANON, DUMP_00107_ANSWER);
    strictEqual(answeredIdx.size, 6);
    deepStrictEqual(answers.map((a) => a.axis), CANON);
    // Признак второго блока: в первом «что именно» оси 1 было про «проверку уровня клиента».
    ok(answers[0]!.what.includes('фильтрация'), 'взят первый, отозванный самой моделью блок');
    strictEqual(answers[0]!.outcome, 'исход: claim-2');
    strictEqual(answers[1]!.affectedText, 'нет');
    strictEqual(answers[3]!.axis, 'Настройки');
    strictEqual(answers[4]!.outcome, 'исход: инвариант');
  });

  it('разобранные ответы записываются в таблицу «Последствия шагов» — разбор читается обратно без претензий про строки', () => {
    const plan = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '',
    ].join('\n');
    const { answers } = parsePlanAxesCombinedAnswer(CANON, DUMP_00107_ANSWER);
    const updated = applyAxisAnswers(plan, answers);
    deepStrictEqual(unansweredAxes(updated), []);
    const problems = planAxisProblems(updated);
    ok(
      !problems.some((p) => p.includes('нет строк для осей')),
      problems.join('\n'),
    );
  });

  it('запись работает и в таблицу, которую модель заполнила вертикальным мусором (как в прогоне дампа)', () => {
    // Собственный ход модели в прогоне 00107 разложил каждую ось на 4 строки
    // «поле: значение» — ни одной канонической строки.
    const plan = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '| ось: Безопасность | — | — | — |',
      '| затронута шагами: нет | — | — | — |',
      '| исход: инвариант | — | — | — |',
      '| ось: Наблюдаемость | — | — | — |',
      '| затронута шагами: да | — | — | — |',
      '| исход: claim-2 | — | — | — |',
      '',
    ].join('\n');
    const { answers } = parsePlanAxesCombinedAnswer(CANON, DUMP_00107_ANSWER);
    const updated = applyAxisAnswers(plan, answers);
    deepStrictEqual(unansweredAxes(updated), []);
  });
});

/**
 * Ответ из живого дампа `bench/traces/raw/test26b-gptoss-rf-plan-from-ask/
 * 00023-plan-planAxisFill.json` (2026-09-22) — ДОСЛОВНО: модель поставила `н/п — причина`
 * в ПЕРВОЕ поле вместо `нет`, поэтому старый разбор не брал ни одну из 6 осей.
 */
const DUMP_00023_ANSWER = [
  '1. н/п — причина | — / не добавляется логика, новые вызовы или конфигурации | н/п — причина',
  '2. н/п — причина | — / не добавляется логика, новые вызовы | н/п — причина',
  '3. н/п — причина | — / не добавляется логика, новые вызовы | н/п — причина',
  '4. н/п — причина | — / не добавляется новые настройки, переменные окружения | н/п — причина',
  '5. н/п — причина | — / не меняется публичный API, структуры данных | н/п — причина',
  '6. н/п — причина | — / не добавляются логи, метрики | н/п — причина',
].join('\n');

describe('разбор ответа из дампа 00023 (gpt-oss-20b-rf, «н/п» в первом поле)', () => {
  const CANON: AxisName[] = [
    'Безопасность',
    'Ресурсы и скорость',
    'Отказы зависимостей',
    'Настройки',
    'Совместимость и данные',
    'Наблюдаемость',
  ];

  it('все 6 осей разбираются, «н/п» в первом поле трактуется как «нет»', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(CANON, DUMP_00023_ANSWER);
    strictEqual(answeredIdx.size, 6);
    deepStrictEqual(answers.map((a) => a.axis), CANON);
    ok(answers.every((a) => a.affectedText === 'нет'), 'все строки должны быть незатронутыми');
    ok(answers.every((a) => a.outcome.startsWith('н/п')), 'исход — н/п с причиной');
  });

  it('запись в план даёт строки, которые страж читает без претензий про оси', () => {
    const plan = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '',
    ].join('\n');
    const { answers } = parsePlanAxesCombinedAnswer(CANON, DUMP_00023_ANSWER);
    const updated = applyAxisAnswers(plan, answers);
    deepStrictEqual(unansweredAxes(updated), []);
    const problems = planAxisProblems(updated);
    strictEqual(
      problems.length,
      0,
      problems.join('\n'),
    );
  });
});

describe('словарь исходов осей (axisOutcomes)', () => {
  it('рендер словаря перечисляет все шесть ключей', () => {
    const opts = axisOutcomePromptOptions();
    for (const key of ['`н/п — причина`', '`claim-N`', '`инвариант`', '`гейт «имя»`', '`следующий виток`', '`риск`']) {
      ok(opts.includes(key), `в словаре нет ключа ${key}`);
    }
  });

  it('ключ словаря терпим к регистру, обёрткам, префиксу «исход:» и хвосту-пояснению', () => {
    strictEqual(matchAxisOutcome('Инвариант — сигнатура сохранена')?.key, 'инвариант');
    strictEqual(matchAxisOutcome('`claim-3`')?.key, 'claim-N');
    strictEqual(matchAxisOutcome('*гейт* «Тесты»')?.key, 'гейт');
    strictEqual(matchAxisOutcome('исход: следующий виток')?.key, 'следующий виток');
    strictEqual(matchAxisOutcome('Н/П — новых вызовов нет')?.key, 'н/п');
  });

  it('побеждает ключ, встретившийся раньше по тексту поля (тот же принцип, что readOutcome плана)', () => {
    strictEqual(matchAxisOutcome('риск — см. claim-3')?.key, 'риск');
    strictEqual(matchAxisOutcome('гейт «Секреты в diff» — риск утечки закрыт')?.key, 'гейт');
  });

  it('поле без ключа словаря не сопоставляется', () => {
    strictEqual(matchAxisOutcome('отложить до лучших времён'), null);
    strictEqual(matchAxisOutcome(''), null);
  });

  it('строка с исходом не из словаря не разбирается — ось остаётся открытой', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(
      AXES2,
      ['1. да | шаг 1 | отложить до лучших времён', '2. нет | метрик нет | н/п — не затронута'].join('\n'),
    );
    strictEqual(answeredIdx.size, 1);
    strictEqual(answers.length, 1);
    strictEqual(answers[0]!.axis, 'Наблюдаемость');
  });

  it('пустой или тире-исход не разбирается — ось остаётся открытой', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(
      AXES2,
      [
        '1. нет | — / метрик нет | —',
        '2. нет | — / метрик нет |',
        '3. нет | — / метрик нет | н/п',
      ].join('\n'),
    );
    strictEqual(answeredIdx.size, 0);
    strictEqual(answers.length, 0);
  });

  it('исход ключом в произвольном регистре с пояснением разбирается и читается обратно из плана', () => {
    const answer = [
      '1. да | шаг 1 меняет валидацию входа | Инвариант — сигнатура priceFor сохранена',
      '2. нет | — / метрик не добавляли | Н/П — не затронута',
    ].join('\n');
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(AXES2, answer);
    strictEqual(answeredIdx.size, 2);
    strictEqual(answers[0]!.outcome, 'Инвариант — сигнатура priceFor сохранена');
    const plan = [
      '# План: тест',
      '',
      '## Последствия шагов',
      '',
      '| Ось | Затронута шагами | Что именно в шагах | Исход |',
      '|---|---|---|---|',
      '',
    ].join('\n');
    const updated = applyAxisAnswers(plan, answers);
    // В план записаны только две оси из шести канона — остальные четыре законно «не
    // отвечены»; проверяем, что без претензий читаются именно ЗАПИСАННЫЕ строки.
    deepStrictEqual(unansweredAxes(updated).filter((a) => (AXES2 as string[]).includes(a)), []);
    const problems = planAxisProblems(updated);
    ok(
      !problems.some((p) => p.includes('Безопасность') || p.includes('Наблюдаемость')),
      problems.join('\n'),
    );
  });

  it('«н/п» в первом поле терпимо к регистру и кавычкам, без «— причина»', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(
      AXES2,
      ['1. «Н/П» | — / нет новых вызовов | н/п — не затронута', '2. Н/П | — / метрик нет | н/п — п'].join('\n'),
    );
    strictEqual(answeredIdx.size, 2);
    ok(answers.every((a) => a.affectedText === 'нет'));
  });

  it('комбинированный ответ ключами словаря: гейт и следующий виток', () => {
    const { answeredIdx, answers } = parsePlanAxesCombinedAnswer(
      AXES2,
      ['1. да | шаг 1 добавляет секрет в diff | гейт «Тесты»', '2. да | метрика не определена задачей | следующий виток'].join('\n'),
    );
    strictEqual(answeredIdx.size, 2);
    strictEqual(answers[0]!.outcome, 'гейт «Тесты»');
    strictEqual(answers[1]!.outcome, 'следующий виток');
  });

  it('вопрос модели содержит словарь исходов ключами', async () => {
    let asked = '';
    const provider = stubProvider((req) => {
      asked = req.messages.find((m) => m.role === 'user')?.content ?? '';
      return { text: '' };
    });
    await fillPlanAxes(baseInput({ provider }));
    for (const key of ['`н/п — причина`', '`claim-N`', '`инвариант`', '`гейт «имя»`', '`следующий виток`', '`риск`']) {
      ok(asked.includes(key), `в вопросе нет ключа ${key}`);
    }
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
