import { join } from 'node:path';
import type { WitokPaths } from '../artifacts/paths.ts';
import { readArtifact } from '../artifacts/artifact.ts';
import { h2SectionRanges } from '../md/table.ts';
import { readCanonicalState } from './canonicalState.ts';
import { acceptanceProblem, hasIndependentAcceptance } from './independentAcceptance.ts';

/** A required acceptance section cannot be satisfied by guided model prose. */
export function guidedAcceptanceProblem(paths: WitokPaths, methodologyDir: string, chunk: number, attempt: number): string | null {
  if (readCanonicalState(paths)) return null; // Protected acceptance registration/receipts have their own checks.
  const sources = [join(methodologyDir, 'templates', 'verification-report.template.md'), paths.verificationReport(chunk, attempt)];
  const required = sources.find(path => h2SectionRanges(readArtifact(path).text, /^Независимые приёмочные проверки$/iu).length > 0);
  return required || hasIndependentAcceptance(paths) ? acceptanceProblem(paths) : null;
}
