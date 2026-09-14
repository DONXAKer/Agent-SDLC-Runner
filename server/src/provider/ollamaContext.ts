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

export interface OllamaContextCheck {
  ok: boolean;
  /** Эффективное окно тега: num_ctx из Modelfile, иначе умолчание Ollama (4096). */
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

/** `http://localhost:11434/v1` → `http://localhost:11434` — общий хост для `/api/*`. */
function apiOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '');
}

/** num_ctx из строки parameters ответа /api/show; `null` — параметр в тег не зашит. */
export function parseNumCtx(parameters: string | undefined): number | null {
  if (parameters === undefined) return null;
  const m = /^\s*num_ctx\s+(\d+)\s*$/m.exec(parameters);
  return m === null ? null : Number(m[1]);
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(url, init ?? {});
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `Ollama недоступна по ${url}: ${why}` };
  }
  if (!res.ok) {
    return { ok: false, message: `Ollama ${url} ответила HTTP ${res.status} — сервер запущен (\`ollama serve\`)?` };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, message: `${url} вернул не JSON` };
  }
}

/**
 * Сравнивает заявленное в конфиге окно (`expected`, `ModelDef.contextWindow`) с
 * эффективным окном тега. Ожидание не задано — требуется минимум жизнеспособное окно:
 * «голый тег с 4096» — самая частая средовая ловушка Ollama, и молча пропустить её
 * значило бы снова сжечь прогон на промпте.
 *
 * Сетевой сбой и HTTP-ошибка — тоже `ok: false` (средовой класс): решение о коде
 * возврата остаётся за вызывающим, как у `checkLmStudioContext`.
 */
export async function checkOllamaContext(
  baseUrl: string,
  modelId: string,
  expected?: number,
): Promise<OllamaContextCheck> {
  const fail = (message: string, effective: number | null = null): OllamaContextCheck => ({
    ok: false,
    effectiveContextLength: effective,
    message,
  });

  const origin = apiOrigin(baseUrl);
  const tags = await fetchJson(`${origin}/api/tags`);
  if (!tags.ok) return fail(tags.message);
  const names = ((tags.body as OllamaTagsBody).models ?? [])
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

  const show = await fetchJson(`${origin}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: modelId }),
  });
  if (!show.ok) return fail(show.message);

  const numCtx = parseNumCtx((show.body as OllamaShowBody).parameters);
  const effective = numCtx ?? OLLAMA_DEFAULT_NUM_CTX;

  if (expected !== undefined) {
    if (effective < expected) {
      return fail(
        `тег «${modelId}» даёт окно ${effective}${numCtx === null ? ' (умолчание Ollama — num_ctx в тег не зашит)' : ''}, ` +
          `а конфиг (\`contextWindow\`) ожидает ${expected} — пересоздай тег: ` +
          `\`ollama create ${modelId} -f Modelfile\` с \`PARAMETER num_ctx ${expected}\``,
        effective,
      );
    }
    return { ok: true, effectiveContextLength: effective, message: `окно тега (${effective}) покрывает заявленное в конфиге (${expected})` };
  }

  if (effective < OLLAMA_MIN_VIABLE_CTX) {
    return fail(
      `тег «${modelId}» даёт окно ${effective}${numCtx === null ? ' (умолчание Ollama — num_ctx в тег не зашит)' : ''} — ` +
        `один Read вымоет его целиком. Заяви \`contextWindow\` в config/models.json и создай производный тег ` +
        `(\`ollama create ${modelId}-ctx16k -f Modelfile\` с \`PARAMETER num_ctx 16384\`)`,
      effective,
    );
  }
  return { ok: true, effectiveContextLength: effective, message: `окно тега: ${effective} (запись не заявила contextWindow — сверять не с чем)` };
}
