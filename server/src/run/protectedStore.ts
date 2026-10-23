import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function runtimeStateDir(): string {
  return process.env['SDLC_STATE_DIR'] || join(homedir(), '.sdlc-runner');
}

export function canonicalRoot(root: string): string {
  const value = resolve(root).replace(/\\/g, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function protectedRunDir(root: string, slug: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug === '..') throw new Error('Недопустимый slug');
  const dir = resolve(runtimeStateDir(), 'contracts', sha256(canonicalRoot(root)), slug);
  const rel = relative(resolve(root), dir);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))) throw new Error('SDLC_STATE_DIR должен находиться вне проекта');
  return dir;
}

/** Refuse symlinked parents and destinations before touching runtime-owned files. */
export function assertPlainPath(file: string): void {
  let current = resolve(file);
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Симлинк в защищённом пути: ${current}`);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function atomicJson(file: string, value: unknown): void {
  assertPlainPath(file);
  writeAtomicJson(file, value);
}

export function evidenceFile(root: string, file: string): string {
  if (!file || isAbsolute(file) || /^[A-Za-z]:[\\/]|^\\\\/.test(file)) throw new Error(`Нужен относительный путь свидетельства: ${file}`);
  const base = realpathSync(root);
  const target = realpathSync(resolve(base, file));
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== target) throw new Error(`Свидетельство вне корня: ${file}`);
  return target;
}

export const fileHash = (file: string): string => sha256(readFileSync(file));
import { atomicJson as writeAtomicJson } from '../fs/atomicJson.ts';
