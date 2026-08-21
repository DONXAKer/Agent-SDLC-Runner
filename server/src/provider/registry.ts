/**
 * Выбор провайдера по маршруту.
 *
 * Ключ берётся из окружения по имени провайдера (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`
 * и так далее). Локальным серверам ключ не нужен, и требовать его с них значило бы
 * заставить оператора придумывать пустышку.
 */

import type { ProviderDef } from '../config/schema.ts';
import type { ChatProvider } from './ChatProvider.ts';
import { OpenAiCompatProvider } from './OpenAiCompatProvider.ts';

/**
 * Провайдеры, за которые платят по токенам. Список нужен ровно для одного: потребовать
 * ключ. Стоимость сюда не относится — её показывает только тот сервер, который её назвал.
 */
const PAID = new Set(['openrouter', 'aitunnel', 'anthropic']);

export function apiKeyFor(provider: string): string | null {
  const key = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
  const value = process.env[key];
  return value === undefined || value === '' ? null : value;
}

/**
 * `baseUrl` локального/OpenAI-совместимого сервера — тем же способом, что и ключ платного
 * провайдера выше: по имени провайдера в окружении, а не правкой закоммиченного
 * `config/models.json`. Хост и порт Ollama/vLLM/LM Studio — ровно то, что «меняется от
 * машины к машине»: петля на одной машине, `host.docker.internal` в Docker, нестандартный
 * порт или вовсе удалённый сервер на третьей. `config/models.json` при этом остаётся
 * рабочим значением по умолчанию, а не обязательным к правке шаблоном.
 */
export function baseUrlFor(provider: string): string | null {
  const key = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_BASE_URL`;
  const value = process.env[key];
  return value === undefined || value === '' ? null : value;
}

export function createProvider(
  name: string,
  def: ProviderDef,
  timeoutMs: number,
): ChatProvider {
  if (def.kind === 'openai-compat') {
    const baseUrl = baseUrlFor(name) ?? def.baseUrl;
    if (baseUrl === undefined) {
      throw new Error(
        `провайдер «${name}»: не задан baseUrl ни в config/models.json, ни в ` +
          `${name.toUpperCase()}_BASE_URL`,
      );
    }
    const apiKey = apiKeyFor(name);
    if (apiKey === null && PAID.has(name)) {
      throw new Error(
        `провайдер «${name}» платный, но ключа нет: задай ${name.toUpperCase()}_API_KEY в окружении`,
      );
    }
    return new OpenAiCompatProvider({
      name,
      baseUrl,
      apiKey,
      timeoutMs,
    });
  }

  if (def.kind === 'anthropic-api') {
    // Запасной маршрут «Anthropic по ключу» осознанно не реализован: он оплачивается
    // отдельно от подписки, ради которой существует флоу `sdk`. Молча подменять его
    // OpenAI-совместимым клиентом нельзя — у Messages API другой формат tool-use, и
    // вызовы инструментов просто не приехали бы.
    throw new Error(
      `маршрут «${name}» (Anthropic Messages API) не реализован. Для Claude используй ` +
        `провайдер claude-sdk — он идёт по подписке. Локальные модели — ollama/vllm/lmstudio.`,
    );
  }

  throw new Error(
    `провайдер «${name}» с kind=${def.kind} не относится к флоу loop — это ошибка конфигурации`,
  );
}
