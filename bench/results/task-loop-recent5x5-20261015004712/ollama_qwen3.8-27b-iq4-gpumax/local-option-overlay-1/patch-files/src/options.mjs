export const protocolVersion = 1;

export function resolveOptions(base, override) {
  const result = {};
  for (const key of Object.keys(base)) {
    Object.defineProperty(result, key, {
      value: base[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  for (const key of Object.keys(override)) {
    if (override[key] !== undefined) {
      Object.defineProperty(result, key, {
        value: override[key],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return result;
}
