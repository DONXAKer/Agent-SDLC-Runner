export const protocolVersion = 1;

const DEFAULT_TTL_MS = 45000;

/**
 * Compute the expiration timestamp for an item created at `createdAtMs`
 * with the given `ttlMs` (or the default TTL when omitted).
 */
export function expiresAt(createdAtMs, ttlMs = DEFAULT_TTL_MS) {
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) {
    throw new RangeError('createdAtMs must be a finite number');
  }
  if (ttlMs === null || typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new RangeError('ttlMs must be a finite nonnegative number (null is invalid)');
  }
  const result = createdAtMs + ttlMs;
  if (!Number.isFinite(result)) {
    throw new RangeError('computed expiry is not finite');
  }
  return result;
}
