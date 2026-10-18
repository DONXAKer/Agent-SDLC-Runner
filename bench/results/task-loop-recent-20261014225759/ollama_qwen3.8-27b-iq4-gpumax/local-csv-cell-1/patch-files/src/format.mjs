export const protocolVersion = 1;

export function csvRow(values) {
  return values
    .map((value) => {
      const s = typeof value === 'string' ? value : String(value);
      if (/[",\r\n]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}
