export const protocolVersion = 1;

/**
 * Split `total` cents into `count` integer shares that differ by at most one.
 * The first `total % count` shares receive one extra cent.
 */
export function splitCents(total, count) {
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('total must be a nonnegative safe integer');
  }
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0 || count > 1000) {
    throw new RangeError('count must be a positive safe integer <= 1000');
  }

  const base = Math.floor(total / count);
  const remainder = total % count;
  const shares = new Array(count);
  for (let i = 0; i < count; i++) {
    shares[i] = base + (i < remainder ? 1 : 0);
  }
  return shares;
}
