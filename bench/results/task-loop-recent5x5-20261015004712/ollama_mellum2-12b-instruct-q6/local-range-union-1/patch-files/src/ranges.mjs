export const protocolVersion = 1;

export function mergeRanges(ranges) {
  // Handle empty input
  if (ranges.length === 0) {
    return [];
  }

  // Validate input pairs
  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new TypeError('Invalid pair');
    }
    
    const [start, end] = pair;
    
    // Check for finite numbers
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TypeError('Nonfinite number');
    }
    
    // Check for valid range (start <= end)
    if (start > end) {
      throw new TypeError('Reversed endpoints');
    }
  }

  // Sort ranges by start value
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);

  // Merge overlapping or touching ranges
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const current = sorted[i];

    // If current range touches or overlaps the last merged range
    if (current[0] <= last[1]) {
      // Merge by updating the end value of the last range
      last[1] = Math.max(last[1], current[1]);
    } else {
      // Add current range as a new range
      merged.push(current);
    }
  }

  return merged;
}
