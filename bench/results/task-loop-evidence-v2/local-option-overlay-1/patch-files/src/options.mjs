export const protocolVersion = 1;

/**
 * Shallow-merge `override` onto `base`.
 *
 * Only own enumerable string keys are considered. Keys whose value is
 * `undefined` in `override` keep the corresponding `base` value, and if the
 * key is absent from `base` it is omitted from the result. All other values
 * (`null`, `false`, `0`, `''`, …) are copied through as-is.
 *
 * Returns a new plain object; inputs are never mutated.
 */
export function resolveOptions(base, override = {}) {
  const result = {};

  for (const key of Object.keys(base)) {
    result[key] = base[key];
  }

  for (const key of Object.keys(override)) {
    if (override[key] === undefined) {
      // Keep the base value (or omit if absent from base).
      continue;
    }
    result[key] = override[key];
  }

  return result;
}
