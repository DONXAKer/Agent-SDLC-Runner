/**
 * Флоу `loop`, режим «заполнение бланка по полям» — для этапов-документов (intent/ask/plan).
 *
 * Зачем: замеры (`docs/model-runs.md`) показали, что у моделей ≤9B порог «позвать
 * инструмент» лежит НИЖЕ порога «понять задачу»: qwen2.5-coder — 0 вызовов за 892 с,
 * qwen3.5 — три круга вопросов вместо записи. Этап-документ по существу — заполнение
 * разложенного рантаймом бланка, и tool-use для этого не обязателен: рантайм сам находит
 * плейсхолдеры `‹…›`, спрашивает модель ПО ОДНОМУ полю обычным completion'ом и сам
 * записывает результат. Порог «позвать инструмент» исчезает по построению.
 *
 * Поля ищутся и заменяются через `placeholderRanges` — ТО ЖЕ определение плейсхолдера,
 * которым считает готовность `readArtifact`: упоминание `‹…›` в инлайн-коде и цитатах
 * полем не является (первая версия с наивным `includes('‹')` перезаписывала строку-легенду
 * шаблона сочинённым содержимым). Заменяется только сам диапазон плейсхолдера, не строка
 * целиком — структура вокруг (ячейки таблиц, жирные метки) остаётся нетронутой.
 *
 * Что тут НЕ обходится:
 *  - **Гейт одобрения и политика.** Собранный артефакт уходит через `hooks.onToolRequest`
 *    нормализованным `Write` — тем же путём, что любая запись исполнителя (и что salvage):
 *    политика решает, оператор одобряет, второго места решения о доступе не появляется
 *    по построению. Отказ гейта окончательный — второй попытки записи у режима нет.
 *  - **Страж завершения.** Поле, которое модель не смогла заполнить, остаётся
 *    плейсхолдером, и `finishGuard`/предусловия следующего этапа честно краснеют.
 *  - **Решения человека.** Поля с жирными метками решений (`isDecisionLine`) и строки
 *    таблиц с подписной колонкой в шапке (`isDecisionCell`: «Утвердил», «Кто») модели не
 *    отдаются никогда — единый словарь меток живёт в `artifacts/artifact.ts`.
 *
 * Ограничение режима: `AskHuman` здесь нет — вопросы человеку требуют цикла. Поле,
 * требующее решения человека, модель обязана оставить с пометкой, а не сочинить; это
 * режим ЭКСПЕРИМЕНТА для слабых моделей (флаг `formFill` записи модели), а не замена
 * штатного цикла.
 *
 * ИМЕНОВАННОЕ ИСКЛЮЧЕНИЕ из правила «всё, что уйдёт в модель, собрано в buildPrompt»:
 * полевые до-запросы этого исполнителя добавляют к промпту этапа служебную обвязку
 * («ровно одно поле», секция-контекст, правила ответа-строки). Оператор видит промпт
 * этапа целиком; обвязка полей — конструкция режима, как adapter-блок, и меняется только
 * правкой кода, а не незаметной подстановкой данных.
 */

import { relative } from 'node:path';

import type { StageId, Usage } from '@sdlc-runner/shared';
import { addUsage, emptyUsage, money } from '@sdlc-runner/shared';

import {
  continuationOfDecision,
  isDecisionCell,
  isDecisionLine,
  lineAt,
  placeholderRanges,
  readArtifact,
} from '../artifacts/artifact.ts';
import { applyFill } from '../artifacts/applyFill.ts';
import { CLAIMS_MINIMUM, claimIdOf, countClaims } from '../artifacts/claims.ts';
import {
  deriveSchema,
  modelFields,
  type FormField as SchemaField,
} from '../artifacts/formSchema.ts';
import { isSheetError, parseFieldValue } from '../artifacts/sheet.ts';
import { listSourceFiles } from '../gates/builtin/index.ts';
import { templateNameFor } from '../run/seed.ts';
import { isSeparatorRow, splitRow } from '../md/table.ts';
import { RUNTIME_AUTOFILLED_TEMPLATES } from '../run/formAutofill.ts';
import {
  ENGINE_UNAVAILABLE_SUBSTRINGS,
  ProviderEnvError,
  type ChatMessage,
  type ChatProvider,
} from '../provider/ChatProvider.ts';
import { budgetParams, ESTIMATE_MARGIN_TOKENS, estimateMessageTokens } from './contextBudget.ts';
import { writeThroughGate } from './gateWrite.ts';
import type { ExecHooks, ExecRequest, StageExecutor, StageResult } from './StageExecutor.ts';
import type { ToolContext } from './tools/index.ts';

/**
 * Сколько полей спрашивается одновременно. Поля независимы (каждый запрос несёт полный
 * контекст и одну строку бланка), 3 — компромисс: заметно быстрее последовательного, но
 * не шторм для локального сервера, который всё равно исполняет запросы по одному.
 */
const FIELD_PARALLEL = 3;

/** Шапка таблицы `files_to_touch` плана (`plan.template.md`) — узнаётся по колонкам. */
const FILES_TO_TOUCH_HEADER = /\|\s*Путь\s*\|\s*Что делаем\s*\|/;

/**
 * Шапка таблицы «Карта кодовой базы» (`exploration-report.template.md`) — узнаётся по
 * колонкам, тем же приёмом, что `FILES_TO_TOUCH_HEADER`.
 *
 * Это поле — единственное во всём дозаполнении, отвечая на которое модель ОБЯЗАНА знать
 * реальные пути в проекте, а у режима нет ни `Read`, ни `Task` (см. шапку файла): без
 * заземления модель сочиняет правдоподобные, но несуществующие пути — измерено живьём
 * пять раз за один прогон (серия v3, 2026-09-13, `docs/model-runs.md` → «Серия 5×5, повтор
 * v3»), и находка ловится только ПОСТФАКТУМ, гейтом честности (`explorationPathProblem`),
 * не предотвращается. Список путей ниже — безопасный обход `listSourceFiles` (symlink-safe,
 * `node_modules`/`.git`/`.sdlc` и кэши исключены, а прочие `.`-каталоги — нет: без них
 * существующий `.storybook/main.ts` честно назывался «новым»), не полноценный
 * индекс с кандидатами по ключевым словам — тот конвейер (`ExploreExecutor`) требует задачи
 * и структуры, которых у голого дозаполнения одного поля нет.
 */
const CODE_MAP_HEADER = /\|\s*Файл\s*\|\s*Что там сейчас\s*\|\s*Что меняем\s*\|/;

/** Потолок байт заземляющего списка путей — контекст локальной модели не резиновый. */
const CODE_MAP_LIST_BYTES = 4000;

/** Потолок файлов обхода дерева для заземления — тот же порядок, что у гейта дублей. */
const CODE_MAP_SCAN_LIMIT = 4000;

/**
 * Сколько попыток даётся добору приёмочного листа (счёт с первой, не «ремонтов сверх»).
 * Один выстрел без перепроверки один раз засчитал добор успешным, хотя добавленные
 * строки не несли [edge] — см. комментарий у места вызова.
 */
const CLAIMS_TOPUP_ATTEMPTS = 2;

export interface FormFillOptions {
  provider: ChatProvider;
  maxResultBytes: number;
  readRangeRequiredAboveBytes: number;
  bashTimeoutMs: number;
  /** Параметры запроса из конфига модели (`ModelDef.params`). */
  params?: Record<string, unknown> | null;
  /**
   * Окно контекста этой записи конфига (`ModelDef.contextWindow`) — тот же смысл и та же
   * формула (`contextBudget.ts`), что у `StepExecutor`/`ExploreExecutor`: каждый полевой
   * запрос независим (нет растущей истории цикла), его размер известен ДО отправки, и
   * `max_tokens` считается по остатку `contextWindow − размер запроса − запас`. До этой
   * правки `FormFillExecutor` это поле не читал вовсе — `contextWindow`, объявленный
   * маршруту в `config/models.json`, не давал здесь никакой защиты, и явный
   * `params.max_tokens` был единственным потолком; без него запрос падал на умолчание
   * провайдера (`DEFAULT_MAX_TOKENS = 8192`) — тот же класс пробела, что нашёлся и
   * починился у `StepExecutor` раньше (code-review-all, 2026-09-11), теперь и здесь
   * (code-review-all, 2026-09-14).
   */
  contextWindow?: number;
  /** Валюта провайдера маршрута — для честной подписи трат. Умолчание USD. */
  currency?: string;
  /**
   * Схема формы вместо сплошного текста бланка (`ModelDef.compactForms ∈ {fill, all}`):
   * поля ищутся `artifacts/formSchema.ts`, карточка поля вместо строки/секции бланка,
   * ответ разбирает и рисует `artifacts/applyFill.ts` — без `‹…›` в ответе-признаке
   * пустоты, без ручной чистки таблицы. Умолчание — `false`, прежний путь
   * (`groupFields`/`cleanFieldAnswer`/`cleanRowAnswer`) не трогается ни строкой.
   */
  compact?: boolean;
  /** Этап, на котором исполняется бланк — только для `compact`: отсекает `stageOnly`. */
  stage?: StageId;
  /**
   * Строки-образец граничного пункта приёмки из примера методологии
   * (`artifacts/edgeExample.ts`). Считает вызывающий — путь к эталону знает он, а не
   * исполнитель; пусто — эталона нет, и спрашивается как раньше.
   */
  edgeExample?: readonly string[];
  /**
   * Поля (id схемы), которые этот проход НЕ спрашивает — только в режиме `compact`. Нужно
   * конвейеру разведки (`ExploreExecutor`): часть полей он заполняет сам структурно
   * (карта, переиспользование, оси, вопросы, гейт заполненности), а свободные поля
   * («конвенции», «точка правки», «границы», «риски») отдаёт этому исполнителю. Без
   * фильтра второй проход переспрашивал бы и переписывал уже заполненное.
   */
  skipFields?: readonly string[];
}

/**
 * Ответ модели — текст, которым заменяется плейсхолдер. Снимаются только обёртки,
 * которые модель добавляет «из вежливости» (fenced-блок, внешние кавычки) — содержимое
 * не редактируется: редактировать ответ значило бы сочинять артефакт за модель.
 */
export function cleanFieldAnswer(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  if (text.startsWith('«') && text.endsWith('»')) text = text.slice(1, -1).trim();
  return text;
}

/**
 * Поле бланка: одиночный плейсхолдер либо строка-образец таблицы целиком.
 * У `row` шапка обязательна ТИПОМ: необязательное поле с fallback'ом на сам образец
 * превращало бы ответ, совпавший с образцом, в «шапку» и молча выбрасывало (ревью-3).
 */
export type FormField =
  | {
      start: number;
      end: number;
      kind: 'cell';
      /** Текст плейсхолдера — уходит в подсказку модели. */
      text: string;
    }
  | {
      start: number;
      end: number;
      kind: 'row';
      /** Строка-образец целиком. */
      text: string;
      /** Шапка таблицы — для дедупа продублированной моделью шапки. */
      header: string;
    };

/**
 * Бюджет запросов дозаполнения — от числа полей бланка, а не от лимита ходов этапа.
 *
 * Запрос поля ходом не является, и потолок `maxTurns` мерил не то: серия v7 (2026-09-15)
 * подняла лимит стенда 25 → 40 до штатного, и intent стал делать ровно 40 запросов вместо
 * 25 на каждом прогоне, удвоив время этапа, — а бланк всё равно оставался с незакрытыми
 * полями («заполнено 26, осталось 8»): на 34 поля не хватало ни 25, ни 40. Здесь бюджет —
 * по одному запросу на поле, половина сверху на второй проход по недобранным и запас под
 * добор листов (`CLAIMS_TOPUP_ATTEMPTS`); пол — маленький журнал, потолок — чтобы бланк на
 * сотни мест не жёг часы.
 */
const FILL_REQUESTS_FLOOR = 12;
const FILL_REQUESTS_MARGIN = 6;
const FILL_REQUESTS_CEILING = 90;

export function fillRequestBudget(fields: number): number {
  return Math.min(FILL_REQUESTS_CEILING, Math.max(FILL_REQUESTS_FLOOR, Math.ceil(fields * 1.5) + FILL_REQUESTS_MARGIN));
}

/**
 * Поля бланка, которые спрашиваются у модели: `groupFields` минус поля рантайма схемы.
 *
 * Карточный режим (`compact`) отсекал их всегда (`modelFields`), а основной путь шёл по
 * плейсхолдерам и про `SCHEMA_OVERRIDES` не знал — модель заполняла «Базу» плана и даты
 * готовности, хотя это факты рантайма (relog серии v5: `base_sha` выдуман).
 *
 * Фильтр намеренно уже, чем у `modelFields`: снимаются только поля `runtime`/`mechanical`,
 * и только у шаблонов, которые целиком закрывает автозаполнение
 * (`RUNTIME_AUTOFILLED_TEMPLATES`). Поля `subagent` (лист `sdlc-claims`) основной путь
 * по-прежнему спрашивает: у карточного режима их закрывает конвейер разведки, а здесь,
 * без `sdlc-claims`, их некому закрыть, кроме модели — снятые, они остались бы
 * плейсхолдерами навсегда.
 */
export function modelGroupFields(text: string, path: string): FormField[] {
  const groups = groupFields(text);
  const templateName = templateNameFor(path);
  if (templateName === undefined || !RUNTIME_AUTOFILLED_TEMPLATES.has(templateName)) return groups;
  const runtime = deriveSchema(text, templateName).fields.filter((f) => f.owner === 'runtime' || f.kind === 'mechanical');
  if (runtime.length === 0) return groups;
  return groups.filter((g) => !runtime.some((f) => g.start >= f.range.start && g.start < f.range.end));
}

/** Шапка таблицы, которой принадлежит строка с позиции `lineStart`: верхняя `|`-строка блока. */
function tableHeaderOf(text: string, lineStart: number): string {
  let start = lineStart;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd < 0) break;
    const prevStart = text.lastIndexOf('\n', prevEnd - 1) + 1;
    const prev = text.slice(prevStart, prevEnd);
    if (!prev.trimStart().startsWith('|')) break;
    start = prevStart;
  }
  const end = text.indexOf('\n', start);
  return text.slice(start, end < 0 ? text.length : end);
}

/**
 * Плейсхолдеры → поля. Строка ТАБЛИЦЫ с плейсхолдерами схлопывается в одно поле-строку:
 * это образец, один на весь будущий список, и несколько его плейсхолдеров — не несколько
 * независимых полей, а колонки одного элемента. Списки с маркером `-` сюда не входят:
 * `- **Ветка витка:** ‹…›` — обычное поле с меткой, а не образец списка.
 */
export function groupFields(text: string): FormField[] {
  const out: FormField[] = [];
  let lastRowStart = -1;
  let lastRowEnd = -1;
  let lastHeader = '';
  for (const r of placeholderRanges(text)) {
    const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
    const lineEndIdx = text.indexOf('\n', r.start);
    const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
    const line = text.slice(lineStart, lineEnd);
    // Поле решения человека (жирная метка «**Подтвердил:**» и подобные) — не поле модели
    // ни в каком режиме. Живой прогон: модель заполнила «Подтвердил», строка перестала
    // быть полем решения, и запись настоящего решения упала «нет поля „Подтвердил“».
    // Строка-ПРОДОЛЖЕНИЕ элемента списка наследует его статус: длинное поле решения
    // переносится, и плейсхолдер ‹имя› живёт на строке без метки — ревью-4 воспроизвёл
    // это на живом handoff-шаблоне (фикс по одной строке был холостым).
    if (isDecisionLine(line)) continue;
    if (/^\s+\S/.test(line) && continuationOfDecision(text, lineStart)) continue;
    if (line.trimStart().startsWith('|')) {
      if (lineStart === lastRowStart) continue; // колонка того же образца — уже учтён
      // Шапка блока не пересчитывается для соседних строк той же таблицы: обход вверх на
      // каждую строку давал квадрат на больших таблицах (ревью-2). Кэш корректен, потому
      // что смежные placeholder-строки всегда принадлежат одной таблице: между таблицами
      // стоят шапка и разделитель, а они placeholder-строками не бывают.
      const header =
        lastRowEnd >= 0 && lineStart === lastRowEnd + 1 ? lastHeader : tableHeaderOf(text, lineStart);
      lastRowStart = lineStart;
      lastRowEnd = lineEnd;
      lastHeader = header;
      // В таблицах подпись человека живёт в ШАПКЕ, не в строке: образец под колонкой
      // «Утвердил (человек)» / «Кто» — поле решения, модель его не заполняет (сфабрикованная
      // подпись снимала бы ⏭ в вердикте). Отбрасывается вся строка-образец: заполнять
      // нерешенческие ячейки, оставляя подписную, значило бы учить модель дописывать
      // таблицу решений — принятая цена безопасности.
      if (splitRow(header).some(isDecisionCell)) continue;
      out.push({ start: lineStart, end: lineEnd, kind: 'row', text: line, header });
    } else {
      out.push({ start: r.start, end: r.end, kind: 'cell', text: r.text });
    }
  }
  return out;
}

/**
 * Секция бланка от последнего заголовка до строки-образца включительно — контекст поля-строки.
 *
 * Одной строки-образца мало: правила списка живут в легенде секции над таблицей
 * («граничные случаи помечаются тегом [edge]», формат id), и модель, видевшая только
 * строку, писала лист без единой [edge]-пометки — минимум методологии ронял этап
 * (живой прогон, 7 пунктов и 0 [edge] при норме ≥2).
 */
function sectionAt(text: string, index: number, maxBytes = 2500): string {
  const lineEndIdx = text.indexOf('\n', index);
  const end = lineEndIdx < 0 ? text.length : lineEndIdx;
  const heading = text.lastIndexOf('\n#', index);
  const start = heading < 0 ? 0 : heading + 1;
  let section = text.slice(start, end);
  while (Buffer.byteLength(section, 'utf8') > maxBytes) {
    // Режем сверху: строка-образец и ближняя легенда важнее начала секции.
    const cut = section.indexOf('\n', Math.floor(section.length / 4));
    if (cut < 0) break;
    section = section.slice(cut + 1);
  }
  return section;
}

/** Каноничный вид строки таблицы для сравнения с шапкой: без регистра и лишних пробелов. */
function rowKey(line: string): string {
  return splitRow(line).join('|').toLowerCase();
}

/**
 * Из ответа на строку-образец берутся ТОЛЬКО строки таблицы: живой прогон показал ответ
 * «```markdown …таблица… ``` **Обоснование:** …» — валидная таблица внутри мусора
 * вежливости, и требование «весь ответ — строки таблицы» отклоняло её целиком.
 * Продублированные моделью шапка ЭТОЙ таблицы (сравнение с фактической шапкой поля) и
 * разделитель (общий `isSeparatorRow` — модели теряют замыкающую черту) снимаются;
 * содержимое строк не редактируется. Пустой результат — поле не заполнено.
 */
export function cleanRowAnswer(answer: string, header: string): string {
  const headerKey = rowKey(header);
  return answer
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') && !isSeparatorRow(l))
    .filter((l) => rowKey(l) !== headerKey)
    .join('\n');
}

export class FormFillExecutor implements StageExecutor {
  readonly flow = 'loop' as const;
  private readonly o: FormFillOptions;
  /**
   * Наибольшая оценка входа полевого запроса за текущий `run()` — число для диагноза
   * «контекст переполнен». Без него диагноз был гипотезой раннера: ни размера запроса, ни
   * окна в отчёте не было, а `usage` отказавшего запроса нулевой.
   *
   * Наибольшая, а не последняя: поля идут параллельными пачками, и «последний» запрос —
   * это тот, чей `paramsFor` случайно выполнился позже, то есть диагноз называл чужой
   * размер. Переполняет окно именно крупнейший. Сбрасывается в начале `run()`.
   */
  private maxRequestTokens: number | null = null;

  constructor(o: FormFillOptions) {
    this.o = o;
  }

  /** Числа к диагнозу переполнения: оценка входа против окна маршрута. */
  private contextNumbers(): string {
    const est =
      this.maxRequestTokens === null ? 'оценки входа нет' : `наибольший вход ≈${this.maxRequestTokens} токенов`;
    return this.o.contextWindow === undefined
      ? `${est}, окно маршрута не задано — заполни contextWindow модели в config/models.json`
      : `${est} при окне ${this.o.contextWindow}`;
  }

  /**
   * `params` полевого запроса — `max_tokens` по остатку окна (`contextBudget.ts`), когда
   * `contextWindow` задан; иначе `this.o.params` как есть — см. комментарий у поля
   * `contextWindow` выше.
   *
   * Запас — `ESTIMATE_MARGIN_TOKENS`, а не `marginFor(maxResultBytes)`: у полевого запроса
   * нет инструментов (`tools: []`), результатов, приходящих после оценки, не бывает, и
   * запас в целый результат (~3000 токенов) сажал ответ поля на пол 256 на окне 16K.
   */
  private paramsFor(messages: readonly ChatMessage[], hooks: ExecHooks): Record<string, unknown> | null {
    const estimate = estimateMessageTokens(messages);
    this.maxRequestTokens = Math.max(this.maxRequestTokens ?? 0, estimate);
    const window = this.o.contextWindow;
    return budgetParams({
      contextWindow: window,
      params: this.o.params,
      promptTokens: estimate,
      marginTokens: ESTIMATE_MARGIN_TOKENS,
      onClamped: (maxTokens) =>
        hooks.onWarn(
          `окно контекста (${window ?? '—'}) почти исчерпано этим полевым запросом — max_tokens ` +
            `ограничен полом ${maxTokens}, переполнение всё ещё вероятно`,
        ),
    });
  }

  /** Полевой запрос без инструментов — одна форма на все виды вопросов режима. */
  private ask(req: ExecRequest, messages: ChatMessage[], hooks: ExecHooks): ReturnType<ChatProvider['chat']> {
    return this.o.provider.chat({
      model: req.model,
      messages,
      tools: [],
      signal: req.signal,
      temperature: null,
      params: this.paramsFor(messages, hooks),
    });
  }

  /** Поля модели в режиме `compact` минус `skipFields` — один источник для прохода и для счёта остатка. */
  private compactFields(text: string, path: string): SchemaField[] {
    const skip = new Set((this.o.skipFields ?? []).map((id) => id.toLowerCase().replace(/ё/g, 'е')));
    return modelFields(deriveSchema(text, templateNameFor(path)), this.o.stage).filter(
      (f) => !skip.has(f.id.toLowerCase().replace(/ё/g, 'е')),
    );
  }

  async run(req: ExecRequest, hooks: ExecHooks): Promise<StageResult> {
    this.maxRequestTokens = null;
    const artifacts = req.formArtifacts ?? [];
    if (artifacts.length === 0) {
      return {
        ok: false,
        finalText: '',
        usage: emptyUsage(),
        note: 'режим заполнения по полям: этап не назвал артефактов — исполнять нечего',
      };
    }

    // Заземление для поля «Карта кодовой базы» — считается максимум один раз за прогон
    // (не на поле), и только если такое поле реально встретится: обход дерева читает
    // содержимое файлов (`explore/tree.ts` — общий код с индексом разведки), и платить
    // за него, когда дозаполнение спрашивает другой бланк (журнал chunk'а, отчёт приёмки),
    // незачем.
    let codeMapListing: Promise<string> | null = null;
    const codeMapGrounding = async (): Promise<string> => {
      if (codeMapListing !== null) return codeMapListing;
      codeMapListing = (async () => {
        const { files } = await listSourceFiles(req.cwd, CODE_MAP_SCAN_LIMIT, req.signal, { includeDotDirs: true });
        const lines = files.map((f) => `- \`${f}\``);
        let text = lines.join('\n');
        let truncated = false;
        // Перепроверка байтовой длины ПОСЛЕ каждого среза, не одноразовый `.slice()` по
        // UTF-16 code units: тот же класс ошибки, что уже пойман в `sectionAt` выше и
        // `prompt/bytes.ts` — кириллический путь занимает вдвое больше байт, чем units, и
        // единственная проверка условия перед срезом молча пропускала перевес (code-review-
        // all, 2026-09-14).
        while (Buffer.byteLength(text, 'utf8') > CODE_MAP_LIST_BYTES) {
          truncated = true;
          const cut = text.lastIndexOf('\n', Math.floor(text.length * 0.9));
          text = cut < 0 ? '' : text.slice(0, cut);
          if (cut < 0) break;
        }
        if (truncated) text = `${text}\n… обрезано рантаймом, файлов больше`;
        return text === '' ? '(дерево проекта пусто или недоступно)' : text;
      })();
      return codeMapListing;
    };

    const toolCtx: ToolContext = {
      projectRoot: req.cwd,
      maxResultBytes: this.o.maxResultBytes,
      readRangeRequiredAboveBytes: this.o.readRangeRequiredAboveBytes,
      timeoutMs: this.o.bashTimeoutMs,
      signal: req.signal,
    };
    const currency = this.o.currency ?? 'USD';

    let usage: Usage = emptyUsage();
    let fieldsFilled = 0;
    let callsSpent = 0;
    const notes: string[] = [];
    // Отказ среды копится ОТДЕЛЬНО от notes: заметка объясняет человеку, что случилось,
    // а это поле решает, считать ли прогон измерением вообще (см. StageResult.envFailure).
    // Раньше 503 апстрима попадал только в notes, этап отчитывался `ok`, и bench красил
    // им модель — замер 2026-09-04, пять витков из четырнадцати.
    let envFailure: string | null = null;
    const noteEnvFailure = (e: unknown): void => {
      if (envFailure === null && e instanceof ProviderEnvError) envFailure = e.message;
    };
    /**
     * Систематическая ошибка провайдера — та же строка N раз подряд по РАЗНЫМ полям —
     * не всегда `ProviderEnvError` (HTTP 404 «модель не найдена» им намеренно не считается,
     * `OpenAiCompatProvider`: чинится правкой конфига, не средой) и без этой проверки
     * тонет в потоке обычных «поле не спрошено», неотличимом от слабой модели, не
     * справившейся с бланком (замер `qwen3-coder-30b-a3b`/sweep5, 2026-09-13: 24
     * одинаковые строки `HTTP 404 model not found` по всем полям `intent.md`+`readiness.md`
     * на пяти разных задачах — причиной оказалась мёртвая запись конфига, а не модель).
     * Дальше спрашивать бессмысленно: тратить ходы на заведомо тот же отказ — не поведение
     * модели, которое стоит измерять.
     */
    const SYSTEMATIC_FAILURE_STREAK = 3;
    // Три разных диагноза за одной и той же формой сообщения — «модель не найдена»
    // (мёртвый config), «контекст переполнен» (бюджет промпта) и «модель недоступна прямо
    // сейчас» (движок провайдера упал/выгрузил модель между вызовами) — все три
    // воспроизводятся на КАЖДОМ поле одинаково (общий базовый промпт не меняется между
    // полями), и для всех продолжать спрашивать бессмысленно, но причина, которую стоит
    // чинить, разная, и текст обязан её различать. Класс «недоступна» — не то же самое, что
    // «мёртвый конфиг»: конфиг рабочий, файл модели цел, а `lms ps`/`ollama ps` сразу
    // показывают причину. Живой замер `qwen3-8b`/`refuse-dangerous`, 2026-09-13: «Context
    // size has been exceeded» после 3 полей подряд на этапе `plan» (контекст). Живой замер
    // `qwencoder-30b-stepfill`/`freeship` и `/silent-contract`, серия v3, 2026-09-13: LM
    // Studio выгрузил/уронил модель под давлением памяти (второй незакрытый процесс держал
    // VRAM) — `HTTP 400 {"error":"fetch failed"}` и `{"error":"terminated"}` на трёх полях
    // подряд, диагноз «сломанный конфиг» был бы неверным (модель отвечала штатно до и после).
    const CONTEXT_SIZE_RE = /context.{0,20}(size|length).{0,20}(exceed|超|too\s*(large|long))/i;
    // Подстроки падения движка (`terminated`/`fetch failed`) — из общего
    // `ENGINE_UNAVAILABLE_SUBSTRINGS` (`ChatProvider.ts`), не продублированы здесь вручную:
    // тот же список, что классифицирует `ProviderEnvError` в `OpenAiCompatProvider`, раньше
    // расходился при правке одного места без другого (code-review-all, 2026-09-14). Сетевые
    // признаки (econnrefused/econnreset/socket hang up) — своё, этому потребителю: диагноз
    // ставится по тексту уже брошенного исключения, а не по полю HTTP-тела.
    const PROVIDER_UNAVAILABLE_RE = new RegExp(
      `econnrefused|econnreset|socket hang up|${ENGINE_UNAVAILABLE_SUBSTRINGS.source}`,
      'i',
    );
    let lastRejectionReason: string | null = null;
    let rejectionStreak = 0;
    let systematicFailure: string | null = null;
    const trackRejection = (reason: unknown): string | null => {
      const text = ((reason as Error | undefined)?.message ?? String(reason)).slice(0, 300);
      rejectionStreak = text === lastRejectionReason ? rejectionStreak + 1 : 1;
      lastRejectionReason = text;
      if (systematicFailure === null && rejectionStreak >= SYSTEMATIC_FAILURE_STREAK) {
        const diagnosis = CONTEXT_SIZE_RE.test(text)
          ? `похоже, базовый промпт этой формы не помещается в окно контекста модели — дело не в бланке и не в конфиге, а в размере запроса (${this.contextNumbers()})`
          : PROVIDER_UNAVAILABLE_RE.test(text)
            ? 'похоже, модель недоступна прямо сейчас (не загружена или упал движок провайдера) — не конфиг и не бланк, проверь `lms ps`/`ollama ps` и перезагрузи модель'
            : 'похоже на сломанный конфиг модели, а не на бланк';
        systematicFailure =
          `провайдер вернул одну и ту же ошибку ${rejectionStreak} раз подряд на разных полях ` +
          `(${text}) — ${diagnosis}; дальнейшие поля не спрашивались`;
      }
      return systematicFailure;
    };
    /**
     * Успешный ответ поля рвёт серию отказов: без сброса счётчик шёл только по ветке
     * `rejected` и не видел перемежающиеся успехи — «раз подряд» в диагнозе выше было
     * неточным (три отказа через один успех тоже считались «подряд»), и часть полей могла
     * отвечать штатно, пока диагноз уже говорил о сломанном конфиге (code-review-all,
     * 2026-09-14).
     */
    const resetRejectionStreak = (): void => {
      rejectionStreak = 0;
      lastRejectionReason = null;
    };
    /**
     * Артефакты, запись которых ОТКЛОНИЛ гейт (политика или оператор): отказ окончательный,
     * второй проход их не трогает — иначе рантайм слал бы повторный Write после явного
     * «нет». Сбой ИСПОЛНЕНИЯ записи (fs) сюда не входит: он не решение человека, и второй
     * проход вправе попробовать снова.
     */
    const writeDenied = new Set<string>();
    /**
     * Тексты, собранные моделью, но не доехавшие до диска из-за СБОЯ ИСПОЛНЕНИЯ записи
     * (не отказа гейта): повторяется ЗАПИСЬ этого текста, а не работа модели — без этого
     * второй проход заново оплачивал все поля бланка и удваивал счётчик (ревью-3).
     */
    const pendingText = new Map<string, string>();
    /** Хоть одна запись состоялась — для честного хвоста сводки «записано через гейт». */
    let wroteAny = false;
    /** Ноты, которые не должны дублироваться вторым проходом. */
    const notedOnce = new Set<string>();

    /**
     * Незаполненные поля, оставшиеся НА ДИСКЕ, — один источник и для условия второго
     * прохода, и для честной сводки: счётчик по ходу прохода пропускал поля отклонённых
     * бланков и врал «осталось 0» (ревью-2). `retriableOnly` — для условия второго
     * прохода: бланки с отказом гейта пересчитывать незачем, проход по ним холостой.
     */
    const fieldsLeftOnDisk = (retriableOnly = false): number =>
      artifacts.reduce((n, p) => {
        if (retriableOnly && writeDenied.has(p)) return n;
        const a = readArtifact(p);
        if (!a.exists) return n;
        return (
          n +
          (this.o.compact
            ? this.compactFields(a.text, p).length
            : modelGroupFields(a.text, p).length)
        );
      }, 0);
    // Считается один раз, по бланкам на входе: `req.maxTurns` здесь не читается вовсе.
    const requestBudget = fillRequestBudget(fieldsLeftOnDisk());

    /**
     * Запись собранного текста через гейт — тем же путём, что любая запись исполнителя:
     * нормализованный Write, политика решает, оператор одобряет. Отказ гейта окончателен
     * (`writeDenied`); неудача исполнения — текст сохраняется в `pendingText` для
     * повторной записи. `true` — на диске.
     */
    const flushArtifact = async (path: string, text: string): Promise<boolean> => {
      const rel = relative(req.cwd, path);
      // Сам путь через гейт — общий `writeThroughGate` (им же пишет конвейер разведки);
      // здесь остаётся только учёт: отказ окончателен, сбой исполнения — на повтор.
      const written = await writeThroughGate(hooks, req, toolCtx, path, text, 'form');
      if (written.ok) {
        wroteAny = true;
        pendingText.delete(path);
        return true;
      }
      if (written.denied) {
        notes.push(`запись ${rel} отклонена: ${written.reason}`);
        writeDenied.add(path);
        pendingText.delete(path);
        return false;
      }
      notes.push(`запись ${rel} не удалась: ${written.reason}`);
      pendingText.set(path, text);
      return false;
    };

    /** Полевой до-запрос модели: промпт этапа + служебная обвязка поля (см. шапку файла). */
    const askField = async (path: string, text: string, range: FormField): ReturnType<ChatProvider['chat']> => {
      const needsCodeMap = range.kind === 'row' && CODE_MAP_HEADER.test(range.header);
      const codeMapText = needsCodeMap ? await codeMapGrounding() : '';
      const messages: ChatMessage[] = [
          { role: 'system', content: req.prompt.system },
          {
            role: 'user',
            content: [
              req.prompt.user,
              '',
              '## Сейчас — ровно одно поле',
              '',
              range.kind === 'row'
                ? `Файл \`${relative(req.cwd, path)}\`, секция бланка (последняя строка — образец):`
                : `Файл \`${relative(req.cwd, path)}\`, строка бланка:`,
              '',
              '```',
              range.kind === 'row' ? sectionAt(text, range.start) : lineAt(text, range.start),
              '```',
              '',
              // Заземление ТОЛЬКО для карты кодовой базы: у режима нет Read/Task (см. шапку
              // файла), и без списка реальных путей это единственное поле бланка, где модель
              // вынуждена либо угадывать пути по памяти, либо честно писать «новый» —
              // измерено живьём, что угадывает (см. комментарий у CODE_MAP_HEADER).
              ...(needsCodeMap
                ? [
                    '### Реальные файлы проекта (получены рантаймом обходом дерева, не твоей памятью)',
                    '',
                    codeMapText,
                    '',
                    'Называй в карте ТОЛЬКО пути из этого списка. Файл, которого в списке нет и ' +
                      'который предстоит СОЗДАТЬ по плану, помечай словом «новый» рядом с путём — ' +
                      'не выдавай его за уже существующий.',
                    '',
                  ]
                : []),
              range.kind === 'row'
                ? 'Последняя строка секции — ОБРАЗЕЦ строки таблицы, один на весь список. ' +
                  'Верни заполненные строки таблицы того же формата — столько, сколько ' +
                  'нужно по факту задачи и входных артефактов (каждая начинается с `|`), ' +
                  'без скобок ‹› и без пояснений вокруг. Соблюдай правила легенды секции и ' +
                  'текста этапа — обязательные теги (например `[edge]`) и формат id. ' +
                  'Если по задаче элемент ровно один — верни одну строку.' +
                  // Напоминание о минимуме повторено в инструкции поля, потому что легенду
                  // секции модели читают мимо (три модели тремя способами провалили ровно
                  // это поле). ЧИСЛА минимума здесь не называются намеренно: они — правило
                  // методологии, живут в тексте этапа (он в системном промпте выше), и
                  // копия чисел в коде разошлась бы с ним при первой правке (правило из
                  // build.ts, подтверждённое ревью).
                  (/claim-/.test(range.text)
                    ? ' Это ПРИЁМОЧНЫЙ ЛИСТ: правила этапа задают минимум числа пунктов и ' +
                      'обязательных [edge]-пометок — лист короче минимума роняет этап; ' +
                      'id строго в форме `claim-1`, `claim-2`, …'
                    : '')
                : `Верни ТОЛЬКО текст, которым надо заменить плейсхолдер \`${range.text}\` в этой ` +
                  'строке — без самих скобок ‹›, без пояснений вокруг, по факту задачи и входных ' +
                  'артефактов. Если поле требует решения человека, которого у тебя нет, верни ' +
                  '«требует решения человека: <что именно>» вместо выдуманного ответа.',
            ].join('\n'),
          },
        ];
      return this.ask(req, messages, hooks);
    };

    /**
     * Добор приёмочного листа: ответ поля-образца ниже нормы методологии дополняется
     * ОДНИМ повторным запросом сразу при заполнении, а не красной попыткой этапа.
     * Порог системный, не дисперсия: три модели тремя способами (loop, loop-повтор,
     * formFill) сдали лист без [edge]-минимума — r17, 2026-08-31. Числа порога модели
     * не называются (правило build.ts: норма живёт в тексте эта­па), называется дефицит
     * направления — «добавь граничные случаи».
     */
    const askClaimsTopUp = (
      path: string,
      text: string,
      range: FormField & { kind: 'row' },
      already: string,
      retry: boolean,
    ): ReturnType<ChatProvider['chat']> => {
      const messages: ChatMessage[] = [
          { role: 'system', content: req.prompt.system },
          {
            role: 'user',
            content: [
              req.prompt.user,
              '',
              '## Добор приёмочного листа',
              '',
              `Файл \`${relative(req.cwd, path)}\`, секция бланка:`,
              '',
              '```',
              sectionAt(text, range.start),
              '```',
              '',
              'Список уже заполнен так:',
              '',
              '```',
              already,
              '```',
              '',
              retry
                ? 'Предыдущий ответ дефицит не закрыл: добавленные строки не несли обязательный ' +
                  'тег `[edge]` в тексте строки (или их снова недостаточно) — просьба «прежде ' +
                  'всего граничные случаи» не выполнена буквально. Верни ТОЛЬКО дополнительные ' +
                  'строки таблицы, и КАЖДАЯ из них обязана быть граничным или негативным ' +
                  'случаем с литеральным тегом `[edge]` где-то в строке — не общий пункт без ' +
                  'тега. id продолжают нумерацию, уже написанные пункты не повторяются.'
                : 'Правил текста этапа этот список НЕ выполняет: пунктов и/или обязательных ' +
                  '`[edge]`-пометок меньше минимума. Верни ТОЛЬКО ДОПОЛНИТЕЛЬНЫЕ строки ' +
                  'таблицы того же формата — прежде всего граничные случаи с тегом `[edge]`, ' +
                  'id продолжают нумерацию, уже написанные пункты не повторяются.',
              // Замер 2026-09-04: просьба называла только ФОРМАТ, и лист приходил с нулём
              // граничных пунктов в 4 прогонах из 5. Образец содержания — из эталона.
              ...(this.o.edgeExample ?? []),
            ].join('\n'),
          },
        ];
      return this.ask(req, messages, hooks);
    };

    /**
     * Добор `files_to_touch`: пустой список после заполнения — не «оставить как есть»,
     * а один повторный запрос. Находка 2026-09-03 (bench, `ministral-14b`,
     * `security-bait`): пустая секция отключает `PlanScope` МОЛЧА (см. `planFiles.ts`),
     * и без добора это ловится только на входе в chunk — целый цикл `plan` тратится
     * впустую вместо одного лишнего запроса здесь же.
     */
    const askFilesToTouchTopUp = (
      path: string,
      text: string,
      range: FormField & { kind: 'row' },
    ): ReturnType<ChatProvider['chat']> => {
      const messages: ChatMessage[] = [
          { role: 'system', content: req.prompt.system },
          {
            role: 'user',
            content: [
              req.prompt.user,
              '',
              '## Добор files_to_touch',
              '',
              `Файл \`${relative(req.cwd, path)}\`, секция бланка:`,
              '',
              '```',
              sectionAt(text, range.start),
              '```',
              '',
              'Список путей пуст или не заполнен, а он обязателен: без него проверка ' +
                '«запись только в план» отключится молча. Верни ТОЛЬКО строки таблицы того ' +
                'же формата — хотя бы один путь, который реально будет затронут.',
            ].join('\n'),
          },
        ];
      return this.ask(req, messages, hooks);
    };

    /**
     * Карточка поля вместо строки/секции бланка (`compact`): id, вид, допустимые
     * значения, минимум, альтернатива «пусто» — модель отвечает ЗНАЧЕНИЕМ по грамматике
     * `artifacts/sheet.ts`, а не куском разметки. Хинт режется явно: `field.hint` уже
     * ограничен внутри `deriveSchema`, но легенда секции могла набежать за несколько
     * абзацев на многострочном поле.
     */
    const askFieldCompact = (field: SchemaField): ReturnType<ChatProvider['chat']> => {
      const card = [
        `## Сейчас — ровно одно поле`,
        '',
        `- id: \`${field.id}\``,
        `- вид: ${field.kind}`,
        ...(field.options === undefined
          ? []
          : [`- варианты: ${field.options.map((o) => `\`${o.key}\``).join(', ')}`]),
        ...(field.columns === undefined
          ? []
          : [`- колонки записи: ${field.columns.filter((c) => c.kind !== 'mechanical').map((c) => `\`${c.id}\``).join(', ')}`]),
        ...(field.min === undefined ? [] : [`- минимум строк: ${field.min.rows}, из них с тегом [edge]: ${field.min.edges ?? 0}`]),
        ...(field.emptyAlternative === undefined ? [] : [`- если элементов нет — ответь пустой строкой`]),
        `- подсказка: ${field.hint === '' ? '(нет)' : field.hint.slice(0, 800)}`,
        '',
        '## Формат ответа',
        '',
        field.kind === 'choice'
          ? 'Верни ТОЛЬКО ключ выбранного варианта (слово или значок из списка «варианты» ' +
            'выше), и если по смыслу нужен комментарий — через тире после ключа. Без ‹›, ' +
            'без пересказа условия.'
          : field.kind === 'list'
            ? 'Верни по одному пункту на строку, каждая начинается с `- `. Метку поля ' +
              '(«- **Метка:**») не повторяй.'
            : field.kind === 'records'
              ? 'Верни по одной записи на элемент: `- значение1 — значение2` (по порядку ' +
                'колонок из списка выше), либо `- колонка: значение` под отдельной строкой ' +
                'на каждую колонку, если значений больше двух. Id/номер не указывай — его ' +
                'проставит рантайм.'
              : 'Верни ТОЛЬКО значение поля — без метки, без ‹›, без пояснений вокруг.',
        // Образец граничного пункта — только там, где схема их и требует: на прочих полях
        // он был бы шумом в окне.
        ...(field.min?.edges !== undefined && field.min.edges > 0 ? (this.o.edgeExample ?? []) : []),
      ].join('\n');

      const messages: ChatMessage[] = [
          { role: 'system', content: req.prompt.system },
          { role: 'user', content: [req.prompt.user, '', card].join('\n') },
        ];
      return this.ask(req, messages, hooks);
    };

    /** Добор записи ниже минимума (`compact`) — та же идея, что `askClaimsTopUp`, через `applyFill('add')`. */
    const askTopUpCompact = (
      field: SchemaField,
      already: string,
      retry: boolean,
    ): ReturnType<ChatProvider['chat']> => {
      const messages: ChatMessage[] = [
          { role: 'system', content: req.prompt.system },
          {
            role: 'user',
            content: [
              req.prompt.user,
              '',
              `## Добор поля \`${field.id}\``,
              '',
              `Уже отвечено:\n\`\`\`\n${already}\n\`\`\``,
              '',
              retry
                ? `Предыдущий ответ дефицит не закрыл (нужно не меньше ${field.min?.rows ?? 0}` +
                  (field.min?.edges === undefined || field.min.edges === 0 ? '' : `, из них с [edge] не меньше ${field.min.edges}`) +
                  '). Верни ТОЛЬКО дополнительные записи, и если дефицит именно по `[edge]` — ' +
                  'каждая новая запись обязана быть граничным или негативным случаем с ' +
                  'литеральным тегом `[edge]`, не общей записью без тега.'
                : `Строк меньше минимума методологии (нужно не меньше ${field.min?.rows ?? 0}` +
                  (field.min?.edges === undefined || field.min.edges === 0 ? '' : `, из них с [edge] не меньше ${field.min.edges}`) +
                  '). Верни ТОЛЬКО дополнительные записи в том же формате — уже названные не повторяй.',
              ...(field.min?.edges !== undefined && field.min.edges > 0 ? (this.o.edgeExample ?? []) : []),
            ].join('\n'),
          },
        ];
      return this.ask(req, messages, hooks);
    };

    /**
     * Бюджет исчерпан — общая проверка для обоих режимов, после каждой пачки.
     */
    const budgetHit = (): string | null => {
      const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
      if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
        return `бюджет прогона исчерпан: ${money(spent, currency)} из ${money(req.maxBudgetUsd, currency)}`;
      }
      return null;
    };

    /**
     * Проход по ОДНОМУ бланку в режиме `compact`: поля — `deriveSchema`/`modelFields`
     * вместо `groupFields`, ответ рисует `applyFill`. Добор записи ниже минимума — теми
     * же СЫРЫМИ ТЕКСТАМИ ответов, склеенными до единственного вызова `applyFill`: поле,
     * уже заполненное ОДИН раз, из схемы исчезает (строка без `‹…›` не образец), и второй
     * `applyFill('add')` на том же id её бы не нашёл — то же правило, что у «незаполненное
     * место и есть определение поля» в герметичных тестах.
     */
    const sweepArtifactCompact = async (
      path: string,
      startText: string,
    ): Promise<{ stop: StageResult | null; changed: boolean; text: string }> => {
      let text = startText;
      let changed = false;
      const fields = this.compactFields(text, path);

      for (let batchStart = 0; batchStart < fields.length; batchStart += FIELD_PARALLEL) {
        if (req.signal.aborted) return { stop: { ok: false, finalText: '', usage, note: 'этап отменён' }, changed, text };

        const allowed = Math.min(FIELD_PARALLEL, requestBudget - callsSpent);
        const batch = fields.slice(batchStart, batchStart + FIELD_PARALLEL);
        if (allowed <= 0) continue;
        const asked = batch.slice(0, allowed);
        callsSpent += asked.length;

        const answers = await Promise.allSettled(asked.map((f) => askFieldCompact(f)));
        for (const a of answers) {
          if (a.status !== 'fulfilled') continue;
          usage = addUsage(usage, a.value.usage);
          hooks.onUsage(a.value.usage);
        }

        for (const [idx, field] of asked.entries()) {
          const a = answers[idx]!;
          if (a.status !== 'fulfilled') {
            const why = (a.reason as Error | undefined)?.message ?? String(a.reason);
            noteEnvFailure(a.reason);
            const systematic = trackRejection(a.reason);
            if (systematic !== null) return { stop: { ok: false, finalText: '', usage, note: systematic }, changed, text };
            notes.push(`поле не спрошено (${relative(req.cwd, path)}, ${field.id}): ${why.slice(0, 160)}`);
            continue;
          }
          resetRejectionStreak();

          let answerText = a.value.text;

          // Добор ДО commit'а: минимум листа проверяется по СЫРОМУ ответу, вопрос
          // задаётся один раз, оба текста склеиваются, и только тогда — единственный
          // applyFill. Дубли верхнего уровня из повторного ответа модели отсекаются по
          // нормализованному содержимому строки, тем же приёмом, что у legacy-добора.
          if (field.kind === 'records' && field.min !== undefined && callsSpent < requestBudget) {
            const min = field.min;
            // Тот же класс бага, что у legacy-добора (askClaimsTopUp): один выстрел без
            // перепроверки засчитывал добор успешным, даже если добавленные записи не
            // несли [edge]. Сейчас неактивно (compactForms откачен у обеих моделей,
            // config/models.json), но мина остаётся, пока режим не включат снова.
            const shortfall = (v: string): { rows: number; edges: number } | null => {
              const peek = parseFieldValue(field, v);
              if (isSheetError(peek) || peek.kind !== 'records') return null;
              const edges = peek.rows.filter((r) => Object.values(r).some((val) => /\[edge\]/i.test(val))).length;
              return peek.rows.length < min.rows || edges < (min.edges ?? 0)
                ? { rows: peek.rows.length, edges }
                : null;
            };
            for (let attempt = 0; attempt < CLAIMS_TOPUP_ATTEMPTS && callsSpent < requestBudget; attempt++) {
              if (shortfall(answerText) === null) break;
              callsSpent++;
              try {
                const more = await askTopUpCompact(field, answerText, attempt > 0);
                usage = addUsage(usage, more.usage);
                hooks.onUsage(more.usage);
                const seen = new Set(
                  answerText
                    .split('\n')
                    .map((l) => l.trim().toLowerCase())
                    .filter((l) => l !== ''),
                );
                const fresh = more.text
                  .split('\n')
                  .filter((l) => !seen.has(l.trim().toLowerCase()))
                  .join('\n');
                if (fresh.trim() !== '') answerText = `${answerText}\n${fresh}`;
                notes.push(`добор поля ${field.id} (попытка ${attempt + 1}): запрошен и добавлен`);
              } catch (e) {
                const why = e instanceof Error ? e.message : String(e);
                noteEnvFailure(e);
                notes.push(`добор поля ${field.id} не удался: ${why.slice(0, 160)}`);
                break;
              }
            }
            const stillShort = shortfall(answerText);
            if (stillShort !== null) {
              notes.push(
                `добор поля ${field.id} не закрыл минимум за ${CLAIMS_TOPUP_ATTEMPTS} попытки: ` +
                  `строк ${stillShort.rows} (нужно ${min.rows})` +
                  (min.edges ? `, [edge] ${stillShort.edges} (нужно ${min.edges})` : '') +
                  ' — этап 3 отклонит',
              );
            }
          }

          const applied = applyFill(text, field.id, answerText, 'set', templateNameFor(path));
          if (!applied.ok) {
            notes.push(`поле ${field.id} не заполнено: ${applied.problem}`);
            continue;
          }
          text = applied.text;
          fieldsFilled++;
          changed = true;
        }

        const over = budgetHit();
        if (over !== null) return { stop: { ok: false, finalText: '', usage, note: over }, changed, text };
      }

      return { stop: null, changed, text };
    };

    /**
     * Проход по бланкам. `StageResult` — обрыв всего этапа (бюджет, отмена), `null` —
     * проход закончен штатно. Вынесен в функцию ради ВТОРОГО прохода: поле, не взятое
     * одним сэмплом (пустой ответ, ответ с плейсхолдером), со второго захода часто
     * берётся — дисперсия дешёвых моделей работает и в эту сторону, а незакрытое поле
     * стоит целой красной попытки этапа.
     */
    const sweep = async (): Promise<StageResult | null> => {
      for (const path of artifacts) {
        // Отмена возвращается без записи собранного: запись идёт через гейт одобрения, а
        // оператор, нажавший отмену, уходит — ждать его решения на прощальном Write нельзя.
        // Оплаченные ответы этой цены отмены не отменяют, и это названо, а не спрятано.
        if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };
        if (writeDenied.has(path)) continue;

        // Текст, не доехавший до диска из-за сбоя записи, ПЕРЕЗАПИСЫВАЕТСЯ, а не
        // пересобирается моделью: поля в нём уже оплачены. Не записался снова — модель
        // не переспрашивается всё равно (запись не идёт, оплата ушла бы в никуда).
        const pending = pendingText.get(path);
        if (pending !== undefined) {
          await flushArtifact(path, pending);
          continue;
        }

        const artifact = readArtifact(path);
        if (!artifact.exists) {
          // Бланк не разложен — это дефект посева, а не модели: пропускаем с пометкой,
          // страж завершения назовёт незаписанный артефакт сам.
          const note = `бланк ${path} не найден — рантайм его не разложил`;
          if (!notedOnce.has(note)) {
            notedOnce.add(note);
            notes.push(note);
          }
          continue;
        }

        let text = artifact.text;

        if (this.o.compact) {
          const outcome = await sweepArtifactCompact(path, text);
          // Оплаченные ответы не выбрасываются даже при обрыве (бюджет, отмена) — тот же
          // принцип, что у некомпактного пути ниже: флаш ПЕРЕД возвратом `stop`, иначе
          // накопленный `outcome.text` теряется вместе с уже оплаченными полями.
          if (outcome.changed) await flushArtifact(path, outcome.text);
          if (outcome.stop !== null) return outcome.stop;
          continue;
        }

        // С конца к началу: сплайс не сдвигает позиции ещё не обработанных диапазонов.
        // Строка таблицы с плейсхолдерами — поле-ОБРАЗЕЦ, одно на весь будущий список
        // (пункты приёмки, вопросы): спрошенная «по одному полю» она давала список из
        // одного пункта. Заполняется целиком, ответ может быть несколькими строками.
        const ranges = modelGroupFields(text, path).reverse();
        let changed = false;

        // Поля независимы и идут пачками: последовательное дозаполнение журнала занимало
        // ~40 с чистого ожидания сети на десяток полей. Ответы собираются на НЕИЗМЕНЁННОМ
        // тексте (позиции и строки всех полей пачки посчитаны до первого сплайса), сплайсы
        // применяются после пачки — в том же порядке «с конца», что и раньше.
        for (let batchStart = 0; batchStart < ranges.length; batchStart += FIELD_PARALLEL) {
          if (req.signal.aborted) return { ok: false, finalText: '', usage, note: 'этап отменён' };

          // Потолок вызовов — тот же лимит ходов этапа: поле дешевле хода, но безлимитный
          // бланк на сотню плейсхолдеров съел бы больше, чем обычный цикл.
          const allowed = Math.min(FIELD_PARALLEL, requestBudget - callsSpent);
          const batch = ranges.slice(batchStart, batchStart + FIELD_PARALLEL);
          if (allowed <= 0) continue;
          const asked = batch.slice(0, allowed);
          callsSpent += asked.length;

          // `allSettled`, не `all`: отказ одного запроса пачки не должен ни ронять этап,
          // ни терять usage успевших соседей — их токены уже оплачены и обязаны попасть
          // в бюджет. Упавший запрос — просто незаполненное поле.
          const answers = await Promise.allSettled(asked.map((range) => askField(path, text, range)));

          for (const a of answers) {
            if (a.status !== 'fulfilled') continue;
            usage = addUsage(usage, a.value.usage);
            hooks.onUsage(a.value.usage);
          }

          // Сплайсы — ДО проверки бюджета: ответы пачки уже оплачены в любом случае, и
          // выбрасывать их из текста при обрыве значило бы платить за них второй раз.
          for (const [idx, range] of asked.entries()) {
            const a = answers[idx]!;
            if (a.status !== 'fulfilled') {
              const why = (a.reason as Error | undefined)?.message ?? String(a.reason);
              noteEnvFailure(a.reason);
              const systematic = trackRejection(a.reason);
              if (systematic !== null) return { ok: false, finalText: '', usage, note: systematic };
              notes.push(
                `поле не спрошено (${relative(req.cwd, path)}, ` +
                  `${range.kind === 'row' ? 'строка таблицы' : range.text}): ${why.slice(0, 160)}`,
              );
              continue;
            }
            resetRejectionStreak();
            let filled = cleanFieldAnswer(a.value.text);
            if (range.kind === 'row') filled = cleanRowAnswer(filled, range.header);
            if (
              (filled === '' || filled.includes('‹')) &&
              range.kind === 'row' &&
              FILES_TO_TOUCH_HEADER.test(range.header) &&
              callsSpent < requestBudget
            ) {
              callsSpent++;
              try {
                const more = await askFilesToTouchTopUp(path, text, range);
                usage = addUsage(usage, more.usage);
                hooks.onUsage(more.usage);
                const extra = cleanRowAnswer(cleanFieldAnswer(more.text), range.header);
                if (extra !== '' && !extra.includes('‹')) {
                  filled = extra;
                  notes.push(`добор files_to_touch: список был пуст, добавлено ${extra.split('\n').length} строк`);
                } else {
                  notes.push('добор files_to_touch не удался: список снова пуст');
                }
              } catch (e) {
                const why = e instanceof Error ? e.message : String(e);
                noteEnvFailure(e);
                notes.push(`добор files_to_touch не удался: ${why.slice(0, 160)}`);
              }
            }
            // Пустой ответ и ответ с плейсхолдером полем не считаются: диапазон остаётся
            // как был, и его честно назовут страж и предусловие следующего этапа.
            if (filled === '' || filled.includes('‹')) continue;
            // Лист приёмки ниже нормы полного контура — один добор на месте. Мелкому
            // контуру переизбыток пунктов не вредит (его мягкий минимум знает гейт).
            if (range.kind === 'row' && /claim-/.test(range.text) && callsSpent < requestBudget) {
              // Один выстрел без перепроверки однажды считал добор успешным, даже если
              // добавленные строки не несли [edge]: заметка «добавлено M» писалась
              // независимо от факта, а предусловие explore честно находило тот же
              // дефицит (r-серия свипа 2026-09-04, docs/model-runs.md). Теперь после
              // каждой попытки — реальный пересчёт `countClaims`, вторая попытка (если
              // нужна) называет дефицит прямо, а не повторяет ту же общую просьбу.
              for (let attempt = 0; attempt < CLAIMS_TOPUP_ATTEMPTS && callsSpent < requestBudget; attempt++) {
                const have = countClaims(filled);
                if (have.rows >= CLAIMS_MINIMUM.rows && have.edges >= CLAIMS_MINIMUM.edges) break;
                callsSpent++;
                try {
                  const more = await askClaimsTopUp(path, text, range, filled, attempt > 0);
                  usage = addUsage(usage, more.usage);
                  hooks.onUsage(more.usage);
                  const extra = cleanRowAnswer(cleanFieldAnswer(more.text), range.header);
                  // Модели на добор часто возвращают ВЕСЬ лист заново с теми же id —
                  // фильтр «дубль id → в мусор» выбрасывал и новые пункты (r17e, лист
                  // остался 4/1). Дословный повтор пункта отбрасывается по СОДЕРЖИМОМУ,
                  // а новый пункт под занятым id перенумеровывается: счёт гейта не
                  // надувается дублями, но и добор не пропадает.
                  const bodyOf = (l: string): string =>
                    l.replace(/^\s*\|\s*`?claim-\d+\b[^|]*\|/, '').replace(/\s+/g, ' ').trim();
                  const seenIds = new Set(filled.split('\n').map(claimIdOf));
                  const seenBodies = new Set(filled.split('\n').map(bodyOf));
                  let nextN =
                    Math.max(
                      0,
                      ...filled
                        .split('\n')
                        .map((l) => Number(/claim-(\d+)/.exec(l)?.[1] ?? 0)),
                    ) + 1;
                  const fresh = extra
                    .split('\n')
                    .filter((l) => l.trim() !== '' && !l.includes('‹'))
                    .filter((l) => claimIdOf(l) !== null && !seenBodies.has(bodyOf(l)))
                    .map((l) => {
                      const id = claimIdOf(l)!;
                      if (!seenIds.has(id)) {
                        seenIds.add(id);
                        return l;
                      }
                      return l.replace(/claim-\d+/, `claim-${nextN++}`);
                    })
                    .join('\n');
                  if (fresh !== '') filled = `${filled}\n${fresh}`;
                  const now = countClaims(filled);
                  notes.push(
                    `добор листа приёмки (попытка ${attempt + 1}): модель вернула ${extra.split('\n').length} ` +
                      `строк, добавлено ${fresh === '' ? 0 : fresh.split('\n').length} — теперь ` +
                      `пунктов ${now.rows}, [edge] ${now.edges}`,
                  );
                } catch (e) {
                  const why = e instanceof Error ? e.message : String(e);
                  notes.push(`добор листа приёмки не удался: ${why.slice(0, 160)}`);
                  break;
                }
              }
              const stillShort = countClaims(filled);
              if (stillShort.rows < CLAIMS_MINIMUM.rows || stillShort.edges < CLAIMS_MINIMUM.edges) {
                notes.push(
                  `добор листа приёмки не закрыл минимум за ${CLAIMS_TOPUP_ATTEMPTS} попытки: ` +
                    `пунктов ${stillShort.rows} (нужно ${CLAIMS_MINIMUM.rows}), [edge] ${stillShort.edges} ` +
                    `(нужно ${CLAIMS_MINIMUM.edges}) — этап 3 отклонит`,
                );
              }
            }
            text = text.slice(0, range.start) + filled + text.slice(range.end);
            fieldsFilled++;
            changed = true;
          }

          // Бюджет проверяется после пачки: цена известна только по факту, а пачка — это
          // и есть один «ход» режима. Собранный текст ПЕРЕД обрывом записывается через
          // гейт: оплаченные ответы не выбрасываются.
          const spent = usage.costUsd === null ? null : usage.costUsd + (req.spentUsdBefore ?? 0);
          if (req.maxBudgetUsd !== null && spent !== null && spent >= req.maxBudgetUsd) {
            if (changed) await flushArtifact(path, text);
            return {
              ok: false,
              finalText: '',
              usage,
              note:
                `бюджет прогона исчерпан: ${money(spent, currency)} из ` +
                `${money(req.maxBudgetUsd, currency)}`,
            };
          }
        }

        if (changed) await flushArtifact(path, text);
      }
      return null;
    };

    // Обрыв (бюджет, отмена, систематический отказ) уносит число запросов и отказ среды:
    // без них вызывающий (`ExploreExecutor`, `Run.finishFormArtifact`) терял оплаченные
    // запросы оборванного дозаполнения из учёта.
    const withSpent = (r: StageResult): StageResult => ({
      ...r,
      modelRequests: callsSpent,
      ...(envFailure === null || r.envFailure !== undefined ? {} : { envFailure }),
    });
    const stopped = await sweep();
    if (stopped !== null) return withSpent(stopped);
    // Второй проход — только когда есть ЧТО добирать: остатки в бланках без отказа гейта
    // (эти стоят ходов модели — нужен запас лимита) либо недоехавшая запись (перезапись
    // БЕСПЛАТНА и лимитом ходов не запирается — иначе оплаченный текст, ради спасения
    // которого pendingText заведён, терялся бы ровно на исчерпанном лимите, ревью-4).
    const leftRetriable = fieldsLeftOnDisk(true);
    const retriable = (leftRetriable > 0 && callsSpent < requestBudget) || pendingText.size > 0;
    let secondSweep = false;
    if (retriable && !req.signal.aborted) {
      secondSweep = true;
      const stopped2 = await sweep();
      if (stopped2 !== null) return withSpent(stopped2);
    }
    // Каждый пересчёт — чтение всех бланков и `deriveSchema`. Без отказов гейта «только
    // пересчитываемые» и «все» — одно и то же число, а без второго прохода диск с тех пор
    // не менялся: перечитывать незачем.
    const fieldsLeft = secondSweep || writeDenied.size > 0 ? fieldsLeftOnDisk() : leftRetriable;

    // «Заполнено в тексте» — не «записано на диск»: отклонённая гейтом запись оставляет
    // бланк нетронутым, и сводка обязана это различать, а не отчитываться сделанным.
    // «Осталось» считается ПО ДИСКУ, включая бланки с отклонённой записью; «записано
    // через гейт» говорится только о состоявшейся записи.
    const summary =
      `заполнение по полям: в тексте заполнено ${fieldsFilled}, осталось на диске ${fieldsLeft}` +
      (notes.length > 0 ? `; ${notes.join('; ')}` : wroteAny ? '; записано через гейт' : '');
    hooks.onText(summary);

    // Последнее слово — за диском, как и в обычном цикле: страж смотрит артефакты, а не
    // наш счётчик полей.
    const complaint = req.finishGuard === null ? null : req.finishGuard();
    // `envFailure` переживает и зелёный исход: этап мог дозаполнить бланк со второй
    // попытки, но прогон, в котором апстрим отказывал, измерением модели не является.
    const env = envFailure === null ? {} : { envFailure };
    if (complaint !== null) {
      return { ok: false, finalText: summary, usage, note: complaint, modelRequests: callsSpent, ...env };
    }
    return { ok: true, finalText: summary, usage, note: summary, modelRequests: callsSpent, ...env };
  }
}
