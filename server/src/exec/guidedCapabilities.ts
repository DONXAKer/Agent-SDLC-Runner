import type { GuidedFileCard } from './GuidedExecutor.ts';
import type { WorkingTask } from './guidedWorkingContext.ts';
import { GuidedOpError, type OpDiagnostic, type SymbolOp, isTextDocument } from './symbolOps.ts';

export interface GuidedCapability { file: string; ops: readonly string[]; symbol?: string }
const all = ['replace_body', 'insert_after', 'insert_before', 'rename', 'delete', 'create_file', 'ensure_import', 'ensure_reexport'];

/** Narrow only on an explicit planned action; an ambiguous task retains the ordinary guarded protocol. */
export function guidedCapabilities(files: readonly GuidedFileCard[], tasks: readonly WorkingTask[]): GuidedCapability[] {
  return files.map(file => {
    if (file.isNew || file.ownedNewContent !== undefined) return { file: file.path, ops: ['create_file'] };
    if (isTextDocument(file.path)) return { file: file.path, ops: ['replace_text'] };
    if (file.targets) return { file: file.path, ops: ['replace_declaration', 'replace_function_body', 'insert_before', 'insert_after', 'ensure_import', ...(file.barrel ? ['ensure_reexport'] : [])] };
    const rows = tasks.filter(task => task.file === file.path);
    const action = rows.map(task => task.action).join('\n');
    const names = [...new Set(rows.map(task => task.symbol).filter((name): name is string => typeof name === 'string' && file.symbols.includes(name)))];
    // A prose action can describe a member, parameter or branch inside this
    // declaration. Its verb never authorizes renaming/deleting the declaration.
    // The unbound protocol still supports explicit guarded symbol operations.
    if (rows.length === 1 && names.length === 1 && !file.barrel)
      return { file: file.path, ops: ['replace_body', 'ensure_import'], symbol: names[0]! };
    if (file.barrel && /реэкспорт|ре-экспорт|re-export|reexport|экспорт/iu.test(action)) return { file: file.path, ops: ['ensure_reexport'] };
    if (file.barrel) return { file: file.path, ops: ['ensure_reexport', 'ensure_import'] };
    return { file: file.path, ops: all };
  });
}

function capabilityFail(kind: Extract<OpDiagnostic['kind'], 'capability' | 'sole_write'>, message: string, file: string, op: string, symbol?: string): never {
  throw new GuidedOpError(message, { kind, op, file, ...(symbol === undefined ? {} : { symbol }), candidates: [] });
}

export function validateGuidedCapabilities(ops: readonly SymbolOp[], capabilities: readonly GuidedCapability[]): void {
  for (const file of new Set(ops.map(op => op.file))) {
    const writes = ops.filter(op => op.file === file);
    if (writes.some(op => op.op === 'create_file') && writes.length !== 1)
      capabilityFail('sole_write', `Полная запись ${file} должна быть единственной операцией над этим файлом в ответе`, file, 'create_file');
  }
  for (const op of ops) {
    const capability = capabilities.find(value => value.file === op.file);
    if (!capability || !capability.ops.includes(op.op))
      capabilityFail('capability', `Операция ${op.op} не разрешена текущим шагом для ${op.file}`, op.file, capability?.ops.includes('create_file') ? 'create_file' : op.op,
        capability?.symbol);
    if (capability.symbol && 'symbol' in op && op.symbol !== capability.symbol)
      capabilityFail('capability', `Символ операции закреплён как ${capability.symbol}`, op.file, op.op, capability.symbol);
  }
}

/**
 * Адрес ремонта, когда отказ пришёл без GuidedOpError, но целевой файл однозначен
 * (одна операция / один новый файл карточки). Иначе narrow останавливает этап.
 */
export function synthesizeAddressableDiagnostic(
  ops: readonly Pick<SymbolOp, 'op' | 'file'>[],
  files: readonly Pick<GuidedFileCard, 'path' | 'isNew'>[],
  fallbackFile?: string,
): OpDiagnostic | undefined {
  const paths = [...new Set(ops.map(op => op.file).filter(Boolean))];
  if (paths.length === 1) {
    const file = paths[0]!;
    const card = files.find(row => row.path === file);
    const create = ops.some(op => op.op === 'create_file');
    if (card?.isNew || create)
      return { kind: create && ops.length !== 1 ? 'sole_write' : 'missing_new_file', op: 'create_file', file, candidates: [] };
    return { kind: 'capability', op: ops[0]!.op, file, candidates: [] };
  }
  const fresh = files.filter(file => file.isNew);
  if (paths.length === 0 && fresh.length === 1)
    return { kind: 'missing_new_file', op: 'create_file', file: fresh[0]!.path, candidates: [] };
  if (paths.length === 0 && fallbackFile)
    return { kind: files.some(file => file.path === fallbackFile && file.isNew) ? 'missing_new_file' : 'capability',
      op: 'create_file', file: fallbackFile, candidates: [] };
  return undefined;
}
