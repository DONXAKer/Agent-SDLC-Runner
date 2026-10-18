export const protocolVersion = 1;

const needsQuoting = /[",\r\n]/;

function formatCell(value) {
  if (needsQuoting.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function csvRow(values) {
  return values.map(formatCell).join(',');
}
