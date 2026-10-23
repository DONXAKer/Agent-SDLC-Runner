import { z } from 'zod';
import type { ChatTurn } from '../provider/ChatProvider.ts';
import { parseGuidedDecisionJson } from './guidedJson.ts';

/** A malformed whole object has no trustworthy fields to preserve. Rebuild one field per call. */
export async function rebuildGuidedObject(format: Record<string, unknown>, ask: (format: Record<string, unknown>, fields: readonly string[]) => Promise<ChatTurn>): Promise<Record<string, unknown>> {
  const wrapper = format.json_schema as { name?: string; schema?: { properties?: Record<string, unknown>; required?: string[]; $defs?: unknown } };
  const properties = wrapper?.schema?.properties;
  if (!properties || Object.keys(properties).length > 16) throw new Error('No bounded object reconstruction available');
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const part = { type: 'json_schema', json_schema: { name: `${wrapper.name ?? 'guided'}_field`, strict: true,
      schema: { type: 'object', properties: { [key]: properties[key] }, required: [key], additionalProperties: false,
        ...(wrapper.schema?.$defs ? { $defs: wrapper.schema.$defs } : {}) } } };
    const reply = await ask(part, [key]);
    const value = parseGuidedDecisionJson(reply.text, reply.toolCalls, reply.finishReason === 'max_tokens');
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, key)) throw new Error(`Expected only field ${key}`);
    result[key] = (value as Record<string, unknown>)[key];
  }
  return result;
}

/** Narrow a failed object to the addressed fields; retain valid neighbouring values.
 * Only schema failures with precise top-level paths permit this operation. */
export function narrowGuidedRepair(raw: unknown, error: unknown, format: Record<string, unknown>): {
  fields: string[]; format: Record<string, unknown>; merge: (patch: unknown) => unknown;
} | null {
  if (!(error instanceof z.ZodError) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const wrapper = format.json_schema as { name?: string; schema?: { properties?: Record<string, unknown>; required?: string[] } } | undefined;
  const properties = wrapper?.schema?.properties;
  if (!properties || error.issues.some(issue => typeof issue.path[0] !== 'string')) return null;
  const fields = [...new Set(error.issues.map(issue => String(issue.path[0])))];
  if (!fields.length || fields.some(field => !(field in properties))) return null;
  return {
    fields,
    format: { type: 'json_schema', json_schema: { name: `${wrapper?.name ?? 'guided'}_repair`, strict: true,
      schema: { type: 'object', properties: Object.fromEntries(fields.map(key => [key, properties[key]])), required: fields, additionalProperties: false } } },
    merge(patch: unknown) {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
          Object.keys(patch).length !== fields.length || fields.some(key => !Object.hasOwn(patch, key))) throw new Error('Ремонт должен содержать только адресованные поля');
      return { ...raw, ...patch };
    },
  };
}
