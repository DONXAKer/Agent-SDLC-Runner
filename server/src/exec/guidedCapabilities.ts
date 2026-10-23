import type { GuidedFileCard } from './GuidedExecutor.ts';
import type { WorkingTask } from './guidedWorkingContext.ts';
import type { SymbolOp } from './symbolOps.ts';
import { isTextDocument } from './symbolOps.ts';

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

export function validateGuidedCapabilities(ops: readonly SymbolOp[], capabilities: readonly GuidedCapability[]): void {
  for (const file of new Set(ops.map(op => op.file))) {
    const writes = ops.filter(op => op.file === file);
    if (writes.some(op => op.op === 'create_file') && writes.length !== 1)
      throw new Error(`Полная запись ${file} должна быть единственной операцией над этим файлом в ответе`);
  }
  for (const op of ops) {
    const capability = capabilities.find(value => value.file === op.file);
    if (!capability || !capability.ops.includes(op.op)) throw new Error(`Операция ${op.op} не разрешена текущим шагом для ${op.file}`);
    if (capability.symbol && 'symbol' in op && op.symbol !== capability.symbol) throw new Error(`Символ операции закреплён как ${capability.symbol}`);
  }
}
