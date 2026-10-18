/**
 * Лента витка (`.events.ndjson` раннера либо копия стенда в `bench/traces/<slug>/`) в срезе
 * по этапам: что этап получил (промпт) и выдал (ответ модели, гейты, вердикт, исход) в
 * ПОСЛЕДНЕМ своём прогоне.
 *
 * В одном файле события нескольких `runId`: ключ ленты — слаг, а `Run.id` не переживает
 * рестарт. «Последний прогон» поэтому — от последнего `stage_started` этапа, а не от
 * последнего `run_started`. Промпт берётся только ВНУТРИ прогона: `prompt_prepared` до
 * `stage_started` — это предпросмотр оператора, который мог и не уйти в модель.
 *
 * Прогон принадлежит своему `runId`: новый `run_started` значит, что прежний процесс раннера
 * закончился, и его незакрытые этапы — оборваны. Иначе ошибка отказа входа нового `Run`
 * после рестарта дописывалась в незакрытый прогон умершего и превращалась в «этап упал».
 *
 * Один редьюсер на два потребителя: деталь (полный индекс с текстами, по требованию) и
 * карточка (сводка без текстов, дочитывается по смещению — лента живого витка растёт, и
 * полный разбор на каждый опрос стоил бы мегабайты на тик).
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs';

import type { DashboardStageRun, RunEvent, StageId } from '@sdlc-runner/shared';

export interface EventIndex {
  /** `run_started` по порядку. */
  runIds: string[];
  /** Последний прогон каждого этапа. */
  stages: Map<StageId, DashboardStageRun>;
  /**
   * Этапы, чей последний прогон не удался: `stage_done{ok:false}`, прогон, начатый и не
   * закрытый к концу ленты (процесс умер посреди этапа), либо упавший исключением.
   */
  failed: Map<StageId, string>;
  /** Этапы, начатые ТЕКУЩИМ `runId` и не закрытые к концу ленты. */
  open: Set<StageId>;
  /**
   * Незакрытые этапы, в чьём прогоне была ошибка: так выглядит этап, упавший исключением
   * (`Run.runStage` в `catch` шлёт `error`, но не `stage_done`). Это провал, а не обрыв и
   * не «идёт» — даже у живого витка.
   */
  openErrors: Map<StageId, string>;
}

/** Лёгкая выжимка для карточки: без промптов и ответов модели. */
export interface EventSummary {
  runIds: string[];
  failed: Map<StageId, string>;
  open: Set<StageId>;
  openErrors: Map<StageId, string>;
  /** Сколько этапов лента видела запущенными — признак, что виток шёл в раннере. */
  stagesRun: number;
  /** Растёт с каждым дочитанным событием: ключ пересборки карточки. */
  version: number;
}

/** Лента больше этого не разбирается целиком для детали: трасса стенда бывает в сотни мегабайт. */
const MAX_EVENTS_BYTES = 64 * 1024 * 1024;

function freshRun(runId: string): DashboardStageRun {
  return {
    runId,
    flow: null,
    provider: null,
    model: null,
    prompt: null,
    assistantText: '',
    gates: [],
    verdict: null,
    outcome: null,
    warnings: [],
    errors: [],
    toolCalls: 0,
  };
}

/**
 * Свёртка событий. `keepText: false` — без промптов, ответов и гейтов: для карточки нужны
 * только исходы, а держать тексты всех витков в памяти значило копить мегабайты.
 */
export class EventReducer {
  private readonly keepText: boolean;
  readonly runIds: string[] = [];
  private readonly last = new Map<StageId, DashboardStageRun>();
  private readonly open = new Map<StageId, DashboardStageRun>();
  private readonly failed = new Map<StageId, string>();
  private readonly started = new Set<StageId>();
  private currentRun: string | null = null;
  version = 0;

  constructor(keepText: boolean) {
    this.keepText = keepText;
  }

  /** Незакрытые прогоны прежнего процесса — оборваны: этап начат, но не закрыт. */
  private orphanOpen(): void {
    for (const [stage, r] of this.open) this.failed.set(stage, this.openNote(r));
    this.open.clear();
  }

  private openNote(r: DashboardStageRun): string {
    const err = r.errors[r.errors.length - 1];
    return err !== undefined ? `этап упал: ${err}` : 'прогон оборван: этап начат, но не закрыт';
  }

  /** Открытый прогон этапа ЭТОГО `runId`; прогон чужого процесса — не его. */
  private openFor(stage: StageId, runId: string): DashboardStageRun | undefined {
    const r = this.open.get(stage);
    return r !== undefined && r.runId === runId ? r : undefined;
  }

  feed(e: RunEvent): void {
    this.version += 1;
    switch (e.type) {
      case 'run_started':
        if (this.currentRun !== null && this.currentRun !== e.runId) this.orphanOpen();
        this.currentRun = e.runId;
        if (!this.runIds.includes(e.runId)) this.runIds.push(e.runId);
        break;
      case 'stage_started': {
        const r = freshRun(e.runId);
        r.flow = e.flow;
        r.provider = e.provider;
        r.model = e.model;
        this.open.set(e.stage, r);
        this.last.set(e.stage, r);
        this.failed.delete(e.stage);
        this.started.add(e.stage);
        break;
      }
      case 'prompt_prepared': {
        const r = this.openFor(e.stage, e.runId);
        if (r !== undefined && this.keepText) {
          r.prompt = {
            system: e.prompt.system,
            user: e.prompt.user,
            toolNames: e.prompt.tools.map((t) => t.name),
            editedByOperator: e.prompt.editedByOperator,
          };
        }
        break;
      }
      case 'assistant_text': {
        const r = this.openFor(e.stage, e.runId);
        if (r !== undefined && this.keepText) r.assistantText += r.assistantText === '' ? e.text : `\n\n${e.text}`;
        break;
      }
      case 'tool_request': {
        const r = this.openFor(e.stage, e.runId);
        if (r !== undefined) r.toolCalls += 1;
        break;
      }
      case 'gate_result':
        if (this.keepText) this.openFor(e.stage, e.runId)?.gates.push(e.gate);
        break;
      case 'verdict': {
        const r = this.openFor(e.stage, e.runId) ?? this.last.get(e.stage);
        if (r !== undefined) r.verdict = e.verdict;
        break;
      }
      case 'stage_done': {
        // Пропуск (`skipIf`) закрывается `stage_done` без `stage_started` — и у него есть
        // что показать: причину пропуска.
        const r = this.openFor(e.stage, e.runId) ?? freshRun(e.runId);
        r.outcome = { ok: e.ok, note: e.note };
        this.open.delete(e.stage);
        this.last.set(e.stage, r);
        this.started.add(e.stage);
        if (e.ok) this.failed.delete(e.stage);
        else this.failed.set(e.stage, e.note === '' ? 'этап не удался' : e.note);
        break;
      }
      case 'warning':
      case 'error': {
        if (e.stage === null) break;
        const r = this.openFor(e.stage, e.runId);
        if (r === undefined) {
          // Отказ до `stage_started` — этап не стартовал: блокеры входа приходят ошибкой.
          // Ошибка дописывается к ПРОШЛОМУ прогону этапа, а не заменяет его: иначе отказ
          // повторного запуска стирал промпт, ответ и гейты состоявшегося прогона. Отметка
          // прошлого провала при этом снимается: этап сейчас не «провален», а не пускается,
          // и карточка обязана показать текущую причину (блокеры фронта), а не старую.
          if (e.type === 'warning') break;
          let prev = this.last.get(e.stage);
          if (prev === undefined) {
            prev = freshRun(e.runId);
            this.last.set(e.stage, prev);
          }
          prev.errors.push(`не стартовал: ${e.message}`);
          this.failed.delete(e.stage);
          break;
        }
        (e.type === 'error' ? r.errors : r.warnings).push(e.message);
        break;
      }
      default:
        break;
    }
  }

  /** Индекс на сейчас; состояние редьюсера не меняется — его можно кормить дальше. */
  index(): EventIndex {
    const failed = new Map(this.failed);
    const openErrors = new Map<StageId, string>();
    for (const [stage, r] of this.open) {
      const err = r.errors[r.errors.length - 1];
      if (err !== undefined) openErrors.set(stage, err);
      if (err !== undefined || !failed.has(stage)) failed.set(stage, this.openNote(r));
    }
    return { runIds: [...this.runIds], stages: this.last, failed, open: new Set(this.open.keys()), openErrors };
  }

  summary(): EventSummary {
    const i = this.index();
    return { runIds: i.runIds, failed: i.failed, open: i.open, openErrors: i.openErrors, stagesRun: this.started.size, version: this.version };
  }
}

export function indexEvents(events: readonly RunEvent[]): EventIndex {
  const r = new EventReducer(true);
  for (const e of events) r.feed(e);
  return r.index();
}

// ── чтение с диска ─────────────────────────────────────────────────────────

/**
 * Разбор строк NDJSON. Недописанная последняя строка (запись идёт прямо сейчас) не
 * разбирается и не считается битой — её дочитают следующим проходом.
 */
function feedLines(reducer: EventReducer, text: string): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      reducer.feed(JSON.parse(line) as RunEvent);
    } catch {
      // Битая строка (обрыв записи при падении процесса) пропускается молча: предупреждать
      // о ней на каждом опросе значило засорять консоль сервера каждые пять секунд.
    }
  }
}

function readRange(path: string, from: number, to: number): Buffer {
  const len = Math.max(0, to - from);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  let got = 0;
  try {
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, from + got);
      if (n === 0) break;
      got += n;
    }
  } finally {
    closeSync(fd);
  }
  return buf.subarray(0, got);
}

const EMPTY_SUMMARY: EventSummary = { runIds: [], failed: new Map(), open: new Set(), openErrors: new Map(), stagesRun: 0, version: 0 };

/** Сводки дочитываются по смещению: у живого витка лента растёт между опросами. */
const summaries = new Map<string, { offset: number; reducer: EventReducer; summary: EventSummary }>();
const SUMMARIES_MAX = 4000;

/**
 * Сводка ленты для карточки: дочитывает только новые строки. Файл стал короче (перезаписан)
 * — разбор с начала. Смещение двигается только до последнего перевода строки: недописанная
 * строка разбирается в следующий раз целиком.
 */
export function readEventSummary(path: string): EventSummary {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    summaries.delete(path);
    return EMPTY_SUMMARY;
  }
  let entry = summaries.get(path);
  if (entry !== undefined && size === entry.offset) return entry.summary;
  if (entry === undefined || size < entry.offset) {
    entry = { offset: 0, reducer: new EventReducer(false), summary: EMPTY_SUMMARY };
  }
  const chunk = readRange(path, entry.offset, size);
  const lastNl = chunk.lastIndexOf(0x0a);
  if (lastNl >= 0) {
    feedLines(entry.reducer, chunk.subarray(0, lastNl + 1).toString('utf8'));
    entry.offset += lastNl + 1;
    entry.summary = entry.reducer.summary();
  }
  summaries.delete(path);
  summaries.set(path, entry);
  while (summaries.size > SUMMARIES_MAX) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
  return entry.summary;
}

const EMPTY_INDEX: EventIndex = { runIds: [], stages: new Map(), failed: new Map(), open: new Set(), openErrors: new Map() };

/** Кэш полного индекса (с текстами) — только для деталей, поэтому маленький. */
const lru = new Map<string, { mtimeMs: number; size: number; index: EventIndex }>();
const LRU_MAX = 16;

/**
 * Полный индекс ленты по пути файла — для детали. Нет файла — пустой индекс; лента больше
 * потолка — пустой индекс с пометкой вместо разбора (синхронный разбор сотен мегабайт
 * остановил бы сервер на секунды).
 */
export function readEventIndex(path: string): EventIndex & { tooLarge: boolean } {
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    lru.delete(path);
    return { ...EMPTY_INDEX, tooLarge: false };
  }
  if (st.size > MAX_EVENTS_BYTES) return { ...EMPTY_INDEX, tooLarge: true };
  const hit = lru.get(path);
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    lru.delete(path);
    lru.set(path, hit);
    return { ...hit.index, tooLarge: false };
  }
  const reducer = new EventReducer(true);
  const buf = readRange(path, 0, st.size);
  const lastNl = buf.lastIndexOf(0x0a);
  // Недописанный хвост без перевода строки — запись идёт сейчас; разберётся в следующий раз.
  feedLines(reducer, buf.subarray(0, lastNl >= 0 ? lastNl + 1 : buf.length).toString('utf8'));
  const index = reducer.index();
  lru.set(path, { mtimeMs: st.mtimeMs, size: st.size, index });
  while (lru.size > LRU_MAX) {
    const oldest = lru.keys().next().value;
    if (oldest === undefined) break;
    lru.delete(oldest);
  }
  return { ...index, tooLarge: false };
}
