/**
 * Преполётная проба tool-calling — без витка, без рабочей копии, без фикстуры.
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что модели, не способные ПОЗВАТЬ
 * инструмент, всё равно ставились на этап 5 и сжигали до 67 минут и 140k токенов на
 * заведомо пустой прогон. Проба отвечает на один вопрос быстро: доходит ли модель
 * до корректного вызова инструмента вообще. Не прошла — на этап 5 её не ставят, и
 * дорогой замер не запускается.
 *
 * Это скрининг, а не измерение, и предсказательная сила пробы сама ещё не замерена:
 * гипотеза в том, что пороги «позвать инструмент» и «перейти от чтения к записи» ниже
 * всех остальных, поэтому красная проба — сильный довод не тратить дорогой замер.
 * Зелёная проба зелёного этапа не обещает.
 *
 * Запрос собирается ТОЙ ЖЕ конфигурацией, что у этапа: `params` записи модели уходят в
 * каждый вызов — проба без них мерила бы не ту модель, которую потом запускают.
 */

import { specsFor } from '../../server/src/exec/toolSpecs.ts';
import type { ChatMessage, ChatProvider, ChatToolCall } from '../../server/src/provider/ChatProvider.ts';

export interface ProbeCaseResult {
  name: string;
  ok: boolean;
  /** Что наблюдали: имя вызванного инструмента, либо почему кейс красный. */
  detail: string;
  /** Кейс упал ошибкой транспорта/среды — это не наблюдение о модели. */
  env: boolean;
  durationMs: number;
}

export interface ProbeReport {
  model: string;
  cases: ProbeCaseResult[];
  /** Все кейсы зелёные. */
  passed: boolean;
  /**
   * Хотя бы один кейс упал средой (сервер лёг, таймаут транспорта): проба НЕ измерена,
   * а не провалена — красить модель по недоступному серверу значило бы вычеркнуть
   * годную. Вызывающий отдаёт за это код 2, не 1.
   */
  envBlocked: boolean;
}

const SYSTEM =
  'Ты исполнитель в автоматическом цикле tool-use. Задачи решаются ВЫЗОВОМ инструмента, ' +
  'а не текстом: текст ответа никуда не записывается. Не задавай вопросов, не пересказывай ' +
  'план — сделай ровно то, что просят, одним вызовом инструмента.';

/** Схемы — из того же реестра, что у этапа: проба мерит тот же набор, не свою копию. */
function tools(names: ('Read' | 'Write' | 'Edit')[]): { name: string; description: string; schema: Record<string, unknown> }[] {
  return specsFor(names).map((s) => ({ name: s.name, description: s.description, schema: s.schema }));
}

function str(args: Record<string, unknown> | null, key: string): string {
  const v = args?.[key];
  return typeof v === 'string' ? v : '';
}

interface CaseCtx {
  provider: ChatProvider;
  model: string;
  params: Record<string, unknown> | null;
  signal: AbortSignal;
}

const chat = (c: CaseCtx, messages: ChatMessage[], toolNames: ('Read' | 'Write' | 'Edit')[]) =>
  c.provider.chat({
    model: c.model,
    messages,
    tools: tools(toolNames),
    signal: c.signal,
    temperature: null,
    params: c.params,
  });

type CaseOutcome = { ok: boolean; detail: string };

/**
 * Кейс 1: прямой вызов Write. Порог «позвать инструмент вообще» — тот, на котором
 * qwen2.5-coder:7b не сделала ни одного вызова за 892 секунды.
 */
async function caseWrite(c: CaseCtx): Promise<CaseOutcome> {
  const turn = await chat(
    c,
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'Создай файл notes/hello.md с содержимым «привет» — инструментом Write.' },
    ],
    ['Write', 'Read'],
  );
  const call = turn.toolCalls[0];
  const ok =
    call !== undefined && call.name === 'Write' && str(call.arguments, 'file_path') !== '' && str(call.arguments, 'content') !== '';
  return {
    ok,
    detail:
      call === undefined
        ? `вызова нет, текст: «${turn.text.slice(0, 120)}»`
        : ok
          ? `Write(${str(call.arguments, 'file_path')})`
          : `вызван ${call.name}, аргументы неполны или не разобрались`,
  };
}

/**
 * Кейс 2: заполнить поле бланка через Edit. Ровно та операция, из которой состоят
 * этапы-документы 1–4: заменить плейсхолдер `‹…›` содержимым.
 */
async function caseEdit(c: CaseCtx): Promise<CaseOutcome> {
  const turn = await chat(
    c,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          'В файле .sdlc/probe/intent.md есть строка «- **Итог:** ‹что должно стать правдой›». ' +
          'Замени плейсхолдер так, чтобы строка стала «- **Итог:** проба пройдена» — инструментом Edit.',
      },
    ],
    ['Edit', 'Read'],
  );
  const call = turn.toolCalls[0];
  const ok =
    call !== undefined &&
    call.name === 'Edit' &&
    str(call.arguments, 'old_string').includes('‹') &&
    str(call.arguments, 'new_string') !== '' &&
    !str(call.arguments, 'new_string').includes('‹');
  return {
    ok,
    detail:
      call === undefined
        ? `вызова нет, текст: «${turn.text.slice(0, 120)}»`
        : ok
          ? 'Edit с плейсхолдером в old_string'
          : `вызван ${call.name}, old_string/new_string не про плейсхолдер`,
  };
}

/**
 * Кейс 3: переход от чтения к записи. Порог, на котором модели «читают и останавливаются»
 * (8 вызовов этапа — все чтение). Первый ход законно Read; после результата с содержимым
 * файла модель обязана перейти к Edit/Write, а не читать дальше и не завершать ход.
 */
async function caseReadThenWrite(c: CaseCtx): Promise<CaseOutcome> {
  const names: ('Read' | 'Edit' | 'Write')[] = ['Read', 'Edit', 'Write'];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        'Прочитай файл config/title.txt и замени в нём слово «черновик» на «готово». ' +
        'Файл короткий, других файлов не существует.',
    },
  ];
  const first = await chat(c, messages, names);
  const firstCall: ChatToolCall | undefined = first.toolCalls[0];
  if (firstCall === undefined) {
    return { ok: false, detail: `первый ход без вызова, текст: «${first.text.slice(0, 120)}»` };
  }
  // Модель, сразу позвавшая запись, порог «перейти к записи» уже взяла — засчитываем.
  if (firstCall.name === 'Edit' || firstCall.name === 'Write') {
    return { ok: true, detail: `сразу ${firstCall.name}` };
  }

  messages.push({ role: 'assistant', content: first.text, toolCalls: first.toolCalls });
  messages.push({
    role: 'tool',
    toolCallId: firstCall.id,
    name: firstCall.name,
    content: '     1\tзаголовок: черновик',
  });
  const second = await chat(c, messages, names);
  const call = second.toolCalls[0];
  const ok = call !== undefined && (call.name === 'Edit' || call.name === 'Write');
  return {
    ok,
    detail:
      call === undefined
        ? `после чтения записи нет, текст: «${second.text.slice(0, 120)}»`
        : ok
          ? `Read, затем ${call.name}`
          : `после чтения снова ${call.name}`,
  };
}

const CASES: { name: string; run: (c: CaseCtx) => Promise<CaseOutcome> }[] = [
  { name: 'вызов Write', run: caseWrite },
  { name: 'заполнение поля через Edit', run: caseEdit },
  { name: 'чтение → запись', run: caseReadThenWrite },
];

/**
 * Кейсы идут последовательно, каждый — со своим коротким диалогом и СВОИМ таймаутом:
 * общий сигнал на всю пробу исчерпывался медленной моделью на первом кейсе и красил
 * остальные тем же приговором. Ошибка транспорта (сервер лёг, модель не скачана)
 * помечается `env` и отдаётся отдельным исходом «не измерено», а не провалом модели.
 */
export async function probeModel(args: {
  provider: ChatProvider;
  model: string;
  params?: Record<string, unknown> | null;
  /** Потолок стенных часов на ОДИН кейс. */
  caseTimeoutMs: number;
}): Promise<ProbeReport> {
  const cases: ProbeCaseResult[] = [];
  for (const { name, run } of CASES) {
    const started = Date.now();
    const ctx: CaseCtx = {
      provider: args.provider,
      model: args.model,
      params: args.params ?? null,
      signal: AbortSignal.timeout(args.caseTimeoutMs),
    };
    try {
      const r = await run(ctx);
      cases.push({ name, ...r, env: false, durationMs: Date.now() - started });
    } catch (e) {
      // Не-Error бросок (строка, DOMException) не должен ронять пробу тем исключением,
      // которое она обещала не выпускать.
      const message = e instanceof Error ? e.message : String(e);
      cases.push({
        name,
        ok: false,
        detail: `ошибка запроса: ${message.slice(0, 200)}`,
        env: true,
        durationMs: Date.now() - started,
      });
    }
  }
  return {
    model: args.model,
    cases,
    passed: cases.every((c) => c.ok),
    envBlocked: cases.some((c) => c.env),
  };
}

/** Текстовый отчёт пробы для консоли. Чистая функция — проверяется без сети. */
export function formatProbe(report: ProbeReport): string {
  const lines = [
    `Преполётная проба: ${report.model}`,
    ...report.cases.map(
      (c) => `  ${c.ok ? '✅' : c.env ? '⏭' : '❌'} ${c.name} — ${c.detail} (${(c.durationMs / 1000).toFixed(1)} с)`,
    ),
    report.passed
      ? 'Проба пройдена: модель доходит до корректных вызовов инструментов. Это скрининг, не замер этапа.'
      : report.envBlocked
        ? 'Проба НЕ ИЗМЕРЕНА: часть кейсов упала средой (транспорт/сервер), а не моделью — почини среду и повтори.'
        : 'Проба НЕ пройдена: модель не дошла до вызова инструментов в микро-кейсах — дорогой замер этапа 5 не оправдан.',
  ];
  return lines.join('\n');
}
