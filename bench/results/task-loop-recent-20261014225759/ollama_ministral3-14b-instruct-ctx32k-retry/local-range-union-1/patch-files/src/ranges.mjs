export const protocolVersion = 1;

/**
 * Merge overlapping or touching ranges into contiguous ranges.
 * @param {number[][]} ranges — Input array of ranges as [start, end].
 * @returns {number[][]} — Sorted, non-overlapping merged ranges.
 * @throws {TypeError} — If any range is invalid.
 */
export function mergeRanges(ranges) {
    if (!Array.isArray(ranges)) {
        throw new TypeError('Input must be an array');
    }
    
    const result = [];

    // Convert input to internal {start, end} objects, for validation and sorting
    const internal = [];
    for (const item of ranges) {
        if (!Array.isArray(item) || item.length !== 2) {
            throw new TypeError('Each range must be an array of exactly 2 numbers');
        }

        const start = Number(item[0]);
        const end = Number(item[1]);

        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            throw new TypeError("Range endpoints must be finite numbers");
        }

        if (start > end) {
            throw new TypeError('Range start must be <= end');
        }

        internal.push({start, end});
    }

    // Sort ranges by start coordinate
    internal.sort((a, b) => a.start - b.start);

    // Merge contiguous or overlapping ranges
    const merged = [];
    for (const r of internal) {
        const last = merged[merged.length - 1];
        if (!last || last.end < r.start) {
            // No overlap with last; add as new
            merged.push(r);
        } else {
            // Overlap; merge with last
            last.end = Math.max(last.end, r.end);
        }
    }

    // Convert internal {start, end} objects back to [start, end] arrays
    return merged.map(r => [r.start, r.end]);
}