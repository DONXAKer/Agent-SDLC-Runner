export const protocolVersion = 1;

export function splitCents(total, count) {
  // Validate inputs
  if (!Number.isInteger(total) || total < 0 || total > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('total must be a nonnegative safe integer');
  }
  
  if (!Number.isInteger(count) || count <= 0 || count > 1000) {
    throw new RangeError('count must be a positive safe integer <= 1000');
  }
  
  // Calculate base share and remainder
  const baseShare = Math.floor(total / count);
  const remainder = total % count;
  
  // Create array of shares
  const shares = new Array(count).fill(baseShare);
  
  // Distribute remainder to earliest indices
  for (let i = 0; i < remainder; i++) {
    shares[i] += 1;
  }
  
  return shares;
}
