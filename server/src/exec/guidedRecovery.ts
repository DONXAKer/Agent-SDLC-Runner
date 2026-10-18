import { z } from 'zod';

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
