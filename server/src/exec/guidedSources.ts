import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { relativizeWithin, resolveUserPath } from '../policy/paths.ts';

export interface GuidedSource {
  id: string;
  kind: 'inline-request' | 'inline-data' | 'file' | 'directory' | 'planned-file';
  available: boolean;
  action: 'input' | 'read' | null;
}

/** Только имена, не содержимое. Каждое чтение всё равно проходит гейт инструмента. */
export async function projectSourceCatalog(root: string, signal: AbortSignal,
  planned: readonly string[] = [], permitted: (path: string) => boolean = () => true): Promise<{ entries: GuidedSource[]; partial: boolean }> {
  const entries: GuidedSource[] = [];
  const skip = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', 'venv', '__pycache__']);
  let visited = 0; let partial = false;
  const walk = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > 8) { partial = true; return; }
    let children;
    try { children = await readdir(join(root, path), { withFileTypes: true }); }
    catch { partial = true; return; }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      signal.throwIfAborted();
      if (++visited > 512 || entries.length >= 160) { partial = true; return; }
      if (child.name.startsWith('.') || skip.has(child.name) || child.isSymbolicLink()) continue;
      if (!child.isFile() && !child.isDirectory()) continue;
      const id = path ? `${path}/${child.name}` : child.name;
      if (!permitted(id)) continue;
      entries.push({ id, kind: child.isDirectory() ? 'directory' : 'file', available: true, action: 'read' });
      if (child.isDirectory()) await walk(id, depth + 1);
    }
  };
  await walk('', 0);
  for (const id of planned.slice(0, 80)) {
    signal.throwIfAborted();
    if (entries.some(entry => entry.id === id)) continue;
    if (!permitted(id)) continue;
    const relative = relativizeWithin(root, resolveUserPath(root, id));
    if (relative === null || !relative) continue;
    let existing: 'file' | 'directory' | null = null;
    let missing = false; let safe = true; let current = root;
    for (const part of relative.split('/')) {
      signal.throwIfAborted(); current = join(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink()) { safe = false; break; }
        existing = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing = true;
        else { safe = false; partial = true; }
        break;
      }
    }
    if (!safe) continue;
    if (missing) entries.push({ id, kind: 'planned-file', available: false, action: null });
    else if (existing) entries.push({ id, kind: existing, available: true, action: 'read' });
  }
  return { entries, partial };
}
