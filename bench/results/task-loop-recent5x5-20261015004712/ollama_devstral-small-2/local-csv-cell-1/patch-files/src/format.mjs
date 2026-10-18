export const protocolVersion = 1;

export function csvRow(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('csvRow expects an array of strings');
  }

  const result = [];
  for (const value of values) {
    // Check if value needs quoting
    const needsQuoting = typeof value === 'string' && (
      value.includes('"') || 
      value.includes(',') || 
      value.includes('\r') || 
      value.includes('\n')
    );

    let cell;
    if (needsQuoting) {
      // Escape quotes by doubling them
      cell = '"' + value.replace(/"/g, '""') + '"';
    } else {
      cell = value;
    }

    result.push(cell);
  }

  return result.join(',');
}
