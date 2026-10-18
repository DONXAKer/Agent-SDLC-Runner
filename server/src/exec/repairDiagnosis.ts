import { z } from 'zod';
import { parseGuidedJson } from './guidedJson.ts';
import { isTestPath } from '../explore/tree.ts';

const Diagnosis = z.object({ kind: z.enum(['implementation', 'test-expectation', 'unknown']), reason: z.string().min(1).max(600),
  observedFailure: z.string().min(1).max(600),
  source: z.object({ request: z.number().int().positive(), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]) }).strict().nullable(),
}).strict();
export type RepairDiagnosis = z.infer<typeof Diagnosis>;
export const repairDiagnosisFormat = { type: 'json_schema', json_schema: { name: 'guided_failure_diagnosis', strict: true, schema: z.toJSONSchema(Diagnosis) } };

export interface ObservedTestFailure { name: string; actual: string | null; expected: string | null; input: null; evidence: string }
/** Evidence permits a bounded implementation attempt, never changes the test oracle. */
export function evidenceRepairTargets(output: string, allowed: readonly string[]): string[] {
  const implementation = allowed.filter(file => !isTestPath(file));
  const clean = output.replace(/\u001b\[[0-9;]*m/gu, '').replace(/\\/gu, '/');
  const diagnostics = [...clean.matchAll(/^(.+?)\((\d+),(\d+)\):\s*error TS\d+:/gmu)].map(match => match[1]!.trim());
  if (diagnostics.length) {
    // Never infer an editable file from a basename or a diagnostic outside the scope.
    if (diagnostics.some(path => !implementation.includes(path))) return [];
    return [...new Set(diagnostics)];
  }
  return observedTestFailures(output).length > 0 ? implementation : [];
}
/** Extract only values actually printed by the runner; absent input stays unknown. */
export function observedTestFailures(output: string): ObservedTestFailure[] {
  const clean = output.replace(/\u001b\[[0-9;]*m/gu, '');
  const failures: ObservedTestFailure[] = [];
  const blocks = clean.split(/(?=^\s*(?:✖|not ok\s+\d+))/mu);
  for (const block of blocks) {
    const header = /^\s*(?:✖\s+|not ok\s+\d+\s*-?\s*)([^\n]+)/u.exec(block);
    if (!header || /^failing tests:?$/iu.test(header[1]!.trim())) continue;
    const actual = /^\s*actual:\s*(.+)$/mu.exec(block)?.[1]?.trim() ?? /actual ([^\n]+?), expected /u.exec(block)?.[1] ?? null;
    const expected = /^\s*expected:\s*(.+)$/mu.exec(block)?.[1]?.trim() ?? /actual [^\n]+?, expected ([^\n]+)/u.exec(block)?.[1] ?? null;
    if (actual === null && expected === null) continue;
    failures.push({ name: header[1]!.trim(), actual, expected, input: null, evidence: block.trim().slice(0, 2500) });
    if (failures.length === 8) break;
  }
  return failures;
}

export function groundedRepairFeedback(diagnosis: RepairDiagnosis, requests: readonly string[], targets: readonly string[], output: string): string {
  const source = diagnosis.source;
  const quote = source ? requests[source.request - 1]!.split('\n').slice(source.lines[0] - 1, source.lines[1]).join('\n') : null;
  return JSON.stringify({ advisoryDiagnosis: diagnosis.kind, reason: diagnosis.reason,
    originalPredicate: source ? { ...source, quote } : null, observedFailure: diagnosis.observedFailure,
    observedTestFailures: observedTestFailures(output), repairTargets: targets,
    instruction: 'Сохрани исходный контракт. Значения actual/expected — наблюдения теста, expected ещё нужно сверить с исходным предикатом. Не придумывай вход: если он не известен, прочитай соответствующий тест.' });
}

/** Grounded advisory diagnosis, never an authority to weaken the original contract. */
export function parseRepairDiagnosis(answer: string, output: string, requests: readonly string[]): RepairDiagnosis {
  const value = Diagnosis.parse(parseGuidedJson(answer));
  if (!output.includes(value.observedFailure)) throw new Error('Диагноз не адресует фактический отказ проверки');
  if (value.kind !== 'unknown' && value.source === null) throw new Error('Для выбора ремонта нужно основание в исходном запросе');
  if (value.source !== null) {
    const text = requests[value.source.request - 1];
    const [start, end] = value.source.lines;
    if (text === undefined || start > end || end > text.split('\n').length || !text.split('\n').slice(start - 1, end).join('\n').trim()) throw new Error('Основание диагноза вне исходного запроса');
  }
  return value;
}

export function repairDiagnosisTargets(diagnosis: RepairDiagnosis, allowed: readonly string[], ownedNewTests: readonly string[]): string[] {
  if (diagnosis.kind === 'unknown') return [];
  const tests = new Set(ownedNewTests);
  // Existing tests and arbitrary files cannot become repair targets by a model declaration.
  return allowed.filter(file => diagnosis.kind === 'test-expectation' ? tests.has(file) : !/(?:^|\/)tests?\/|\.(?:test|spec)\./iu.test(file));
}
