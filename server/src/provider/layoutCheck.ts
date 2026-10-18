/**
 * Диспетчер преполётной проверки раскладки модели по видеопамяти — по провайдеру.
 *
 * Сегодня реализован только Ollama: `GET /api/ps` отдаёт `size`/`size_vram` напрямую
 * (`ollamaLayout.ts`). LM Studio не заведён — `lms ps --json` в этом репозитории разобран
 * только на поле `parallel` (`lmstudioContext.ts`), эквивалентного поля под долю GPU/CPU не
 * найдено, и сочинять его не будем; провайдер молча пропускается (`null`), как и облачные.
 *
 * Тот же приём, что `contextCheck.ts::contextProblemFor` — одна функция на дешёвый
 * скрининг (`--probe`/`--preflight`) и на живой прогон, с одинаковым разбором baseUrl.
 */

import { checkOllamaLayout } from './ollamaLayout.ts';
import { baseUrlFor } from './registry.ts';

export interface LayoutProblem {
  message: string;
}

export async function layoutProblemFor(
  provider: string,
  modelId: string,
  providerBaseUrl: string | undefined,
  timeoutMs?: number,
): Promise<LayoutProblem | null> {
  if (provider !== 'ollama') return null;
  const baseUrl = baseUrlFor(provider) ?? providerBaseUrl;
  if (baseUrl === undefined || baseUrl === '') return null;

  const r = await checkOllamaLayout(baseUrl, modelId, timeoutMs === undefined ? {} : { timeoutMs });
  // `skipped` — по адресу нет Ollama-шного `/api`, либо модель не числится загруженной
  // (`ollama ps` её не видит: прогрев не разбудил её или она успела выгрузиться) —
  // блокировать преполёт нечем, он работал бы и без этой проверки.
  if (r.ok || r.skipped) return null;
  return { message: r.message };
}
