export const protocolVersion = 1;

export function mergeRanges(ranges) {
  // Validate input
  if (!Array.isArray(ranges)) {
    throw new TypeError('Input must be an array');
  }

  // Handle empty input
  if (ranges.length === 0) {
    return [];
  }

  // Create a deep copy to avoid mutating input
  const copiedRanges = ranges.map(range => {
    if (!Array.isArray(range) || range.length !== 2) {
      throw new TypeError('Each range must be an array of exactly 2 numbers');
    }

    const start = range[0];
    const end = range[1];

    // Check if numbers are finite
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TypeError('Range endpoints must be finite numbers');
    }

    // Check if start <= end
    if (start > end) {
      throw new TypeError('Start must be less than or equal to end');
    }

    return [start, end];
  });

  // Sort ranges by start time
  copiedRanges.sort((a, b) => a[0] - b[0]);

  // Merge ranges
  const merged = [];
  let current = copiedRanges[0];

  for (let i = 1; i < copiedRanges.length; i++) {
    const next = copiedRanges[i];

    // If current range overlaps or touches next range, merge them
    if (current[1] >= next[0]) {
      current[1] = Math.max(current[1], next[1]);
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}
