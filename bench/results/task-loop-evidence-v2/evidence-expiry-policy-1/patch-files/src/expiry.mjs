export const protocolVersion = 1;

const DEFAULT_TTL_MS = 45000;

export function expiresAt(createdAtMs, ttlMs) {
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs)) {
    throw new RangeError(`createdAtMs must be a finite number, got ${String(createdAtMs)}`);
  }
  let ttl;
  if (ttlMs === undefined) {
    ttl = DEFAULT_TTL_MS;
  } else {
    ttl = ttlMs;
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl < 0) {
      throw new RangeError(`ttlMs must be a finite nonnegative number, got ${String(ttlMs)}`);
    }
  }
  const result = createdAtMs + ttl;
  if (!Number.isFinite(result)) {
    throw new RangeError(`expiresAt result is not finite: ${result}`);
  }
  return result;
}
