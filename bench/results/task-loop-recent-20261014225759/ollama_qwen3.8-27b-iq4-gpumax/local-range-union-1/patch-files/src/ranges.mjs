export const protocolVersion = 1;

export function mergeRanges(ranges) {
  if (!Array.isArray(ranges)) {
    throw new TypeError('ranges must be an array');
  }

  const sorted = ranges.map((pair, index) => {
    if (!Array.isArray(pair)) {
      throw new TypeError(`pair at index ${index} must be an array`);
    }
    if (pair.length !== 2) {
      throw new TypeError(`pair at index ${index} must contain exactly two elements`);
    }
    const [start, end] = pair;
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      throw new TypeError(`start at index ${index} must be a finite number`);
    }
    if (typeof end !== 'number' || !Number.isFinite(end)) {
      throw new TypeError(`end at index ${index} must be a finite number`);
    }
    if (start > end) {
      throw new TypeError(`reversed endpoints at index ${index}: start must be <= end`);
    }
    return [start, end];
  });

  if (sorted.length === 0) {
    return [];
  }

  sorted.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const merged = [];
  let current = [sorted[0][0], sorted[0][1]];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    if (start <= current[1]) {
      if (end > current[1]) {
        current[1] = end;
      }
    } else {
      merged.push(current);
      current = [start, end];
    }
  }
  merged.push(current);

  return merged;
}
