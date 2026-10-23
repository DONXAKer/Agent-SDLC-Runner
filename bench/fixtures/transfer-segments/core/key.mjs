export function normalizeKey(value) {
  if (typeof value !== 'string') throw new TypeError('key must be a string');
  return value;
}

