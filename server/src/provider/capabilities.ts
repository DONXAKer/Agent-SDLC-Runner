import { apiOrigin, fetchJson } from './http.ts';
import { baseUrlFor } from './registry.ts';

export type CapabilitySupport = 'supported' | 'unsupported' | 'unknown';

export interface ModelCapabilities {
  provider: string;
  model: string;
  source: 'ollama-show' | 'lmstudio-models' | 'unavailable';
  tools: CapabilitySupport;
  reasoning: CapabilitySupport;
  reasoningOptions: readonly string[] | null;
  reasoningDefault: string | null;
  detail: string;
}

function listed(values: unknown, capability: string): CapabilitySupport {
  return Array.isArray(values) ? values.includes(capability) ? 'supported' : 'unsupported' : 'unknown';
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function normalizeOllamaCapabilities(provider: string, model: string, body: unknown): ModelCapabilities {
  const capabilities = (body as { capabilities?: unknown } | null)?.capabilities;
  return {
    provider, model, source: 'ollama-show',
    tools: listed(capabilities, 'tools'),
    reasoning: listed(capabilities, 'thinking'),
    reasoningOptions: null,
    reasoningDefault: null,
    detail: Array.isArray(capabilities) ? `capabilities: ${capabilities.join(', ')}` : 'capabilities не опубликованы сервером',
  };
}

export function normalizeLmStudioCapabilities(provider: string, model: string, entry: unknown): ModelCapabilities {
  const capabilities = (entry as { capabilities?: unknown } | null)?.capabilities;
  if (Array.isArray(capabilities)) {
    return {
      provider, model, source: 'lmstudio-models',
      tools: listed(capabilities, 'tools'),
      reasoning: listed(capabilities, 'thinking') === 'supported' ? 'supported' : listed(capabilities, 'reasoning'),
      reasoningOptions: null,
      reasoningDefault: null,
      detail: `capabilities: ${capabilities.join(', ')}`,
    };
  }
  const object = typeof capabilities === 'object' && capabilities !== null
    ? capabilities as { trained_for_tool_use?: unknown; reasoning?: { allowed_options?: unknown; default?: unknown } }
    : null;
  const reasoning = object?.reasoning;
  const options = Array.isArray(reasoning?.allowed_options)
    ? reasoning.allowed_options.filter((value): value is string => typeof value === 'string')
    : null;
  return {
    provider, model, source: 'lmstudio-models',
    tools: typeof object?.trained_for_tool_use === 'boolean' ? object.trained_for_tool_use ? 'supported' : 'unsupported' : 'unknown',
    reasoning: reasoning === undefined ? 'unknown' : options?.length === 0 ? 'unsupported' : 'supported',
    reasoningOptions: options,
    reasoningDefault: text(reasoning?.default),
    detail: object === null ? 'capabilities не опубликованы сервером' : `capabilities: tools=${object.trained_for_tool_use ?? 'unknown'}, reasoning=${options?.join('/') ?? 'unknown'}`,
  };
}

export async function capabilitiesFor(
  provider: string,
  model: string,
  providerBaseUrl?: string,
): Promise<ModelCapabilities | null> {
  if (provider !== 'ollama' && provider !== 'lmstudio') return null;
  const baseUrl = baseUrlFor(provider) ?? providerBaseUrl;
  if (baseUrl === undefined || baseUrl === '') return null;
  const origin = apiOrigin(baseUrl);
  if (provider === 'ollama') {
    const url = `${origin}/api/show`;
    const response = await fetchJson(url, {
      init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: model }) },
    });
    if (!response.ok) return { provider, model, source: 'unavailable', tools: 'unknown', reasoning: 'unknown', reasoningOptions: null, reasoningDefault: null, detail: `capabilities недоступны: ${response.failure.kind}` };
    return normalizeOllamaCapabilities(provider, model, response.body);
  }
  const url = `${origin}/api/v0/models`;
  const response = await fetchJson(url);
  if (!response.ok) return { provider, model, source: 'unavailable', tools: 'unknown', reasoning: 'unknown', reasoningOptions: null, reasoningDefault: null, detail: `capabilities недоступны: ${response.failure.kind}` };
  const data = (response.body as { data?: unknown[] } | null)?.data;
  const entry = Array.isArray(data) ? data.find(value => (value as { id?: unknown }).id === model) : undefined;
  if (entry === undefined) return { provider, model, source: 'unavailable', tools: 'unknown', reasoning: 'unknown', reasoningOptions: null, reasoningDefault: null, detail: 'модель не найдена в ответе capabilities' };
  return normalizeLmStudioCapabilities(provider, model, entry);
}
