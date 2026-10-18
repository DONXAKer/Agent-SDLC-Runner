export const protocolVersion = 1;

const needsQuotes = /[",\r\n]/u;

function csvCell(value) {
  const cell = String(value);
  return needsQuotes.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export function csvRow(values) {
  return values.map(csvCell).join(',');
}
