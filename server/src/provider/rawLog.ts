/**
 * Сырой дамп запросов к модели — единственный источник корпуса «вход → выход».
 *
 * Зачем отдельным контуром, а не через шину событий. Событие `prompt_prepared` эмитится
 * ОДИН раз на этап, а модель во флоу `loop` видит на каждом ходу другой вход: история
 * режется скользящим окном (`exec/history.ts`), рантайм подмешивает напоминания стража и
 * замечания анти-цикла. Событие `tool_result` несёт только `summary` — первую строку,
 * обрезанную до 200 символов, — то есть содержимое файла, которое модель реально читала,
 * в ленте не сохраняется. Режимы `stepFill`/`formFill`/`claimFill` своих `prompt_prepared`
 * не эмитят вовсе. Восстановить по ленте фактический вход хода нельзя.
 *
 * Тело запроса в `OpenAiCompatProvider` — уже собранное, уже обрезанное, побайтово то, что
 * уходит в модель. Одна точка дампа там покрывает все четыре режима сразу.
 *
 * Выключен, пока не задан `SDLC_RAW_LOG_DIR`: путь к каталогу трасс — машинное значение
 * (правило «Конфигурация» в CLAUDE.md), а горячий путь не должен платить за то, чего не
 * просили. Прогон при этом ведёт себя ровно как раньше — дамп ничего не меняет во входе.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExchangeLabel } from '@sdlc-runner/shared';

/**
 * Кто спрашивает. Метка ставится на ПРОВАЙДЕР, а не на запрос: экземпляр провайдера
 * создаётся под конкретный этап и режим (`Run.executorFor`, `topUpClaims`, `narrowRoute`),
 * и плести метку через `ChatRequest` значило бы повторить одно и то же в пяти местах
 * вызова `provider.chat`.
 */
export interface TraceLabel {
  /** Слаг витка: по нему трассы разных прогонов не смешиваются в одном каталоге. */
  slug: string;
  stage: string;
  /** Режим исполнителя: чем этот запрос является для корпуса — ход цикла, шаг плана, поле бланка. */
  mode: 'loop' | 'step' | 'formFill' | 'claimFill' | 'reviewFill' | 'planAxisFill' | 'explore' | 'claimsBlind' | 'decisionCheck';
  /** Номер попытки этапа, если он у режима есть. */
  attempt?: number;
  /** Local run diagram, independent of the optional benchmark raw-log directory. */
  onExchange?: (exchange: RawExchange) => void;
  onRequest?: (request: { requestId: string; provider: string; model: string; request: Record<string, unknown>; attempt: number }) => void;
  onResponse?: (exchange: RawExchange) => void;
}

export interface RawExchange {
  requestId?: string;
  provider: string;
  model: string;
  /** Тело запроса как объект — ровно то, что ушло в `JSON.stringify`. */
  request: Record<string, unknown>;
  /** Ответ сервера СТРОКОЙ: разобранный объект потерял бы то, на чём ломаются слабые серверы. */
  response: string;
  status: number;
  durationMs: number;
}

/** Сквозной счётчик процесса: сохраняет порядок запросов между исполнителями одного витка. */
let seq = 0;

/**
 * Состояние каталога считается один раз: `undefined` — ещё не смотрели, `null` — дампа нет
 * (переменная не задана либо каталог не пишется).
 */
let dir: string | null | undefined = undefined;

function targetDir(): string | null {
  if (dir !== undefined) return dir;
  const raw = process.env['SDLC_RAW_LOG_DIR'];
  const trimmed = raw === undefined ? '' : raw.trim();
  dir = trimmed === '' ? null : trimmed;
  return dir;
}

const MAX_FAILURES = 3;

/** Подряд идущие отказы записи ПАРЫ (`dumpExchange`). Успех обнуляет счётчик. */
let failures = 0;
/** Почему дамп выключен отказами записи; `null` — не выключался. */
let disabledReason: string | null = null;

/**
 * Подряд идущие отказы записи МЕТКИ (`annotateExchange`) — СВОЙ счётчик, не общий с парой.
 *
 * До этой правки обе функции делили один `failures`/`dir`: три подряд неудачные записи
 * ИМЕННО `.label.json` (например, путь `<путь пары>.label.json` на несколько символов
 * длиннее самой пары и на Windows упирается в `MAX_PATH` там, где путь пары ещё укладывался)
 * гасили `dumpExchange` вместе с разметкой — отказ третьесортной по цене операции убивал
 * первосортный по цене дамп (code-review-all, 2026-09-27). Разметка выключается СВОЕЙ
 * переменной (`labelDisabled`), путь дампа (`dir`) остаётся как был.
 */
let labelFailures = 0;
let labelDisabled = false;
/** Почему разметка выключена отказами записи; `null` — не выключалась. */
let labelBlockedReason: string | null = null;

/**
 * Отказ дампа не роняет оплаченный прогон — но и не молчит, и не выключает корпус с
 * первого чиха.
 *
 * Оба края измерены живым прогоном. Молчать нельзя: контур, тихо ничего не записавший,
 * хуже отсутствующего — оператор узнаёт о пустом корпусе через день прогонов. Но и
 * выключаться на первом отказе нельзя: один `EBADF` сетевой шары погасил дамп на весь
 * оставшийся виток, и от прогона осталась ровно одна пара. Три подряд — это уже не
 * икота, а неверный путь.
 */
function noteFailure(e: unknown): void {
  failures += 1;
  const reason = e instanceof Error ? e.message : String(e);
  if (failures >= MAX_FAILURES) {
    process.emitWarning(`SDLC_RAW_LOG_DIR: дамп запросов выключен после ${MAX_FAILURES} отказов подряд — ${reason}`);
    dir = null;
    disabledReason = `выключен после ${MAX_FAILURES} отказов записи подряд — ${reason}`;
    return;
  }
  process.emitWarning(`SDLC_RAW_LOG_DIR: пара не записана (${failures} из ${MAX_FAILURES}) — ${reason}`);
}

/** Тот же приём, что `noteFailure`, но выключает только разметку (`labelDisabled`), не дамп. */
function noteLabelFailure(e: unknown): void {
  labelFailures += 1;
  const reason = e instanceof Error ? e.message : String(e);
  if (labelFailures >= MAX_FAILURES) {
    process.emitWarning(`SDLC_RAW_LOG_DIR: разметка обменов выключена после ${MAX_FAILURES} отказов подряд — ${reason}`);
    labelDisabled = true;
    labelBlockedReason = `выключена после ${MAX_FAILURES} отказов записи подряд — ${reason}`;
    return;
  }
  process.emitWarning(`SDLC_RAW_LOG_DIR: метка не записана (${labelFailures} из ${MAX_FAILURES}) — ${reason}`);
}

/**
 * Записать пару «запрос → ответ». Возвращает путь файла либо `null`, если дамп выключен.
 *
 * Имя файла несёт порядковый номер процесса, этап и режим: корпус разбирается по мишеням
 * (`docs/model-tuning.md`) именно по ним, и лезть внутрь каждого файла ради сортировки
 * не нужно. Сводного указателя рядом НЕТ намеренно: сборщик и так обходит каталог, а
 * дописываемый файл добавлял вторую точку отказа — на сетевой шаре `appendFileSync`
 * падает `EBADF` там, где `writeFileSync` работает, и живой прогон погасил этим весь
 * дамп после первой же пары.
 */
export function dumpExchange(label: TraceLabel, x: RawExchange): string | null {
  try { label.onExchange?.(x); }
  catch (error) { console.error(`[flow] ${(error as Error).message}`); }
  const base = targetDir();
  if (base === null) return null;

  seq += 1;
  const runDir = join(base, label.slug);
  const name = `${String(seq).padStart(5, '0')}-${label.stage}-${label.mode}.json`;
  const path = join(runDir, name);
  try {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          ts: new Date().toISOString(),
          seq,
          slug: label.slug,
          stage: label.stage,
          mode: label.mode,
          ...(label.attempt === undefined ? {} : { attempt: label.attempt }),
          provider: x.provider,
          model: x.model,
          status: x.status,
          durationMs: x.durationMs,
          request: x.request,
          response: x.response,
        },
        null,
        1,
      )}\n`,
      'utf8',
    );
    failures = 0;
    return path;
  } catch (e) {
    noteFailure(e);
    return null;
  }
}

/**
 * Забыть решение о каталоге и отказы записи — перед каждым сэмплом серии бенчмарка.
 *
 * Выключение после трёх отказов действует на ПРОЦЕСС, а серия `--repeat` гонит все сэмплы в
 * одном процессе: сетевая икота в первом сэмпле гасила дамп всех оставшихся, и сводка серии
 * об этом молчала. Сквозной номер запроса не сбрасывается — порядок пар в корпусе остаётся
 * сквозным.
 */
export function resetRawLog(): void {
  dir = undefined;
  failures = 0;
  disabledReason = null;
  labelFailures = 0;
  labelDisabled = false;
  labelBlockedReason = null;
}

/** Почему дамп выключен отказами записи с последнего `resetRawLog`; `null` — не выключался. */
export function rawLogDisabledReason(): string | null {
  return disabledReason;
}

/** Почему разметка выключена отказами записи с последнего `resetRawLog`; `null` — не выключалась. */
export function labelDisabledReason(): string | null {
  return labelBlockedReason;
}

/** Только для тестов: забыть решение о каталоге и обнулить счётчик. */
export function resetRawLogForTests(): void {
  resetRawLog();
  seq = 0;
}

/**
 * Слить новую метку со старой (если файл уже существовал) для ОДНОГО обмена.
 *
 * Скалярные поля (`accepted`/`oracle`/`target`/`reason`) новая метка перекрывает — она
 * описывает более позднее, точнее известное состояние того же обмена (например, «пуст»
 * при первом взгляде → «принят» после успешного топ-апа). Массивы (`frictions`)
 * НАКАПЛИВАЮТСЯ: несколько вызовов инструментов одного хода `LoopExecutor` делят ОДИН
 * обмен модели, и вторая разметка не должна стирать трение, найденное первой
 * (code-review-all, 2026-09-27) — без этого правила `writeFileSync` тем же путём просто
 * заменял бы файл целиком, как было до этой правки.
 */
function mergeLabel(prior: ExchangeLabel, next: ExchangeLabel): ExchangeLabel {
  const merged: ExchangeLabel = { ...prior };
  for (const [key, value] of Object.entries(next) as [keyof ExchangeLabel, unknown][]) {
    const before = (merged as Record<string, unknown>)[key];
    (merged as Record<string, unknown>)[key] = Array.isArray(before) && Array.isArray(value) ? [...before, ...value] : value;
  }
  return merged;
}

/**
 * Разметить уже записанную пару исходом хода — известным ТОЛЬКО потребителю (трение
 * цикла, гейт после шага плана, разбор значения поля бланка), не самому дампу.
 *
 * Пишет файл `<путь пары>.label.json` РЯДОМ с парой, а не в неё: второй файл, а не
 * дописывание существующего — на сетевой шаре `appendFileSync` падает `EBADF` там, где
 * `writeFileSync` работает, и живой прогон уже гасил этим весь дамп (см. докстринг
 * `dumpExchange`). Тот же метод (читаем целиком, пишем целиком через `writeFileSync`)
 * используется здесь и для СЛИЯНИЯ повторной разметки (`mergeLabel`) — это не то же самое,
 * что дописывание байт в конец файла, и второй точки отказа не заводит. Разбирающий
 * корпус читает файл пары и файл метки по общему имени, если она есть; парные `seq` не
 * гарантируются — потребитель размечает ПОСЛЕДНИЙ известный ему путь, а между дампом и
 * разметкой мог случиться ещё один запрос того же исполнителя (например, добор
 * `files_to_touch` в `FormFillExecutor`).
 *
 * Отказ записи метки НЕ гасит дамп пар (`dumpExchange`) — у него свой счётчик отказов
 * (`noteLabelFailure`/`labelDisabled`), не общий с `failures`/`dir`: до этой правки три
 * подряд отказа именно записи `.label.json` (например, превышение `MAX_PATH` на Windows у
 * более длинного пути метки) выключали ВЕСЬ дамп процесса, а не только разметку
 * (code-review-all, 2026-09-27).
 *
 * Синхронная (не `fs.promises`) пара `readFileSync`/`writeFileSync` — сознательно, а не по
 * инерции с `dumpExchange`: вызывающие (`LoopExecutor.friction`, цикл полей
 * `FormFillExecutor`) зовут эту функцию в потенциально горячих местах (несколько раз за
 * ход/пачку), и синхронный I/O там платится реальной ценой на медленной ФС. Но переход на
 * асинхронные `fs.promises.readFile`/`writeFile` без единой блокировки открыл бы окно
 * между чтением и записью, где ДВА параллельных вызова (пачка `Promise.allSettled` в
 * `FormFillExecutor`, параллельные субагенты в `LoopExecutor`) читают одно и то же старое
 * содержимое и один перезаписывает слияние другого — ровно та гонка, ради устранения
 * которой заведён `mergeLabel`. Дёшево и безопасно одновременно здесь не вышло: остаётся
 * блокирующий, но корректный синхронный путь (code-review-all, 2026-09-27).
 */
export function annotateExchange(path: string | null, label: ExchangeLabel): void {
  if (path === null || labelDisabled) return;
  const file = `${path}.label.json`;
  try {
    let toWrite = label;
    try {
      const prior = JSON.parse(readFileSync(file, 'utf8')) as ExchangeLabel;
      toWrite = mergeLabel(prior, label);
    } catch {
      // Файла нет (первая метка этого обмена) либо он битый — пишем новую метку как есть.
    }
    writeFileSync(file, `${JSON.stringify(toWrite, null, 1)}\n`, 'utf8');
    labelFailures = 0;
  } catch (e) {
    noteLabelFailure(e);
  }
}
