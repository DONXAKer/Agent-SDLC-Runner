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

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  mode: 'loop' | 'step' | 'formFill' | 'claimFill';
  /** Номер попытки этапа, если он у режима есть. */
  attempt?: number;
}

export interface RawExchange {
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

/** Подряд идущие отказы записи. Успех обнуляет счётчик. */
let failures = 0;
const MAX_FAILURES = 3;

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
    return;
  }
  process.emitWarning(`SDLC_RAW_LOG_DIR: пара не записана (${failures} из ${MAX_FAILURES}) — ${reason}`);
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

/** Только для тестов: забыть решение о каталоге и обнулить счётчик. */
export function resetRawLogForTests(): void {
  dir = undefined;
  seq = 0;
  failures = 0;
}
