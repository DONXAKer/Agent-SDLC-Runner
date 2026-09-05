/**
 * Выбор провайдера по маршруту.
 *
 * Ключ и адрес берутся из окружения по имени провайдера (`OPENROUTER_API_KEY`,
 * `OLLAMA_BASE_URL` и так далее). Локальным серверам ключ не нужен, и требовать его с них
 * значило бы заставить оператора придумывать пустышку.
 */

import type { ProviderDef } from '../config/schema.ts';
import type { ChatProvider } from './ChatProvider.ts';
import { OpenAiCompatProvider } from './OpenAiCompatProvider.ts';
import type { TraceLabel } from './rawLog.ts';

/**
 * Провайдеры, за которые платят по токенам. Список нужен ровно для одного: потребовать
 * ключ. Стоимость сюда не относится — её показывает только тот сервер, который её назвал.
 */
const PAID = new Set(['openrouter', 'aitunnel', 'anthropic', 'alltokens', 'polza']);

/**
 * Имя переменной окружения для провайдера — единственное место, где оно строится.
 *
 * Раньше `apiKeyFor`/`baseUrlFor` строили его сами (с санитайзингом небуквенных символов),
 * а тексты ошибок — заново, но уже БЕЗ санитайзинга (`name.toUpperCase()`): для провайдера
 * с дефисом или точкой в имени сообщение об ошибке называло бы переменную, которую сам код
 * не читает. Один разбор на обе стороны это устраняет по построению, а не по памяти.
 */
function envKey(provider: string, suffix: 'API_KEY' | 'BASE_URL'): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`;
}

/**
 * Значение переменной окружения провайдера. Не заданная, пустая и чисто пробельная строка
 * — все три «не задано»: хвостовой пробел из копипасты в `.env` иначе превращался бы в
 * часть baseUrl или ключа и давал бы `%20` в пути запроса вместо понятной ошибки.
 */
function envFor(provider: string, suffix: 'API_KEY' | 'BASE_URL'): string | null {
  const value = process.env[envKey(provider, suffix)];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function apiKeyFor(provider: string): string | null {
  return envFor(provider, 'API_KEY');
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
  return envFor(provider, 'BASE_URL');
}

/**
 * `trace` — метка сырого дампа запросов (`rawLog.ts`). Ставится здесь, а не в
 * `ChatRequest`: экземпляр провайдера и так создаётся под конкретный этап и режим, и
 * метка на запрос повторяла бы одно и то же в пяти местах вызова `provider.chat`. Не
 * передана — дампа для этого маршрута нет, что бы ни стояло в окружении.
 */
export function createProvider(
  name: string,
  def: ProviderDef,
  timeoutMs: number,
  trace?: TraceLabel,
): ChatProvider {
  if (def.kind === 'openai-compat') {
    const baseUrl = baseUrlFor(name) ?? def.baseUrl;
    // Пустая строка в config/models.json — тоже «не задано»: `baseUrl === undefined` одна
    // не ловит `"baseUrl": ""`, и код уходил бы дальше с пустым адресом до первого fetch,
    // где падал бы нативной `Failed to parse URL`, а не понятным сообщением ниже.
    if (baseUrl === undefined || baseUrl === '') {
      throw new Error(
        `провайдер «${name}»: не задан baseUrl ни в config/models.json, ни в ` +
          `${envKey(name, 'BASE_URL')}`,
      );
    }
    const apiKey = apiKeyFor(name);
    if (apiKey === null && PAID.has(name)) {
      throw new Error(
        `провайдер «${name}» платный, но ключа нет: задай ${envKey(name, 'API_KEY')} в окружении`,
      );
    }
    return new OpenAiCompatProvider({
      name,
      baseUrl,
      apiKey,
      timeoutMs,
      ...(trace === undefined ? {} : { trace }),
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
