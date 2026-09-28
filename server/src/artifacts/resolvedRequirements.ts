/** Fingerprint binds an approved plan to the exact requirement and clarification sources. */
import { createHash } from 'node:crypto';

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

export function resolvedRequirementsHash(intent: string, clarifications: string): string {
  const payload = JSON.stringify({ version: 1, intent: normalize(intent), clarifications: normalize(clarifications) });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function readRequirementsHash(planText: string): string | null {
  const match = /^- \*\*Требования \(SHA-256\):\*\*\s*`?([a-f0-9]{64})`?\s*$/im.exec(planText);
  return match?.[1] ?? null;
}
