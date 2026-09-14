/**
 * Проверка наличия модели и окна контекста Ollama перед прогоном.
 *
 * Две задокументированные ловушки (config/models.json, «// ollama и num_ctx»;
 * docs/model-runs.md:174-175, :1615-1631), обе сжигали прогоны до первого вызова
 * инструмента:
 *
 * 1. Голый тег без зашитого `num_ctx` получает умолчание Ollama — 4096 токенов: один
 *    Read при штатном maxToolResultBytes вымывает окно целиком. Чинится производным
 *    тегом (`ollama create <тег> -f Modelfile` с `PARAMETER num_ctx 16384`), но
 *    расхождение обнаруживалось по факту сгоревшего этапа.
 * 2. Удалённый/несозданный тег отвечает HTTP 404 на КАЖДЫЙ запрос — серия из пяти
 *    прогонов приняла это за отказ модели (bench-серия sweep5, 2026-09-13).
 *
 * Обе проверяются двум дешёвыми запросами: `GET /api/tags` (наличие тега) и
 * `POST /api/show` (параметры тега). `/api/show` одним запросом отвечает и на вопрос
 * наличия, но не различает «тега нет» и «сервер отвечает странно» — `/api/tags`
 * даёт человеческое сообщение именно про отсутствие.
 */

import { apiOrigin, describeFetchFailure, fetchJson, type FetchJsonFailure } from './http.ts';

export interface OllamaContextCheck {
  ok: boolean;
  /**
   * Проверка неприменима: по этому адресу нет Ollama-шного `/api` (прокси, отдающий только
   * `/v1`; сервер не отвечает). `ok` при этом `false` — окно не проверено, — но блокировать
   * прогон нечем: он работал и без преполёта, а недоступный сервер обычный путь запроса
   * назовёт своей средовой ошибкой.
   */
  skipped: boolean;
  /** Эффективное окно тега: num_ctx из Modelfile, иначе умолчание сервера. */
  effectiveContextLength: number | null;
  /** Готовая строка для лога/консоли — что не так и как чинить. */
  message: string;
}

/** Умолчание Ollama для тега без `PARAMETER num_ctx` — не природный потолок модели. */
export const OLLAMA_DEFAULT_NUM_CTX = 4096;

/** Нижняя граница окна, когда запись модели не заявила `contextWindow`: при штатных
 * лимитах раннера меньшее окно не переживает один Read (см. шапку). */
export const OLLAMA_MIN_VIABLE_CTX = 8192;

interface OllamaTagsBody {
  models?: { name?: string; model?: string }[];
}

interface OllamaShowBody {
  /** Строка параметров модфайла: строки вида `num_ctx                        16384`. */
  parameters?: string;
}

export interface OllamaCheckOptions {
  /** Окружение, из которого читается `OLLAMA_CONTEXT_LENGTH`; умолчание — `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Потолок каждого служебного запроса; умолчание — `API_FETCH_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** num_ctx из строки parameters ответа /api/show; `null` — параметр в тег не зашит. */
export function parseNumCtx(parameters: string | undefined): number | null {
  if (parameters === undefined) return null;
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return m === null ? null : Number(m[1]);
}

/**
 * Окно для тега без `num_ctx` и ИСТОЧНИК этого числа — для текста проблемы.
 *
 * Серверное `OLLAMA_CONTEXT_LENGTH` перекрывает встроенные 4096 для всех тегов разом, и
 * без его учёта преполёт давал ложный красный «окно 4096» (код 2) на рабочей среде
 * (code-review, 2026-09-14). Читаем окружение раннера: переменная, заданная на этой же
 * машине, — лучшее доступное знание об умолчании сервера; `/api/*` его не отдаёт. Если
 * `ollama serve` запущен с другим окружением, проверка ошибается ровно так же, как до
 * этой правки, — не хуже.
 */
function defaultWindow(env: Readonly<Record<string, string | undefined>>): { value: number; source: string } {
  const raw = env['OLLAMA_CONTEXT_LENGTH']?.trim();
  if (raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0) {
    return { value: Number(raw), source: `OLLAMA_CONTEXT_LENGTH=${raw} — num_ctx в тег не зашит` };
  }
  return { value: OLLAMA_DEFAULT_NUM_CTX, source: 'умолчание Ollama — num_ctx в тег не зашит' };
}

/**
 * `/api/tags` здесь не отвечает Ollama-ответом — значит, по адресу не Ollama-шный `/api`,
 * и проверять нечего. 404 — прокси с одним `/v1`; сетевой отказ и таймаут — сервер не
 * отвечает (чат упадёт своей средовой ошибкой, точнее нашей); 200 не-JSON — заглушка
 * прокси. 5xx сюда НЕ входит: сервер на месте и болен, это проблема.
 */
function apiAbsent(f: FetchJsonFailure): boolean {
  return f.kind === 'network' || f.kind === 'timeout' || f.kind === 'json' || (f.kind === 'http' && f.status === 404);
}

/**
 * Сравнивает заявленное в конфиге окно (`expected`, `ModelDef.contextWindow`) с
 * эффективным окном тега. Ожидание не задано — требуется минимум жизнеспособное окно:
 * «голый тег с 4096» — самая частая средовая ловушка Ollama, и молча пропустить её
 * значило бы снова сжечь прогон на промпте.
 *
 * Сбой запроса — тоже `ok: false`; отсутствие `/api` по адресу дополнительно помечено
 * `skipped` (см. `apiAbsent`). Решение о коде возврата остаётся за вызывающим, как у
 * `checkLmStudioContext`.
 */
export async function checkOllamaContext(
  baseUrl: string,
  modelId: string,
  expected?: number,
  options: OllamaCheckOptions = {},
): Promise<OllamaContextCheck> {
  const fail = (message: string, effective: number | null = null, skipped = false): OllamaContextCheck => ({
    ok: false,
    skipped,
    effectiveContextLength: effective,
    message,
  });
  const fetchOpts = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  const origin = apiOrigin(baseUrl);
  const tagsUrl = `${origin}/api/tags`;
  const tags = await fetchJson(tagsUrl, fetchOpts);
  if (!tags.ok) {
    const message = describeFetchFailure(tagsUrl, tags.failure, 'Ollama', '`ollama serve`');
    return apiAbsent(tags.failure)
      ? fail(`проверка окна Ollama неприменима — ${message}`, null, true)
      : fail(message);
  }
  const models = (tags.body as OllamaTagsBody | null)?.models;
  if (!Array.isArray(models)) {
    return fail(`проверка окна Ollama неприменима — ${tagsUrl} ответил без списка models (это не Ollama?)`, null, true);
  }
  const names = models
    .flatMap((m) => [m.name, m.model])
    .filter((n): n is string => n !== undefined && n !== '');
  // Без явного тега (`ministral3-14b-ctx32k`, не `…:latest`) `config/models.json` называет
  // модель тем же именем, каким её создали (`ollama create <имя> -f Modelfile`) — но
  // `/api/tags` отдаёт имя с суффиксом `:latest` уже приписанным. Сравнение строк без
  // нормализации сжигало живой прогон ложным «мёртвый тег» на РАБОЧЕЙ модели (`ollama
  // ps`/`ollama list` в момент отказа видели тег штатно) — bench-серия v5, 2026-09-14.
  const stripLatest = (n: string): string => n.replace(/:latest$/, '');
  if (!names.some((n) => stripLatest(n) === stripLatest(modelId))) {
    return fail(
      `модель «${modelId}» не найдена в Ollama (\`ollama list\` не видит её под этим именем — ` +
        `опечатка в config/models.json или тег не создан? Класс «мёртвый тег»: HTTP 404 на каждый запрос посреди серии)`,
    );
  }

  const showUrl = `${origin}/api/show`;
  const show = await fetchJson(showUrl, {
    ...fetchOpts,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: modelId }),
    },
  });
  // Тег найден в `/api/tags` — значит, `/api` здесь есть, и сбой `/api/show` уже проблема.
  if (!show.ok) return fail(describeFetchFailure(showUrl, show.failure, 'Ollama', '`ollama serve`'));

  const numCtx = parseNumCtx((show.body as OllamaShowBody | null)?.parameters);
  const fallback = defaultWindow(options.env ?? process.env);
  const effective = numCtx ?? fallback.value;
  const windowSource = numCtx === null ? ` (${fallback.source})` : '';

  if (expected !== undefined) {
    if (effective < expected) {
      return fail(
        `тег «${modelId}» даёт окно ${effective}${windowSource}, ` +
          `а конфиг (\`contextWindow\`) ожидает ${expected} — пересоздай тег: ` +
          `\`ollama create ${modelId} -f Modelfile\` с \`PARAMETER num_ctx ${expected}\``,
        effective,
      );
    }
    return {
      ok: true,
      skipped: false,
      effectiveContextLength: effective,
      message: `окно тега (${effective}${windowSource}) покрывает заявленное в конфиге (${expected})`,
    };
  }

  if (effective < OLLAMA_MIN_VIABLE_CTX) {
    return fail(
      `тег «${modelId}» даёт окно ${effective}${windowSource} — ` +
        `один Read вымоет его целиком. Заяви \`contextWindow\` в config/models.json и создай производный тег ` +
        `(\`ollama create ${modelId}-ctx16k -f Modelfile\` с \`PARAMETER num_ctx 16384\`)`,
      effective,
    );
  }
  return {
    ok: true,
    skipped: false,
    effectiveContextLength: effective,
    message: `окно тега: ${effective}${windowSource} (запись не заявила contextWindow — сверять не с чем)`,
  };
}
