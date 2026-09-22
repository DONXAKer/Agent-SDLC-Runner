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
 *
 * Второй независимый класс той же ловушки — `--parallel N` при загрузке: `llama-server`
 * делит `--ctx-size` между N слотами, и реальный бюджет одного запроса — `ctx/N`, хотя
 * `loaded_context_length` честно показывает полное окно (серия `test22`: все три
 * lmstudio-модели шли с дефолтным `--parallel 4` и вставали на «Context size exceeded»
 * при входе ~13,5–14 тыс. токенов из заявленных 32768 — реальный потолок был ~8192).
 * Через `/api/v0/models` число слотов не видно вовсе — его отдаёт только CLI
 * (`lms ps --json`, поле `parallel`), поэтому эта половина проверки идёт мимо HTTP.
 */

import { execFile } from 'node:child_process';

import { apiOrigin, describeFetchFailure, fetchJson } from './http.ts';

export interface LmStudioContextCheck {
  ok: boolean;
  /** `null` — модель не найдена в LM Studio вовсе (`lms ls` её не видит под этим id). */
  state: 'loaded' | 'not-loaded' | null;
  /** Фактически загруженное окно; `null` — модель не загружена или окно не отдано. */
  loadedContextLength: number | null;
  /**
   * Число parallel-слотов загруженной модели по `lms ps --json`; `null` — модель не
   * загружена либо CLI не ответил (тогда слоты считаются НЕ проверенными, см. `message`).
   */
  parallel: number | null;
  /** Готовая строка для лога/консоли — что не так и какой командой чинить. */
  message: string;
}

interface LmStudioModelEntry {
  id: string;
  state?: string;
  loaded_context_length?: number;
}

interface LmsPsEntry {
  modelKey?: string;
  identifier?: string;
  parallel?: number;
}

/**
 * Число parallel-слотов загруженной модели по `lms ps --json`; `null` — CLI недоступен,
 * ответ не разобрался или модели в нём нет. Не бросает: любой сбой — это «не проверено»,
 * а не «красно», иначе машина без `lms` на PATH теряла бы прогоны, которые работали.
 */
function readLmsParallel(modelId: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'lms',
      ['ps', '--json'],
      { shell: process.platform === 'win32', timeout: 10_000 },
      (error, stdout) => {
        if (error !== null) { resolve(null); return; }
        try {
          const list = JSON.parse(stdout) as LmsPsEntry[];
          if (!Array.isArray(list)) { resolve(null); return; }
          const entry = list.find((m) => m.modelKey === modelId || m.identifier === modelId);
          resolve(typeof entry?.parallel === 'number' ? entry.parallel : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/** Точка подмены для тестов — HTTP-половина стабается сервером, CLI-половина этим параметром. */
export interface LmStudioContextDeps {
  readParallel?: (modelId: string) => Promise<number | null>;
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
  deps: LmStudioContextDeps = {},
): Promise<LmStudioContextCheck> {
  const readParallel = deps.readParallel ?? readLmsParallel;
  const url = `${apiOrigin(baseUrl)}/api/v0/models`;
  const res = await fetchJson(url, signal === undefined ? {} : { signal });
  if (!res.ok) {
    return {
      ok: false,
      state: null,
      loadedContextLength: null,
      parallel: null,
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
      parallel: null,
      message: `модель «${modelId}» не найдена в LM Studio (\`lms ls\` не видит её под этим id — опечатка в config/models.json?)`,
    };
  }

  if (entry.state !== 'loaded') {
    return {
      ok: false,
      state: entry.state === 'not-loaded' ? 'not-loaded' : null,
      loadedContextLength: null,
      parallel: null,
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
      parallel: null,
      message:
        `модель «${modelId}» загружена с окном ${loaded ?? '?'}, а конфиг (\`contextWindow\`) ожидает ${expected} — ` +
        `перезагрузи: \`lms unload --all && lms load ${modelId} -c ${expected} --gpu max\``,
    };
  }

  const parallel = await readParallel(modelId);
  if (parallel !== null && parallel > 1) {
    return {
      ok: false,
      state: 'loaded',
      loadedContextLength: loaded,
      parallel,
      message:
        `модель «${modelId}» загружена с parallel=${parallel} — окно делится между слотами, ` +
        `реальный бюджет запроса ≈ ${Math.floor(expected / parallel)} из ${expected} ` +
        `(класс серии test22: «Context size exceeded» на plan при входе ~14 тыс. из заявленных 32768) — ` +
        `перезагрузи: \`lms unload --all && lms load ${modelId} -c ${expected} --parallel 1 --gpu max\``,
    };
  }

  return {
    ok: true,
    state: 'loaded',
    loadedContextLength: loaded,
    parallel,
    message:
      'окно контекста совпадает с конфигом' +
      (parallel === null ? '; parallel-слоты НЕ проверены (lms CLI не ответил)' : ''),
  };
}
