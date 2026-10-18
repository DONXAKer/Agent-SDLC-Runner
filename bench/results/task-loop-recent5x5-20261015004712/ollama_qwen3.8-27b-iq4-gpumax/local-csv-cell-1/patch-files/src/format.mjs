export const protocolVersion = 1;

const QUOTE_TRIGGERS = /[",\r\n]/;

export function csvRow(values) {
  if (!Array.isArray(values)) {
    throw new TypeError('csvRow expects an array of strings');
  }
  return values
    .map((value) => {
      const cell = String(value);
      if (QUOTE_TRIGGERS.test(cell)) {
        return '"' + cell.replace(/"/g, '""') + '"';
      }
      return cell;
    })
    .join(',');
}
