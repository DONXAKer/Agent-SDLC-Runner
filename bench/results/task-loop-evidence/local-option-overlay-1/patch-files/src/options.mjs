export const protocolVersion = 1;

export function resolveOptions(base, override) {
  const result = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
