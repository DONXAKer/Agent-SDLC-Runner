/**
 * Преполётная проба tool-calling — без витка, без рабочей копии, без фикстуры.
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что модели, не способные ПОЗВАТЬ
 * инструмент, всё равно ставились на этап 5 и сжигали до 67 минут и 140k токенов на
 * заведомо пустой прогон. Проба отвечает на один вопрос за секунды: доходит ли модель
 * до корректного вызова инструмента вообще. Не прошла — на этап 5 её не ставят, и
 * дорогой замер не запускается.
 *
 * Это скрининг, а не измерение: зелёная проба не обещает зелёный этап (этап требует ещё
 * и не разрушить, и закончить), но красная проба надёжно предсказывает красный этап —
 * пороги «позвать инструмент» и «перейти от чтения к записи» ниже всех остальных.
 */

import { TOOL_SPECS } from '../../server/src/exec/toolSpecs.ts';
import type { ChatMessage, ChatProvider } from '../../server/src/provider/ChatProvider.ts';

export interface ProbeCaseResult {
  name: string;
  ok: boolean;
  /** Что наблюдали: имя вызванного инструмента, либо почему кейс красный. */
  detail: string;
  durationMs: number;
}

export interface ProbeReport {
  model: string;
  cases: ProbeCaseResult[];
  /** Все кейсы зелёные. Красная проба — «на этап 5 не ставить», см. шапку файла. */
  passed: boolean;
}

const SYSTEM =
  'Ты исполнитель в автоматическом цикле tool-use. Задачи решаются ВЫЗОВОМ инструмента, ' +
  'а не текстом: текст ответа никуда не записывается. Не задавай вопросов, не пересказывай ' +
  'план — сделай ровно то, что просят, одним вызовом инструмента.';

function tool(name: 'Read' | 'Write' | 'Edit'): { name: string; description: string; schema: Record<string, unknown> } {
  const s = TOOL_SPECS[name];
  return { name: s.name, description: s.description, schema: s.schema };
}

function str(args: Record<string, unknown> | null, key: string): string {
  const v = args?.[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Кейс 1: прямой вызов Write. Порог «позвать инструмент вообще» — тот, на котором
 * qwen2.5-coder:7b не сделала ни одного вызова за 892 секунды.
 */
async function caseWrite(provider: ChatProvider, model: string, signal: AbortSignal): Promise<ProbeCaseResult> {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: 'Создай файл notes/hello.md с содержимым «привет» — инструментом Write.' },
  ];
  const turn = await provider.chat({ model, messages, tools: [tool('Write'), tool('Read')], signal, temperature: null });
  const call = turn.toolCalls[0];
  const ok =
    call !== undefined && call.name === 'Write' && str(call.arguments, 'file_path') !== '' && str(call.arguments, 'content') !== '';
  return {
    name: 'вызов Write',
    ok,
    detail:
      call === undefined
        ? `вызова нет, текст: «${turn.text.slice(0, 120)}»`
        : ok
          ? `Write(${str(call.arguments, 'file_path')})`
          : `вызван ${call.name}, аргументы неполны или не разобрались`,
    durationMs: Date.now() - started,
  };
}

/**
 * Кейс 2: заполнить поле бланка через Edit. Ровно та операция, из которой состоят
 * этапы-документы 1–4: заменить плейсхолдер `‹…›` содержимым.
 */
async function caseEdit(provider: ChatProvider, model: string, signal: AbortSignal): Promise<ProbeCaseResult> {
  const started = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        'В файле .sdlc/probe/intent.md есть строка «- **Итог:** ‹что должно стать правдой›». ' +
        'Замени плейсхолдер так, чтобы строка стала «- **Итог:** проба пройдена» — инструментом Edit.',
    },
  ];
  const turn = await provider.chat({ model, messages, tools: [tool('Edit'), tool('Read')], signal, temperature: null });
  const call = turn.toolCalls[0];
  const ok =
    call !== undefined &&
    call.name === 'Edit' &&
    str(call.arguments, 'old_string').includes('‹') &&
    str(call.arguments, 'new_string') !== '' &&
    !str(call.arguments, 'new_string').includes('‹');
  return {
    name: 'заполнение поля через Edit',
    ok,
    detail:
      call === undefined
        ? `вызова нет, текст: «${turn.text.slice(0, 120)}»`
        : ok
          ? 'Edit с плейсхолдером в old_string'
          : `вызван ${call.name}, old_string/new_string не про плейсхолдер`,
    durationMs: Date.now() - started,
  };
}

/**
 * Кейс 3: переход от чтения к записи. Порог, на котором модели «читают и останавливаются»
 * (8 вызовов этапа — все чтение). Первый ход законно Read; после результата с содержимым
 * файла модель обязана перейти к Edit/Write, а не читать дальше и не завершать ход.
 */
async function caseReadThenWrite(provider: ChatProvider, model: string, signal: AbortSignal): Promise<ProbeCaseResult> {
  const started = Date.now();
  const tools = [tool('Read'), tool('Edit'), tool('Write')];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        'Прочитай файл config/title.txt и замени в нём слово «черновик» на «готово». ' +
        'Файл короткий, других файлов не существует.',
    },
  ];
  const first = await provider.chat({ model, messages, tools, signal, temperature: null });
  const firstCall = first.toolCalls[0];
  if (firstCall === undefined) {
    return {
      name: 'чтение → запись',
      ok: false,
      detail: `первый ход без вызова, текст: «${first.text.slice(0, 120)}»`,
      durationMs: Date.now() - started,
    };
  }
  // Модель, сразу позвавшая запись, порог «перейти к записи» уже взяла — засчитываем.
  if (firstCall.name === 'Edit' || firstCall.name === 'Write') {
    return { name: 'чтение → запись', ok: true, detail: `сразу ${firstCall.name}`, durationMs: Date.now() - started };
  }

  messages.push({ role: 'assistant', content: first.text, toolCalls: first.toolCalls });
  messages.push({
    role: 'tool',
    toolCallId: firstCall.id,
    name: firstCall.name,
    content: '     1\tзаголовок: черновик',
  });
  const second = await provider.chat({ model, messages, tools, signal, temperature: null });
  const call = second.toolCalls[0];
  const ok = call !== undefined && (call.name === 'Edit' || call.name === 'Write');
  return {
    name: 'чтение → запись',
    ok,
    detail:
      call === undefined
        ? `после чтения записи нет, текст: «${second.text.slice(0, 120)}»`
        : ok
          ? `Read, затем ${call.name}`
          : `после чтения снова ${call.name}`,
    durationMs: Date.now() - started,
  };
}

/**
 * Кейсы идут последовательно и каждый — со своим коротким диалогом: проба меряет модель,
 * а не способность держать длинный контекст. Ошибка транспорта (сервер лёг, модель не
 * скачана) отдаётся красным кейсом с текстом причины, а не исключением: `2` от пробы
 * означало бы «не измерено», тогда как недоступный сервер — это измеренный факт среды.
 */
export async function probeModel(args: {
  provider: ChatProvider;
  model: string;
  signal: AbortSignal;
}): Promise<ProbeReport> {
  const cases: ProbeCaseResult[] = [];
  for (const run of [caseWrite, caseEdit, caseReadThenWrite]) {
    const started = Date.now();
    try {
      cases.push(await run(args.provider, args.model, args.signal));
    } catch (e) {
      cases.push({
        name: run === caseWrite ? 'вызов Write' : run === caseEdit ? 'заполнение поля через Edit' : 'чтение → запись',
        ok: false,
        detail: `ошибка запроса: ${(e as Error).message.slice(0, 200)}`,
        durationMs: Date.now() - started,
      });
    }
  }
  return { model: args.model, cases, passed: cases.every((c) => c.ok) };
}

/** Текстовый отчёт пробы для консоли. Чистая функция — проверяется без сети. */
export function formatProbe(report: ProbeReport): string {
  const lines = [
    `Преполётная проба: ${report.model}`,
    ...report.cases.map(
      (c) => `  ${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail} (${(c.durationMs / 1000).toFixed(1)} с)`,
    ),
    report.passed
      ? 'Проба пройдена: модель доходит до корректных вызовов инструментов. Это скрининг, не замер этапа.'
      : 'Проба НЕ пройдена: модель не доходит до вызова инструментов — этап 5 сгорит впустую, дорогой замер не оправдан.',
  ];
  return lines.join('\n');
}
