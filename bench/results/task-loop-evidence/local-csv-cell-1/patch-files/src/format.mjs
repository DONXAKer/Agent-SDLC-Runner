export const protocolVersion = 1;

export function csvRow(values) {
  return values
    .map((v) => {
      const s = String(v);
      return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
    })
    .join(',');
}
