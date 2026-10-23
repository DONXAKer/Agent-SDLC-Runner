export function makeMessage(caption) {
  if (typeof caption !== 'string') throw new TypeError('string required');
  return { caption };
}
export function encodeMessage(value) {
  return JSON.stringify({ caption: value.caption });
}
export function decodeMessage(line) {
  return makeMessage(JSON.parse(line).caption);
}

