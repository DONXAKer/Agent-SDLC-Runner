/**
 * Проверка окна контекста LM Studio перед прогоном.
 *
 * LM Studio не даёт раннеру загрузить модель самому — окно задаётся снаружи, оператором
 * (`lms load <model> -c <N> --gpu max`). Расхождение между заявленным в конфиге окном
 * (`ModelDef.contextWindow`) и фактически загруженным раньше обнаруживалось только по
 * факту: `exceed_context_size_error` посреди дорогого прогона, либо крах движка при
 * старте загрузки, либо просто другая модель забыла отгружена (`lms unload --all`
 * между сменами моделей — ручная операция). Цена вслепую — часы стенных часов
 * (2026-09-09/10, три модели, минимум шесть загрузок методом проб и ошибок).
 *
 * `GET /api/v0/models` — собственный (не OpenAI-совместимый) эндпойнт LM Studio.
 * `/v1/models` (общий OpenAI-совместимый путь) отдаёт только `id`, без состояния и окна;
 * `/api/v0/models` — ещё `state` ("loaded"/"not-loaded") и, для загруженной модели,
 * `loaded_context_length` — ФАКТИЧЕСКОЕ окно, не природный потолок модели
 * (`max_context_length`, тот же независимо от того, с каким окном её загрузили).
 */

import { apiOrigin, describeFetchFailure, fetchJson } from './http.ts';

export interface LmStudioContextCheck {
  ok: boolean;
  /** `null` — модель не найдена в LM Studio вовсе (`lms ls` её не видит под этим id). */
  state: 'loaded' | 'not-loaded' | null;
  /** Фактически загруженное окно; `null` — модель не загружена или окно не отдано. */
  loadedContextLength: number | null;
  /** Готовая строка для лога/консоли — что не так и какой командой чинить. */
  message: string;
}

interface LmStudioModelEntry {
  id: string;
  state?: string;
  loaded_context_length?: number;
}

/**
 * Сравнивает заявленное в конфиге окно с фактически загруженным. Сетевой сбой и HTTP-ошибка
 * — тоже `ok: false`: и то, и другое значит «нельзя доверять, что прогон получит заявленное
 * окно», а не отдельный третий исход — вызывающему решать код возврата (обычно тот же 2,
 * что и у расхождения окна, средовой класс).
 */
export async function checkLmStudioContext(
  baseUrl: string,
  modelId: string,
  expected: number,
  signal?: AbortSignal,
): Promise<LmStudioContextCheck> {
  const url = `${apiOrigin(baseUrl)}/api/v0/models`;
  const res = await fetchJson(url, signal === undefined ? {} : { signal });
  if (!res.ok) {
    return {
      ok: false,
      state: null,
      loadedContextLength: null,
      message: describeFetchFailure(url, res.failure, 'LM Studio', '`lms server start`'),
    };
  }
  const data = (res.body as { data?: LmStudioModelEntry[] } | null)?.data;

  const entry = (Array.isArray(data) ? data : []).find((m) => m.id === modelId);
  if (entry === undefined) {
    return {
      ok: false,
      state: null,
      loadedContextLength: null,
      message: `модель «${modelId}» не найдена в LM Studio (\`lms ls\` не видит её под этим id — опечатка в config/models.json?)`,
    };
  }

  if (entry.state !== 'loaded') {
    return {
      ok: false,
      state: entry.state === 'not-loaded' ? 'not-loaded' : null,
      loadedContextLength: null,
      message:
        `модель «${modelId}» не загружена (state: ${entry.state ?? 'unknown'}) — ` +
        `сначала \`lms load ${modelId} -c ${expected} --gpu max\``,
    };
  }

  const loaded = typeof entry.loaded_context_length === 'number' ? entry.loaded_context_length : null;
  if (loaded !== expected) {
    return {
      ok: false,
      state: 'loaded',
      loadedContextLength: loaded,
      message:
        `модель «${modelId}» загружена с окном ${loaded ?? '?'}, а конфиг (\`contextWindow\`) ожидает ${expected} — ` +
        `перезагрузи: \`lms unload --all && lms load ${modelId} -c ${expected} --gpu max\``,
    };
  }

  return { ok: true, state: 'loaded', loadedContextLength: loaded, message: 'окно контекста совпадает с конфигом' };
}
