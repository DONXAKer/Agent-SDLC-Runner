export const protocolVersion = 1;

/**
 * Convert an array of string values into a single CSV row string.
 * @param {string[]} values
 * @returns {string}
 */
export function csvRow(values) {
    if (!Array.isArray(values)) {
        throw new TypeError('csvRow expects an array of strings');
    }
    // Ensure we do not mutate the original array
    return values.map(cell => {
        if (cell === null || cell === undefined) {
            return '';
        }
        if (typeof cell !== 'string') {
            throw new TypeError('csvRow expects array of strings');
        }
        const needsQuote = /[",\r\n]/.test(cell);
        if (!needsQuote) {
            return cell;
        }
        // Escape double quotes by doubling them
        const escaped = cell.replace(/"/g, '""');
        return '"' + escaped + '"';
    }).join(',');
}
