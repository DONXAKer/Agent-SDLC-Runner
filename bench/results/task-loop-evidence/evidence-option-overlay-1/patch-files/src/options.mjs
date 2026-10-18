export const protocolVersion = 1;

export function resolveOptions(base, override) {
  const result = {};
  for (const key of Object.keys(base)) {
    result[key] = base[key];
  }
  for (const key of Object.keys(override)) {
    if (override[key] === undefined) {
      // undefined override value keeps the base value;
      // if the key is absent from base it stays omitted
      continue;
    }
    result[key] = override[key];
  }
  return result;
}
