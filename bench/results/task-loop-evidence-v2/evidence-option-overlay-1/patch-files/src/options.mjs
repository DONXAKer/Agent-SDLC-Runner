export const protocolVersion = 1;

export function resolveOptions(base, override) {
  const baseObj = base ?? {};
  const overrideObj = override ?? {};
  const out = {};

  for (const key of Object.keys(baseObj)) {
    if (Object.prototype.hasOwnProperty.call(baseObj, key)) {
      out[key] = baseObj[key];
    }
  }

  for (const key of Object.keys(overrideObj)) {
    if (Object.prototype.hasOwnProperty.call(overrideObj, key)) {
      const value = overrideObj[key];
      if (value === undefined) {
        if (!Object.prototype.hasOwnProperty.call(baseObj, key)) {
          delete out[key];
        }
      } else {
        out[key] = value;
      }
    }
  }

  return out;
}
