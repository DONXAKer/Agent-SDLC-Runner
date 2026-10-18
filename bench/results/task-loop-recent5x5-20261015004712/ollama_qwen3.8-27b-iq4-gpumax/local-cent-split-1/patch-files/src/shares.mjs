export const protocolVersion = 1;

/**
 * Split a nonnegative integer amount of cents into `count` integer shares.
 * Shares differ by at most one; the earliest indices receive the extra cents.
 *
 * @throws {RangeError} if total or count is out of range.
 */
export function splitCents(total, count) {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 1000
  ) {
    throw new RangeError('total must be a nonnegative safe integer and count a positive safe integer <= 1000');
  }
  const base = Math.floor(total / count);
  const extra = total % count;
  const shares = new Array(count).fill(base);
  for (let i = 0; i < extra; i++) {
    shares[i] += 1;
  }
  return shares;
}
