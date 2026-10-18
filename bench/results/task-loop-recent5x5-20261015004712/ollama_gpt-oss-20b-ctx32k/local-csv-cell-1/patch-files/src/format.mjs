export const protocolVersion = 1;

export const csvRow = (values) => {
    if (!Array.isArray(values)) {
        throw new TypeError('csvRow expects an array of strings');
    }
    // Return empty string for empty array
    if (values.length === 0) return '';
    const escapeCell = (cell) => {
        const s = String(cell);
        const needsQuoting = /[",\r\n]/.test(s);
        if (!needsQuoting) return s;
        const escaped = s.replace(/"/g, '""');
        return `"${escaped}"`;
    };
    const escapedCells = values.map(escapeCell);
    return escapedCells.join(',');
};
