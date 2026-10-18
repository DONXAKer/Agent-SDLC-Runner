export const protocolVersion = 1;

export function csvRow(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('Values must be an array');
  }

  if (values.length === 0) {
    return '';
  }

  const cell = (value) => {
    // Convert to string to preserve whitespace and Unicode
    const str = String(value);
    
    // Check if we need to quote the cell
    if (str.includes(',') || str.includes('"') || str.includes('\r') || str.includes('\n')) {
      // Escape double quotes by doubling them
      const escaped = str.replace(/\"/g, '""');
      // Quote the cell
      return `"${escaped}"`;
    }
    
    return str;
  };

  // Map each value to its CSV cell representation and join with commas
  return values.map(cell).join(',');
}
