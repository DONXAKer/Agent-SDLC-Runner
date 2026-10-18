export const protocolVersion = 1;

/**
 * Shallow-merge override into base, respecting undefined and prototype safety.
 *
 * @param {Object} base - Plain object containing base options.
 * @param {Object} override - Plain object containing overriding options.
 * @returns {Object} New object with merged options.
 */
export function resolveOptions(base, override) {
  const result = {};
  // Copy base own enumerable properties
  for (const key of Object.keys(base)) {
    const value = base[key];
    Object.defineProperty(result, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }

  // Merge override
  for (const key of Object.keys(override)) {
    const overrideValue = override[key];
    if (overrideValue === undefined) {
      // If override explicitly sets undefined but key exists in base, keep base value
      if (key in base) {
        // base already copied; do nothing
        continue;
      }
      // key not in base, omit entirely
      continue;
    }
    // Explicit value
    Object.defineProperty(result, key, {
      value: overrideValue,
      writable: true,
      enumerable: true,
      configurable: true
    });
  }

  return result;
}
