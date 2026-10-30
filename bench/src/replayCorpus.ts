/**
 * Реплей-корпус отказов guided v5: пары «пакет решения → ответ модели → причина отказа»
 * из сырых обменов серии (`raw/<slug>/NNNNN-<stage>-<mode>.json`) и ленты витка
 * (`runs/<cell>/<slug>/traces/events.ndjson`, события `question_validation`).
 *
 * Зачем: четыре серии 6×5 дали success 0/30, и каждый фикс снимался по клетке живым
 * перезамером (часы). Корпус отвечает на вопрос «кто виноват в отказе — рантайм или модель»
 * офлайн, за секунды: ответ модели прогоняется через ТУ ЖЕ схему, что была в запросе
 * (`z.fromJSONSchema`), и расхождения раскладываются по классам.
 *
 * Разметка (`ReplayLabel`):
 * - `budget`        — обрезка по max_tokens / пустой content: ни модель, ни рантайм по смыслу
 *                     ответа не судили;
 * - `false-reject`  — ответ схеме НЕ соответствует только из-за дефекта самой схемы или
 *                     нормализации рантайма (enum путей в другом регистре, `./`-префикс);
 *                     это отказ рантайма, а не модели;
 * - `model`         — ответ не проходит схему запроса по существу (не тот тип, лишние ключи,
 *                     значение вне enum без нормализуемого двойника);
 * - `post-validator` — схема пройдена, отказал содержательный валидатор рантайма (символ не в
 *                     файле, цель вне allowlist, пустые claims…). Такие случаи судятся по
 *                     ручной метке `labels.json` либо повторным прогоном валидатора; здесь они
 *                     только группируются по классу причины;
 * - `unjoined`      — отказ ленты не удалось сопоставить с обменом (нет raw или расходятся счётчики).
 *
 * Сопоставление без временных меток: в ленте у `question_validation` их нет. Внутри витка
 * обмены и события идут строго последовательно, поэтому k-й отказ по (этап, схема) соответствует
 * k-му обмену с тем же (этап, имя схемы) в порядке `seq`. Расхождение счётчиков даёт `unjoined`,
 * а не тихую подмену.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export type ReplayLabel = 'budget' | 'false-reject' | 'model' | 'post-validator' | 'unjoined';

/** Класс причины отказа содержательного валидатора — по тексту причины, словарь закрыт. */
export type RejectionClass = 'truncated' | 'schema' | 'allowlist' | 'symbol' | 'claims' | 'clarification' | 'coverage' | 'citation' | 'sticky' | 'other';

export interface ReplayCase {
  series: string;
  slug: string;
  model: string;
  task: string | null;
  stage: string;
  schema: string;
  /** Порядковый номер обмена в `raw/` серии; null — отказ не сопоставлен. */
  seq: number | null;
  rawPath: string | null;
  /** Схема ответа из запроса — ровно та, что видела модель. */
  responseSchema: unknown;
  /** Содержимое ответа модели (content) как строка; null — обмен не сопоставлен. */
  answer: string | null;
  reason: string;
  rejectionClass: RejectionClass;
  label: ReplayLabel;
  /** Обоснование метки из правила разметки (`applyLabelRules`); у автоматических меток нет. */
  labelNote?: string;
  /** Проблемы схемы по ответу — только для `model`/`false-reject`. */
  schemaIssues: string[];
}

export interface ReplaySummary {
  cases: number;
  byLabel: Record<ReplayLabel, number>;
  byClass: Record<string, number>;
  bySchema: Record<string, number>;
  byModel: Record<string, number>;
  unjoinedRejections: number;
}

export interface RawExchange {
  seq: number;
  slug: string;
  stage: string;
  mode: string;
  model: string;
  status: number;
  request: { messages?: { role: string; content: string }[]; response_format?: { json_schema?: { name?: string; schema?: unknown } } };
  response: string;
}

interface ValidationEvent { type: 'question_validation'; stage: string; questionId: string; accepted: boolean; reason: string }

const bump = (map: Record<string, number>, key: string): void => { map[key] = (map[key] ?? 0) + 1; };

export function classifyRejectionReason(reason: string): RejectionClass {
  if (/max_tokens|content was empty|reached max_tokens/iu.test(reason)) return 'truncated';
  if (/rejected \d+ times with the same proposalHash/iu.test(reason)) return 'sticky';
  if (/target is not allowed|не разрешена|allowlist|вне allowlist|не входит в files_to_touch/iu.test(reason)) return 'allowlist';
  if (/символ|symbol/iu.test(reason)) return 'symbol';
  if (/claim-?N?\b|claims/iu.test(reason)) return 'claims';
  if (/ID ответа|уточнени|clarification|ответ-\d+/iu.test(reason)) return 'clarification';
  if (/does not cover|не покрыва|coverage/iu.test(reason)) return 'coverage';
  if (/цитат|quote|evidence|основани/iu.test(reason)) return 'citation';
  if (/ZodError|"code":\s*"|invalid_type|invalid_value|unrecognized_keys|too_small|too_big|Invalid input/iu.test(reason)) return 'schema';
  return 'other';
}

/** Ответ модели из тела ответа OpenAI-совместимого провайдера. */
export function answerContent(raw: RawExchange): string | null {
  try {
    const parsed = JSON.parse(raw.response) as { choices?: { message?: { content?: unknown } }[] };
    const content = parsed.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  } catch { return null; }
}

/** Пути в enum, отличающиеся от значения только регистром/`./`/разделителем — дефект нормализации рантайма. */
function enumTwin(value: string, options: readonly unknown[]): boolean {
  const fold = (s: string): string => s.replace(/\\/gu, '/').replace(/^\.\//u, '').toLowerCase();
  return options.some(option => typeof option === 'string' && option !== value && fold(option) === fold(value));
}

function enumAt(schema: unknown, path: readonly PropertyKey[]): readonly unknown[] | null {
  let node: unknown = schema;
  for (const key of path) {
    if (!node || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    if (typeof key === 'number') node = record.items;
    else node = (record.properties as Record<string, unknown> | undefined)?.[String(key)];
  }
  if (!node || typeof node !== 'object') return null;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.enum)) return record.enum;
  const branches = (record.anyOf ?? record.oneOf) as unknown[] | undefined;
  const withEnum = branches?.find(branch => branch && typeof branch === 'object' && Array.isArray((branch as Record<string, unknown>).enum)) as Record<string, unknown> | undefined;
  return withEnum ? withEnum.enum as unknown[] : null;
}

/**
 * Вердикт схемы по ответу: ответ соответствует схеме запроса, либо список проблем и признак
 * «все проблемы — нормализуемые двойники enum» (ложный отказ по построению).
 */
export function schemaVerdict(schema: unknown, answer: string): { valid: boolean; issues: string[]; onlyEnumTwins: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(answer); }
  catch { return { valid: false, issues: ['ответ не является JSON'], onlyEnumTwins: false }; }
  let validator: z.ZodType;
  try { validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]); }
  catch (error) { return { valid: false, issues: [`схема запроса не компилируется: ${String(error).slice(0, 160)}`], onlyEnumTwins: false }; }
  const result = validator.safeParse(parsed);
  if (result.success) return { valid: true, issues: [], onlyEnumTwins: false };
  const issues = result.error.issues.map(issue => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`);
  const onlyEnumTwins = result.error.issues.length > 0 && result.error.issues.every(issue => {
    if (issue.code !== 'invalid_value' && issue.code !== 'invalid_union') return false;
    const options = enumAt(schema, issue.path as PropertyKey[]);
    if (options === null) return false;
    let actual: unknown = parsed;
    for (const key of issue.path) actual = actual && typeof actual === 'object' ? (actual as Record<PropertyKey, unknown>)[key as PropertyKey] : undefined;
    return typeof actual === 'string' && enumTwin(actual, options);
  });
  return { valid: false, issues, onlyEnumTwins };
}

function readEvents(path: string): ValidationEvent[] {
  if (!existsSync(path)) return [];
  const out: ValidationEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('"question_validation"')) continue;
    try {
      const event = JSON.parse(line) as Partial<ValidationEvent>;
      if (event.type === 'question_validation' && typeof event.stage === 'string' && typeof event.questionId === 'string' && typeof event.accepted === 'boolean')
        out.push({ type: 'question_validation', stage: event.stage, questionId: event.questionId, accepted: event.accepted, reason: typeof event.reason === 'string' ? event.reason : '' });
    } catch { /* битая строка ленты — пропуск */ }
  }
  return out;
}

/** Витки серии: slug → каталог трасс (`runs/<cell>/<slug>`), задача и модель из `result.json`. */
export function seriesRuns(seriesDir: string): Map<string, { traces: string; task: string | null; model: string | null }> {
  const found = new Map<string, { traces: string; task: string | null; model: string | null }>();
  const runs = join(seriesDir, 'runs');
  if (!existsSync(runs)) return found;
  for (const cell of readdirSync(runs, { withFileTypes: true })) {
    if (!cell.isDirectory()) continue;
    for (const slug of readdirSync(join(runs, cell.name), { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const dir = join(runs, cell.name, slug.name);
      let task: string | null = null, model: string | null = null;
      try {
        const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as { run?: { task?: unknown; model?: unknown } };
        task = typeof result.run?.task === 'string' ? result.run.task : null;
        model = typeof result.run?.model === 'string' ? result.run.model : null;
      } catch { /* клетка без result.json — задача неизвестна */ }
      found.set(slug.name, { traces: join(dir, 'traces'), task, model });
    }
  }
  return found;
}

function labelFor(cls: RejectionClass, verdict: { valid: boolean; onlyEnumTwins: boolean } | null): ReplayLabel {
  if (cls === 'truncated') return 'budget';
  if (verdict === null) return 'unjoined';
  if (verdict.valid) return 'post-validator';
  return verdict.onlyEnumTwins ? 'false-reject' : 'model';
}

/**
 * Правило разметки отказа содержательного валидатора. Правила — данные стенда
 * (`bench/corpus/replay/labels.json`), а не код: каждое называет класс причины, регулярку по
 * причине и вердикт с обоснованием. `targetNamedInTask` — дополнительное условие: путь из
 * причины отказа назван в тексте задачи (в обратных кавычках) — тогда отказ ложный по
 * построению, иначе правило не применяется (модель назвала чужой файл — брак модели).
 */
export interface ReplayLabelRule {
  schema?: string;
  rejectionClass?: RejectionClass;
  reasonPattern: string;
  label: 'false-reject' | 'model';
  note: string;
  targetNamedInTask?: boolean;
}

const BACKTICK_PATH = /`((?:[\w.-]+\/)*[\w.-]+\.\w+)`/gu;

/** Пути, названные в тексте задачи в обратных кавычках. */
export function taskNamedPaths(taskText: string): Set<string> {
  return new Set([...taskText.matchAll(BACKTICK_PATH)].map(match => match[1]!.replace(/^\.\//u, '')));
}

export function applyLabelRules(cases: readonly ReplayCase[], rules: readonly ReplayLabelRule[], taskTextFor: (task: string) => string | null): ReplayCase[] {
  return cases.map(item => {
    if (item.label !== 'post-validator') return item;
    for (const rule of rules) {
      if (rule.schema !== undefined && rule.schema !== item.schema) continue;
      if (rule.rejectionClass !== undefined && rule.rejectionClass !== item.rejectionClass) continue;
      const match = new RegExp(rule.reasonPattern, 'u').exec(item.reason);
      if (match === null) continue;
      if (rule.targetNamedInTask) {
        const target = match[1];
        const taskText = item.task === null ? null : taskTextFor(item.task);
        if (target === undefined || taskText === null) continue;
        if (!taskNamedPaths(taskText).has(target.replace(/^\.\//u, ''))) continue;
      }
      return { ...item, label: rule.label, labelNote: rule.note } as ReplayCase;
    }
    return item;
  });
}

/** Собрать отказы серии (или нескольких) в корпус. Принятые ответы в корпус не входят. */
export function collectReplayCorpus(seriesDirs: readonly string[]): ReplayCase[] {
  const cases: ReplayCase[] = [];
  for (const seriesDir of seriesDirs) {
    const series = seriesDir.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() ?? seriesDir;
    const runs = seriesRuns(seriesDir);
    const rawRoot = join(seriesDir, 'raw');
    for (const [slug, run] of runs) {
      const rejections = readEvents(join(run.traces, 'events.ndjson')).filter(event => !event.accepted);
      if (rejections.length === 0) continue;
      const rawDir = join(rawRoot, slug);
      const exchanges: RawExchange[] = existsSync(rawDir)
        ? readdirSync(rawDir).filter(name => name.endsWith('.json') && !name.endsWith('.label.json')).flatMap(name => {
          try { return [{ ...(JSON.parse(readFileSync(join(rawDir, name), 'utf8')) as RawExchange), rawPath: join(rawDir, name) } as RawExchange & { rawPath: string }]; }
          catch { return []; }
        }).sort((a, b) => a.seq - b.seq)
        : [];
      // Обмены по ключу (этап, схема) в порядке seq; k-е событие ленты по тому же ключу — k-й
      // обмен. Принятые события тоже двигают счётчик: каждый обмен даёт ровно одно событие.
      const byKey = new Map<string, RawExchange[]>();
      for (const exchange of exchanges) {
        const key = `${exchange.stage}\u0000${exchange.request?.response_format?.json_schema?.name ?? ''}`;
        byKey.set(key, [...(byKey.get(key) ?? []), exchange]);
      }
      const seen = new Map<string, number>();
      const allEvents = readEvents(join(run.traces, 'events.ndjson'));
      for (const event of allEvents) {
        const key = `${event.stage}\u0000${event.questionId}`;
        const index = seen.get(key) ?? 0;
        seen.set(key, index + 1);
        const exchange = byKey.get(key)?.[index] ?? null;
        if (event.accepted) continue;
        const cls = classifyRejectionReason(event.reason);
        const schema = exchange?.request?.response_format?.json_schema?.schema ?? null;
        const answer = exchange === null ? null : answerContent(exchange);
        const verdict = exchange !== null && answer !== null && schema !== null && cls !== 'truncated' ? schemaVerdict(schema, answer) : null;
        cases.push({
          series, slug, model: run.model ?? exchange?.model ?? 'unknown', task: run.task, stage: event.stage, schema: event.questionId,
          seq: exchange?.seq ?? null, rawPath: (exchange as (RawExchange & { rawPath?: string }) | null)?.rawPath ?? null,
          responseSchema: schema, answer, reason: event.reason, rejectionClass: cls,
          label: labelFor(cls, verdict), schemaIssues: verdict?.issues ?? [],
        });
      }
    }
  }
  return cases;
}

export function summarizeReplayCorpus(cases: readonly ReplayCase[]): ReplaySummary {
  const summary: ReplaySummary = { cases: cases.length, byLabel: { budget: 0, 'false-reject': 0, model: 0, 'post-validator': 0, unjoined: 0 }, byClass: {}, bySchema: {}, byModel: {}, unjoinedRejections: 0 };
  for (const item of cases) {
    summary.byLabel[item.label]++;
    bump(summary.byClass, item.rejectionClass);
    bump(summary.bySchema, item.schema);
    bump(summary.byModel, item.model);
    if (item.label === 'unjoined') summary.unjoinedRejections++;
  }
  return summary;
}

export function writeReplayCorpus(path: string, cases: readonly ReplayCase[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cases.map(item => JSON.stringify(item)).join('\n') + (cases.length ? '\n' : ''), 'utf8');
}

function argValues(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.slice(2).filter(value => value.startsWith(prefix)).map(value => resolve(value.slice(prefix.length)));
}

/** Правила разметки стенда и тексты задач стенда — для CLI и теста корпуса. */
export function benchLabelRules(benchDir: string): ReplayLabelRule[] {
  const path = join(benchDir, 'corpus', 'replay', 'labels.json');
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { rules?: ReplayLabelRule[] };
  return Array.isArray(parsed.rules) ? parsed.rules : [];
}

export function benchTaskText(benchDir: string): (task: string) => string | null {
  const cache = new Map<string, string | null>();
  return task => {
    if (cache.has(task)) return cache.get(task)!;
    let found: string | null = null;
    const fixtures = join(benchDir, 'fixtures');
    if (existsSync(fixtures)) for (const fixture of readdirSync(fixtures)) {
      const candidate = join(fixtures, fixture, `task-${task}.md`);
      if (existsSync(candidate)) { found = readFileSync(candidate, 'utf8'); break; }
    }
    cache.set(task, found);
    return found;
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const series = argValues('series');
  if (series.length === 0) { process.stderr.write('Использование: node bench/src/replayCorpus.ts --series=<каталог серии> [--series=…] [--out=<файл.jsonl>]\n'); process.exit(2); }
  const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const cases = applyLabelRules(collectReplayCorpus(series), benchLabelRules(benchDir), benchTaskText(benchDir));
  const out = argValues('out')[0];
  if (out !== undefined) writeReplayCorpus(out, cases);
  process.stdout.write(`${JSON.stringify({ ...(out === undefined ? {} : { output: out }), ...summarizeReplayCorpus(cases) }, null, 2)}\n`);
}
