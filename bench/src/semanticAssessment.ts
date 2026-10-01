import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { digest } from './diagnostics.ts';

export interface SemanticAssessment {
  caseId: string;
  resultFile: string;
  resultHash: string;
  outcome: 'pass' | 'fail';
  rationale: string;
  evidence: Array<{ path: string; sha256: string; quote: string }>;
}

/** Оценка действительна только для конкретного неизменённого результата и его улик. */
export function readSemanticAssessment(root: string, caseId: string, resultFile: string): SemanticAssessment | null {
  const catalog = resolve(root, 'bench/diagnostics/semantic-assessments.json');
  if (!existsSync(catalog)) return null;
  const withinRoot = (path: string): string | null => {
    if (isAbsolute(path)) return null;
    const absolute = resolve(root, path);
    return absolute.startsWith(resolve(root) + sep) ? absolute : null;
  };
  try {
    const records = JSON.parse(readFileSync(catalog, 'utf8')).assessments as SemanticAssessment[];
    const record = records.findLast((r) => r.caseId === caseId && r.resultFile === resultFile);
    const result = withinRoot(resultFile);
    if (!record || !result || !['pass', 'fail'].includes(record.outcome) || !record.rationale.trim()
      || !record.evidence.length || digest(readFileSync(result)) !== record.resultHash) return null;
    for (const evidence of record.evidence) {
      const file = withinRoot(evidence.path);
      if (!file || !evidence.quote.trim()) return null;
      const data = readFileSync(file);
      if (digest(data) !== evidence.sha256 || !data.toString('utf8').includes(evidence.quote)) return null;
    }
    return record;
  } catch { return null; }
}
