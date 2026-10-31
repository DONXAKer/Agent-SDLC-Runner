import { z } from 'zod';
import { stripTypeScriptTypes } from 'node:module';
import { digest, type Snapshot } from '../run/guidedState.ts';
import { applySymbolOp, declarationId, findSymbols, type SymbolOp } from './symbolOps.ts';

export type EditRepresentation = 'typed-ir' | 'whole-file';

export interface WholeFileTarget {
  path: string;
  before: string | null;
  expectedHash: string;
}

export const wholeFileReplySchema = z.object({
  content: z.string(),
  prediction: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1).max(40),
}).strict();

export const wholeFileResponseFormat = {
  type: 'json_schema',
  json_schema: {
    name: 'whole_file_proposal', strict: true,
    schema: {
      type: 'object', additionalProperties: false,
      properties: {
        content: { type: 'string' },
        prediction: { type: 'string', minLength: 1 },
        evidenceIds: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 40 },
      },
      required: ['content', 'prediction', 'evidenceIds'],
    },
  },
} as const;

const sourceHash = (text: string | null): string => text === null ? 'missing' : digest(text);

/** Pure proposal preparation: callers must authorize paths and validate the entire
 * group (including semantic scope and evidence) before writing any snapshot. */
export function prepareWholeFileProposal(target: WholeFileTarget, candidate: unknown,
  current: string | null, finishReason?: string): { snapshot: Snapshot; prediction: string; evidenceIds: string[] } {
  if (finishReason === 'max_tokens' || finishReason === 'length') throw new Error('Whole-file response truncated');
  if (sourceHash(target.before) !== target.expectedHash || sourceHash(current) !== target.expectedHash)
    throw new Error('Whole-file source changed since capture');
  const reply = wholeFileReplySchema.parse(candidate);
  if (target.before?.includes('\0') || reply.content.includes('\0')) throw new Error('Binary content is unsupported');
  if (!/\.(?:ts|mts|cts)$/iu.test(target.path)) throw new Error('Whole-file target type is unsupported');
  try { stripTypeScriptTypes(reply.content, { mode: 'transform', sourceUrl: target.path }); }
  catch (error) { throw new Error(`Whole-file TypeScript syntax invalid: ${(error as Error).message}`); }
  return {
    snapshot: { path: target.path, before: target.before, after: reply.content },
    prediction: reply.prediction, evidenceIds: reply.evidenceIds,
  };
}

/** Prepare a group without side effects. Any invalid member rejects the whole group. */
export function prepareWholeFileGroup(entries: readonly {
  target: WholeFileTarget;
  candidate: unknown;
  current: string | null;
  finishReason?: string;
}[], allowedPaths: readonly string[]): ReturnType<typeof prepareWholeFileProposal>[] {
  const allowed = new Set(allowedPaths);
  const seen = new Set<string>();
  return entries.map(entry => {
    if (!allowed.has(entry.target.path)) throw new Error('Whole-file target outside authorized group');
    if (seen.has(entry.target.path)) throw new Error('Duplicate whole-file target');
    seen.add(entry.target.path);
    return prepareWholeFileProposal(entry.target, entry.candidate, entry.current, entry.finishReason);
  });
}

/** Compile a full-file response to a guarded existing operation only when its
 * exact effect can be represented by one authorized symbol operation. */
export function compileWholeFileOperation(snapshot: Snapshot, allowedOps: readonly string[], symbol?: string): SymbolOp {
  if (snapshot.before === null) {
    if (!allowedOps.includes('create_file')) throw new Error('File creation is not authorized');
    // create_file канонизирует EOL (`\r\n`→`\n`, trimEnd + `\n`). Пилот r10: сверка
    // `apply === after` роняла каждое создание с CRLF или без завершающего перевода строки
    // («Creation would alter proposed bytes»), хотя на диске ушёл бы канонический вид.
    // Принимаем предложение; запись идёт через applySymbolOp и получает тот же канон.
    const op: SymbolOp = { op: 'create_file', file: snapshot.path, body: snapshot.after };
    applySymbolOp(null, op); // проверка контракта create_file (не пустое / не существующий файл)
    return op;
  }
  const before = snapshot.before;
  const candidates: SymbolOp[] = [];
  for (const original of findSymbols(before)) {
    if (symbol && original.qualified !== symbol) continue;
    const proposed = findSymbols(snapshot.after).filter(item => item.qualified === original.qualified && item.kind === original.kind);
    for (const item of proposed) {
      if (allowedOps.includes('replace_declaration')) candidates.push({ op: 'replace_declaration', file: snapshot.path,
        symbol: original.qualified, expectedHash: digest(before), targetId: declarationId(before, original),
        declaration: snapshot.after.slice(item.start, item.end) });
      if (allowedOps.includes('replace_function_body') && item.bodyStart !== null && item.bodyEnd !== null)
        candidates.push({ op: 'replace_function_body', file: snapshot.path, symbol: original.qualified,
          expectedHash: digest(before), targetId: declarationId(before, original), body: snapshot.after.slice(item.bodyStart, item.bodyEnd) });
    }
  }
  // Пилот r11: barrel index.ts с одним новым `export { name } from '…'` — capabilities
  // дают только ensure_reexport, а компилятор whole-file раньше смотрел лишь replace_*.
  if (allowedOps.includes('ensure_reexport')) {
    const reexportRe = /^[ \t]*export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gmu;
    for (const match of snapshot.after.matchAll(reexportRe)) {
      const names = match[1]!.split(',').map(name => name.trim()).filter(Boolean);
      if (names.length === 0) continue;
      candidates.push({ op: 'ensure_reexport', file: snapshot.path, from: match[2]!, names });
    }
  }
  if (allowedOps.includes('ensure_import')) {
    const importRe = /^[ \t]*import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gmu;
    for (const match of snapshot.after.matchAll(importRe)) {
      const names = match[1]!.split(',').map(name => name.trim()).filter(Boolean);
      if (names.length === 0) continue;
      candidates.push({ op: 'ensure_import', file: snapshot.path, from: match[2]!, names });
    }
  }
  const collapseBlankRuns = (text: string): string =>
    text.replace(/\r\n/gu, '\n').replace(/[ \t]+$/gmu, '').replace(/\n{2,}/gu, '\n').trimEnd() + '\n';
  const valid = candidates.filter(op => {
    try {
      const applied = applySymbolOp(before, op, before);
      if (applied === snapshot.after) return true;
      // ensure_*: модель часто вставляет пустую строку вокруг экспорта — канон ensure*
      // без неё; по смыслу это тот же реэкспорт (r11 index.ts + validateCustomer).
      if (op.op === 'ensure_reexport' || op.op === 'ensure_import')
        return collapseBlankRuns(applied) === collapseBlankRuns(snapshot.after);
      return false;
    } catch { return false; }
  });
  if (valid.length === 0)
    throw new Error('Whole-file change cannot be represented by one unambiguous authorized operation');
  const keys = new Set(valid.map(op => {
    if (op.op === 'ensure_reexport' || op.op === 'ensure_import') return `${op.op}:${op.from}:${op.names.join(',')}`;
    return 'symbol' in op ? op.symbol : op.op;
  }));
  if (keys.size !== 1) throw new Error('Whole-file change cannot be represented by one unambiguous authorized operation');
  return valid[0]!;
}
