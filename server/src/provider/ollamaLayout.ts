/**
 * Проверка раскладки модели по видеопамяти Ollama (`GET /api/ps`) — ПОСЛЕ прогрева, не до
 * него: раскладка известна только когда веса реально загружены запросом, а не просто
 * заявлены тегом.
 *
 * Критерий 1 квалификации рецензента (`docs/proposals/reviewer-qualification.md`):
 * частичный CPU-офлоад — самый частый корень зависаний/таймаутов под настоящей нагрузкой
 * (`apriel-1.6-15b`, `qwen3.8-27b`, `devstral-small-2`, `qwen3.6-27b-iq4`), и короткие
 * изолированные кейсы `--probe` (40–110 с) его не ловят по конструкции — вскрылось только
 * на настоящем `reviewFill` (`qwen3.6-27b-iq4`, 2026-09-27: проба 3/3, `ollama ps` во время
 * реального прогона — 26%/74% CPU/GPU, второй запрос завис на 20 минут). Раньше раскладку
 * проверял только человек командой `ollama ps` руками, постфактум.
 */

import { apiAbsent, stripLatest } from './ollamaContext.ts';
import { apiOrigin, describeFetchFailure, fetchJson } from './http.ts';

export interface OllamaLayoutCheck {
  ok: boolean;
  /** Проверка неприменима: по адресу нет Ollama-шного `/api`, либо модель не загружена. */
  skipped: boolean;
  /** Доля веса модели в видеопамяти, 0–100. `null` — не посчитана. */
  gpuPercent: number | null;
  message: string;
}

/** Ниже этого процента считаем офлоад частичным — тот самый класс отказа. */
export const FULL_GPU_THRESHOLD = 99;

interface OllamaPsEntry {
  name?: string;
  model?: string;
  size?: number;
  size_vram?: number;
}

interface OllamaPsBody {
  models?: OllamaPsEntry[];
}

export interface OllamaLayoutOptions {
  timeoutMs?: number;
}

/**
 * `expected: modelId` сравнивается тем же приёмом, что `checkOllamaContext` — без
 * нормализации суффикса `:latest` сравнение рвалось на РАБОЧЕЙ модели (см. докстринг там).
 */
export async function checkOllamaLayout(
  baseUrl: string,
  modelId: string,
  options: OllamaLayoutOptions = {},
): Promise<OllamaLayoutCheck> {
  const fail = (message: string, skipped = false): OllamaLayoutCheck => ({ ok: false, skipped, gpuPercent: null, message });
  const fetchOpts = options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs };

  const origin = apiOrigin(baseUrl);
  const psUrl = `${origin}/api/ps`;
  const res = await fetchJson(psUrl, fetchOpts);
  if (!res.ok) {
    const message = describeFetchFailure(psUrl, res.failure, 'Ollama', '`ollama serve`');
    return apiAbsent(res.failure) ? fail(`проверка раскладки Ollama неприменима — ${message}`, true) : fail(message);
  }
  const models = (res.body as OllamaPsBody | null)?.models;
  if (!Array.isArray(models)) {
    return fail(`проверка раскладки Ollama неприменима — ${psUrl} ответил без списка models (это не Ollama?)`, true);
  }

  const entry = models.find((m) => [m.name, m.model].some((n) => n !== undefined && stripLatest(n) === stripLatest(modelId)));
  if (entry === undefined) {
    return fail(
      `модель «${modelId}» не числится загруженной (\`ollama ps\` её не видит) — раскладку проверить не на чем ` +
        `(прогрев не разбудил её, или она успела выгрузиться до этой проверки)`,
      true,
    );
  }
  if (
    typeof entry.size !== 'number' ||
    !Number.isFinite(entry.size) ||
    entry.size <= 0 ||
    typeof entry.size_vram !== 'number' ||
    !Number.isFinite(entry.size_vram) ||
    entry.size_vram < 0
  ) {
    return fail(`\`ollama ps\` для «${modelId}» не отдал size/size_vram — раскладку посчитать нечем`, true);
  }

  // Округление/особенности учёта KV-кэша у ollama иногда дают size_vram чуть больше size —
  // модель при этом целиком в VRAM, просто «105.3% GPU» в сообщении вводило бы в заблуждение.
  const percent = Math.min(100, (entry.size_vram / entry.size) * 100);
  if (percent < FULL_GPU_THRESHOLD) {
    return fail(
      `раскладка «${modelId}»: ${percent.toFixed(1)}% GPU / ${(100 - percent).toFixed(1)}% CPU — частичный офлоад. ` +
        `Модель не влезает в видеопамять целиком на этой раскладке; короткая проба этого не показывает — ` +
        `вскрывается только настоящей нагрузкой (длинный контекст, несколько запросов подряд).`,
    );
  }
  return {
    ok: true,
    skipped: false,
    gpuPercent: percent,
    message: `раскладка «${modelId}»: ${percent.toFixed(1)}% GPU — целиком в видеопамяти`,
  };
}
