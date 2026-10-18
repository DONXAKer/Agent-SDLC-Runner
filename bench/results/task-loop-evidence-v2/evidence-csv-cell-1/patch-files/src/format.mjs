export const protocolVersion = 1;

export function csvRow(values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array');
  return values.map(cell => {
    if (cell === '') return '';
    if (/[",\r\n]/.test(cell)) return '"' + cell.replaceAll('"', '""') + '"';
    return cell;
  }).join(',');
}
