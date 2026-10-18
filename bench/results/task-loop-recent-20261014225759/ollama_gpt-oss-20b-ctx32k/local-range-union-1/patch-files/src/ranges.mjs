export const protocolVersion = 1;

/**
 * Merge overlapping or adjacent ranges.
 * @param {[number,number][]} ranges
 * @returns {[number,number][]}
 */
export function mergeRanges(ranges){
    if (!Array.isArray(ranges)) {
        throw new TypeError('ranges must be an array');
    }
    // Validate and clone
    const cloned = ranges.map((r, idx)=>{
        if (!Array.isArray(r) || r.length !== 2) {
            throw new TypeError(`range at index ${idx} is not a 2-element array`);
        }
        const [start, end] = r;
        if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end)) {
            throw new TypeError(`range at index ${idx} contains non-finite numbers`);
        }
        if (start > end) {
            throw new TypeError(`range at index ${idx} has start greater than end`);
        }
        return [start, end];
    });

    if (cloned.length === 0) return [];

    // Sort by start
    cloned.sort((a,b)=>a[0]-b[0]);

    const merged = [];
    let currentStart = cloned[0][0];
    let currentEnd = cloned[0][1];
    for (let i=1; i<cloned.length; i++){
        const [s, e] = cloned[i];
        if (s <= currentEnd){ // overlapping or touching
            if (e > currentEnd) currentEnd = e;
        } else {
            merged.push([currentStart, currentEnd]);
            currentStart = s;
            currentEnd = e;
        }
    }
    merged.push([currentStart, currentEnd]);
    return merged;
}

