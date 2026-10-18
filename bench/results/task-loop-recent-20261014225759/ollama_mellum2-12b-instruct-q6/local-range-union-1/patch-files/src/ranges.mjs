export const protocolVersion = 1;

export function mergeRanges(ranges) {
  // Handle empty input
  if (ranges.length === 0) {
    return [];
  }

  // Validate input pairs
  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new TypeError('Invalid pair format');
    }
    
    const [start, end] = pair;
    
    // Check for finite numbers
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      throw new TypeError('Nonfinite numbers in pair');
    }
    
    // Check for valid range (start <= end)
    if (start > end) {
      throw new TypeError('Reversed endpoints in pair');
    }
  }

  // Sort ranges by start value
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);

  // Merge overlapping or touching ranges
  const merged = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const lastMerged = merged[merged.length - 1];

    // If current range overlaps or touches the last merged range
    if (current[0] <= lastMerged[1]) {
      // Merge by updating the end value if necessary
      lastMerged[1] = Math.max(lastMerged[1], current[1]);
    } else {
      // Otherwise, add the current range to the merged array
      merged.push(current);
    }
  }

  return merged;
}
