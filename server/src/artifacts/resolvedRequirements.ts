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

/** Add the runtime-owned field to a legacy draft; an existing fingerprint is never changed. */
export function addRequirementsHash(planText: string, hash: string): string {
  if (readRequirementsHash(planText) !== null) return planText;
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid requirements SHA-256');
  const line = `- **Требования (SHA-256):** ${hash}\n`;
  const base = /^- \*\*База:\*\*[^\n]*(?:\n|$)/mu;
  return base.test(planText)
    ? planText.replace(base, (match) => `${match.trimEnd()}\n${line}`)
    : `${planText.trimEnd()}\n\n${line}`;
}
