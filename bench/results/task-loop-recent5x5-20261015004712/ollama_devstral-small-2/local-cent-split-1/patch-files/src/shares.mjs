export const protocolVersion = 1;

export function splitCents(total, count) {
  // Validate inputs
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError('total must be a nonnegative safe integer');
  }
  if (!Number.isSafeInteger(count) || count <= 0 || count > 1000) {
    throw new RangeError('count must be a positive safe integer <= 1000');
  }

  // Calculate base amount and remainder
  const base = Math.floor(total / count);
  const remainder = total % count;

  // Create shares array
  const shares = [];
  for (let i = 0; i < count; i++) {
    shares[i] = base + (i < remainder ? 1 : 0);
  }

  return shares;
}