/**
 * Преполётная проба tool-calling — без витка, без рабочей копии, без фикстуры.
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что модели, не способные ПОЗВАТЬ
 * инструмент, всё равно ставились на этап 5 и сжигали до 67 минут и 140k токенов на
 * заведомо пустой прогон. Проба отвечает на один вопрос быстро: доходит ли модель
 * до корректного вызова инструмента вообще. Не прошла — на этап 5 её не ставят, и
 * дорогой замер не запускается. Используется бенчмарком (`--probe`) и основным
 * флоу (ручка `POST /api/probe` — скрининг модели перед стартом витка).
 *
 * Это скрининг, а не измерение, и предсказательная сила пробы сама ещё не замерена:
 * гипотеза в том, что пороги «позвать инструмент» и «перейти от чтения к записи» ниже
 * всех остальных, поэтому красная проба — сильный довод не тратить дорогой замер.
 * Зелёная проба зелёного этапа не обещает.
 *
 * Запрос собирается ТОЙ ЖЕ конфигурацией, что у этапа: `params` записи модели уходят в
 * каждый вызов — проба без них мерила бы не ту модель, которую потом запускают.
 */

import { specsFor } from './exec/toolSpecs.ts';
import { lexicalNormalize } from './policy/paths.ts';
import type { ChatMessage, ChatProvider, ChatToolCall } from './provider/ChatProvider.ts';
import type { ModelDef, ProviderDef } from './config/schema.ts';

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

/** Проверка кейса: условие и текст отказа, если оно не выполнено. */
type Check = readonly [pass: boolean, failure: string];

/**
 * Итог кейса по списку проверок: `detail` — текст ПЕРВОЙ проваленной, `ok` — прошли все.
 *
 * Раньше условия `ok` жили дважды — в конъюнкции и в тернарной цепочке `detail`, — и
 * добавленное в одно место условие делало второе враньём: кейс красный, а причина
 * называет проверку, которая прошла (code-review, 2026-09-14). Порядок проверок значим —
 * как в политике, отказ называет самую раннюю причину.
 */
function verdict(okDetail: string, checks: readonly Check[]): CaseOutcome {
  const failed = checks.find(([pass]) => !pass);
  return failed === undefined ? { ok: true, detail: okDetail } : { ok: false, detail: failed[1] };
}

const noCall = (text: string, prefix = 'вызова нет'): CaseOutcome => ({
  ok: false,
  detail: `${prefix}, текст: «${text.slice(0, 120)}»`,
});

/**
 * Путь в той записи, которую модель законно может выбрать для объявленного файла:
 * `./src/a.ts` и `src\a.ts` — тот же файл, и красить их «вымышленным путём» значило бы
 * мерить набор символов, а не честность (code-review, 2026-09-14). Абсолютный путь и
 * другое имя по-прежнему не совпадут.
 */
function samePath(path: string, declared: string): boolean {
  return lexicalNormalize(path) === lexicalNormalize(declared);
}

/**
 * Точное содержимое «файла» для кейса многострочного Edit. Перевод строки внутри
 * template-литерала — ровно та форма, на которой слабые модели дали 44 промаха Edit
 * на 5 копий (CLAUDE.md): old_string, набранный по памяти, не совпадает с оригиналом
 * побайтово, и каждый промах — потерянный ход этапа.
 */
const MULTILINE_FILE =
  "export const TEMPLATE = `Привет,\n" +
  '${name}!\n' +
  'Срок: ${days} дн.`;\n' +
  "export const LOCALE = 'ru';\n";

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
  if (call === undefined) return noCall(turn.text);
  const path = str(call.arguments, 'file_path');
  return verdict(`Write(${path})`, [
    [call.name === 'Write', `вызван ${call.name} вместо Write`],
    [path !== '' && str(call.arguments, 'content') !== '', `вызван ${call.name}, аргументы неполны или не разобрались`],
  ]);
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
  if (call === undefined) return noCall(turn.text);
  const oldStr = str(call.arguments, 'old_string');
  const newStr = str(call.arguments, 'new_string');
  const notAboutPlaceholder = `вызван ${call.name}, old_string/new_string не про плейсхолдер`;
  return verdict('Edit с плейсхолдером в old_string', [
    [call.name === 'Edit', `вызван ${call.name} вместо Edit`],
    [oldStr.includes('‹'), notAboutPlaceholder],
    [newStr !== '' && !newStr.includes('‹'), notAboutPlaceholder],
  ]);
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
  if (firstCall === undefined) return noCall(first.text, 'первый ход без вызова');
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
  if (call === undefined) return noCall(second.text, 'после чтения записи нет');
  return verdict(`Read, затем ${call.name}`, [
    [call.name === 'Edit' || call.name === 'Write', `после чтения снова ${call.name}`],
  ]);
}

/**
 * Кейс 4 (преполёт): точный Edit многострочного блока. Содержимое файла дано в
 * промпте целиком; модель обязана набрать old_string как ТОЧНУЮ подстроку этого
 * содержимого. Класс отказа — «некорректная запись»: old_string по памяти не совпал
 * побайтово (44 промаха на 5 копий из-за перевода строки в template-поле). Сверка
 * строгая намеренно: побайтовость old_string и есть измеряемое свойство.
 */
async function caseEditExactMultiline(c: CaseCtx): Promise<CaseOutcome> {
  const turn = await chat(
    c,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          'Файл src/template.ts имеет ровно такое содержимое (между маркерами — побайтово):\n' +
          '===\n' +
          MULTILINE_FILE +
          '===\n' +
          'Замени в нём слово «Срок:» на «Дедлайн:» — инструментом Edit. ' +
          'old_string обязан совпадать с куском файла выше побайтово, включая переводы строк.',
      },
    ],
    ['Edit', 'Read'],
  );
  const call = turn.toolCalls[0];
  if (call === undefined) return noCall(turn.text);
  const oldStr = str(call.arguments, 'old_string');
  const newStr = str(call.arguments, 'new_string');
  const wrongReplacement = 'замена не про «Срок:» → «Дедлайн:»';
  return verdict('Edit с точным многострочным old_string', [
    [call.name === 'Edit', `вызван ${call.name} вместо Edit`],
    [oldStr !== '' && MULTILINE_FILE.includes(oldStr), `old_string не совпал с файлом побайтово: «${oldStr.slice(0, 120)}»`],
    [oldStr.includes('Срок:'), wrongReplacement],
    [newStr.includes('Дедлайн:') && !newStr.includes('Срок:'), wrongReplacement],
  ]);
}

/**
 * Кейс 5 (преполёт): честность путей. Замкнутый мир — объявлен ровно один файл;
 * модель обязана править его и никакой другой. Класс отказа — «выдумывание»:
 * вымышленные пути в карте проекта (`src/loyalty.ts` и т.п., model-task-matrix.md:54-55)
 * и вымышленные имена инструментов (`edit_file`).
 */
async function caseHonestPaths(c: CaseCtx): Promise<CaseOutcome> {
  const DECLARED = 'src/a.ts';
  const names: ('Read' | 'Write' | 'Edit')[] = ['Edit', 'Read'];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content:
        'В проекте существует ровно один файл — src/a.ts, других файлов нет. ' +
        'В нём есть строка «const LIMIT = 100». Замени 100 на 200 — инструментом Edit.',
    },
  ];
  const first = await chat(c, messages, names);
  const firstCall = first.toolCalls[0];
  if (firstCall === undefined) return noCall(first.text);
  const firstPath = str(firstCall.arguments, 'file_path');
  // Чтение ДО правки — законная осторожность, не галлюцинация: важно, что читается
  // объявленный файл, а не вымышленный. После содержимого модель обязана править.
  if (firstCall.name === 'Read' && samePath(firstPath, DECLARED)) {
    messages.push({ role: 'assistant', content: first.text, toolCalls: first.toolCalls });
    messages.push({ role: 'tool', toolCallId: firstCall.id, name: 'Read', content: '     1\tconst LIMIT = 100' });
    const second = await chat(c, messages, names);
    const call = second.toolCalls[0];
    if (call === undefined) return noCall(second.text, 'после чтения правки нет');
    const path = str(call.arguments, 'file_path');
    return verdict('Read src/a.ts, затем Edit по нему же', [
      [call.name === 'Edit', `после чтения вызван ${call.name} вместо Edit`],
      [samePath(path, DECLARED), `вымышленный путь: «${path}» (объявлен только src/a.ts)`],
      [str(call.arguments, 'new_string').includes('200'), 'new_string не содержит замену на 200'],
    ]);
  }
  return verdict('Edit строго по объявленному файлу src/a.ts', [
    [
      firstCall.name === 'Edit',
      `вызван ${firstCall.name} — не из предложенного набора либо не по объявленному файлу («${firstPath}»)`,
    ],
    [samePath(firstPath, DECLARED), `вымышленный путь: «${firstPath}» (объявлен только src/a.ts)`],
    [str(firstCall.arguments, 'new_string').includes('200'), 'new_string не содержит замену на 200'],
  ]);
}

/**
 * Маркер последней строки кейса длинной записи. Тире принимается любое — длинное,
 * короткое, дефис, минус (одно или сдвоенное), с пробелами или без: модель, заменившая
 * «—» на «-», не усекла ответ, а кейс мерит именно усечение (code-review, 2026-09-14).
 */
const LONG_WRITE_MARKER = /строка 60\s*[-‐‑‒–—―−]+\s*КОНЕЦ/;

/**
 * Кейс 6 (преполёт): длинная запись без усечения. Класс отказа — «нехватка токенов
 * на ответ»: `finish_reason: "length"` обрезал content посередине (model-runs.md:
 * «упёрлась в лимит длины ответа» — подтверждения у 6+ моделей). Маркер последней
 * строки обязан доехать целиком: усечённый JSON аргументов не разбирается вовсе,
 * а усечённый по длине ответ не содержит маркера.
 */
async function caseLongWrite(c: CaseCtx): Promise<CaseOutcome> {
  const turn = await chat(
    c,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          'Создай файл notes/lines.txt инструментом Write. Содержимое — ровно 60 строк: ' +
          '«строка 1», «строка 2», …, «строка 59», а последняя (60-я) строка — «строка 60 — КОНЕЦ».',
      },
    ],
    ['Write'],
  );
  const call = turn.toolCalls[0];
  if (call === undefined) return noCall(turn.text, 'вызова нет (усечение? разбор JSON аргументов не удался)');
  const content = str(call.arguments, 'content');
  return verdict('Write с маркером 60-й строки — ответ не усечён', [
    [call.name === 'Write', `вызван ${call.name} вместо Write`],
    [LONG_WRITE_MARKER.test(content), `маркер последней строки не доехал — ответ усечён (${content.length} символов)`],
  ]);
}

/** Бланк с полем решения человека — содержимое «файла» кейса точечной правки. */
const DECISION_FORM =
  '# Отчёт разведки\n\n' +
  '## Карта кодовой базы\n\n' +
  '| Путь | Что там сейчас |\n' +
  '|---|---|\n' +
  '| ‹путь› | ‹что там сейчас› |\n\n' +
  '## Полнота\n\n' +
  '- **Решение человека о полноте:** ‹заполняет человек›\n';

/**
 * Кейс 7 (преполёт): правка одного поля бланка, не трогая поле решения человека.
 * Класс отказа — «деструктивная перезапись»: модель переписывает весь отчёт `Write`'ом
 * и стирает поле, которое заполняет человек (серия v4: 21 отказ в 11 прогонах из 25).
 * Этого класса не видел ни один кейс пробы: `Edit` с плейсхолдером проверялся, а выбор
 * между точечной правкой и перезаписью файла целиком — нет. Сверка old_string строгая
 * намеренно — как в кейсе 4.
 */
async function caseEditOneFieldKeepDecision(c: CaseCtx): Promise<CaseOutcome> {
  const turn = await chat(
    c,
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          'Файл .sdlc/probe/exploration-report.md имеет ровно такое содержимое (между маркерами — побайтово):\n' +
          '===\n' +
          DECISION_FORM +
          '===\n' +
          'Заполни строку карты: путь «src/a.ts», что там сейчас — «функция priceFor». ' +
          'Поле «Решение человека о полноте» заполняет человек — его не трогай.',
      },
    ],
    ['Edit', 'Write', 'Read'],
  );
  const call = turn.toolCalls[0];
  if (call === undefined) return noCall(turn.text);
  if (call.name === 'Write') {
    const kept = str(call.arguments, 'content').includes('‹заполняет человек›');
    return {
      ok: false,
      detail: `файл переписан целиком Write вместо точечного Edit${kept ? '' : ' — и поле решения человека стёрто'}`,
    };
  }
  const oldStr = str(call.arguments, 'old_string');
  const newStr = str(call.arguments, 'new_string');
  return verdict('Edit строки карты, поле решения человека не тронуто', [
    [call.name === 'Edit', `вызван ${call.name} вместо Edit`],
    [oldStr !== '' && DECISION_FORM.includes(oldStr), `old_string не совпал с файлом побайтово: «${oldStr.slice(0, 120)}»`],
    [!oldStr.includes('Решение человека'), 'правка задела поле решения человека'],
    [oldStr.includes('‹путь›') && newStr.includes('src/a.ts'), 'замена не про строку карты'],
  ]);
}

export interface ProbeCase {
  name: string;
  run: (c: CaseCtx) => Promise<CaseOutcome>;
}

const CASES: ProbeCase[] = [
  { name: 'вызов Write', run: caseWrite },
  { name: 'заполнение поля через Edit', run: caseEdit },
  { name: 'чтение → запись', run: caseReadThenWrite },
];

/**
 * Расширенный набор преполёта (`--preflight`): три базовых микро-кейса плюс три
 * проверки классов отказов, сжигавших прогоны, — точность многострочной записи,
 * честность путей, длинный ответ без усечения. В `--probe` НЕ входит намеренно:
 * проба обещает секунды, а длинная запись на медленной модели — минута.
 */
export const PREFLIGHT_CASES: readonly ProbeCase[] = [
  ...CASES,
  { name: 'точный Edit многострочного блока', run: caseEditExactMultiline },
  { name: 'честность путей', run: caseHonestPaths },
  { name: 'длинная запись без усечения', run: caseLongWrite },
  { name: 'правка поля без перезаписи файла', run: caseEditOneFieldKeepDecision },
];

/**
 * Кейсы идут последовательно, каждый — со своим коротким диалогом и СВОИМ таймаутом:
 * общий сигнал на всю пробу исчерпывался медленной моделью на первом кейсе и красил
 * остальные тем же приговором. Ошибка транспорта (сервер лёг, модель не скачана)
 * помечается `env` и отдаётся отдельным исходом «не измерено», а не провалом модели.
 */
/**
 * Потолок стенных часов на ОДИН кейс пробы, когда вызывающий своего не назвал.
 *
 * Проба — скрининг «доходит ли модель до вызова инструмента», и её обещание — секунды.
 * Пока ручка сервера подставляла сюда `chatTimeoutMs` (умолчание 10 минут, на машинах
 * с локальными моделями — 20), три кейса подряд держали HTTP-запрос до часа, то есть
 * скрининг стоил дороже самого замера (ревью). Стенд по-прежнему называет свой потолок
 * (`--stage-timeout`): там кейс идёт на заведомо медленной модели и это осознанно.
 */
export const PROBE_CASE_TIMEOUT_MS = 120_000;

/** Цель пробы: описание модели и её провайдера. */
export interface ProbeTarget {
  def: ModelDef;
  providerDef: ProviderDef;
}

/**
 * Разрешение цели пробы по конфигу — ОДНА функция на сервер и на стенд.
 *
 * Обвязка была скопирована вместе с текстами ошибок, и копии успели разойтись потолком
 * кейса: одна и та же модель получала разный вердикт пробы в UI и на стенде (ревью).
 * Возвращает либо цель, либо человеческую причину отказа — решение о коде ответа
 * (404/400 у HTTP, код возврата у CLI) остаётся за вызывающим.
 */
export function resolveProbeTarget(
  models: { models: readonly ModelDef[]; providers: Record<string, ProviderDef> },
  modelId: string,
): ProbeTarget | { error: string } {
  const def = models.models.find((m) => m.id === modelId);
  if (def === undefined) return { error: `модель «${modelId}» не найдена в config/models.json` };
  const providerDef = models.providers[def.provider];
  if (providerDef === undefined) {
    return { error: `провайдер «${def.provider}» не описан в config/models.json` };
  }
  if (providerDef.flow !== 'loop') {
    return { error: `проба меряет флоу loop; провайдер «${def.provider}» идёт флоу ${providerDef.flow}` };
  }
  return { def, providerDef };
}

export async function probeModel(args: {
  provider: ChatProvider;
  model: string;
  params?: Record<string, unknown> | null;
  /** Потолок стенных часов на ОДИН кейс. */
  caseTimeoutMs: number;
  /** Набор кейсов; умолчание — базовые три (`--probe`), преполёт передаёт PREFLIGHT_CASES. */
  cases?: readonly ProbeCase[];
}): Promise<ProbeReport> {
  const cases: ProbeCaseResult[] = [];
  for (const { name, run } of args.cases ?? CASES) {
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
