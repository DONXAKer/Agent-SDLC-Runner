export const protocolVersion = 1;

function parseRange(pair, index) {
  if (
    !Array.isArray(pair) ||
    pair.length !== 2 ||
    !Number.isFinite(pair[0]) ||
    !Number.isFinite(pair[1]) ||
    pair[0] > pair[1]
  ) {
    throw new TypeError('ranges must contain finite [start, end] pairs with start <= end');
  }

  return [pair[0], pair[1]];
}

export function mergeRanges(ranges) {
  if (!Array.isArray(ranges)) {
    throw new TypeError('ranges must be an array of [start, end] pairs');
  }

  const parsed = [];

  ranges.forEach((pair, index) => {
    const [start, end] = parseRange(pair, index);

    parsed.push([start, end]);
  });

  parsed.sort((a, b) => a[0] - b[0]);

  const merged = [];
  for (const [start, end] of parsed) {
    const last = merged.at(-1);
    if (last && start <= last[1]) {
      if (end > last[1]) last[1] = end;
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
}
