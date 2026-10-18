export const protocolVersion = 1;

function assertRange(range, index) {
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    !Number.isFinite(range[0]) ||
    !Number.isFinite(range[1]) ||
    range[0] > range[1]
  ) {
    throw new TypeError(`invalid range at index ${index}`);
  }
}

export function mergeRanges(ranges) {
  if (!Array.isArray(ranges)) {
    throw new TypeError('ranges must be an array');
  }
  ranges.forEach((range, index) => assertRange(range, index));

  const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}
