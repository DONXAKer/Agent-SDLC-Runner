import { openSync, closeSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './atomicJson.ts';

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; return true; }
}
export function assertProcessesExited(pids: readonly number[], alive = processAlive): void {
  for (const pid of new Set(pids)) if (alive(pid)) throw new Error(`Process may still be alive: ${pid}`);
}
export function acquireProcessLock(path: string): string {
  const token = randomUUID();
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); } finally { closeSync(fd); }
  return token;
}
export function adoptProcessLock(path: string, token: string): void {
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  if (!token || lock.token !== token) throw new Error('Process lease changed');
  atomicJson(path, { pid: process.pid, token });
}
export function releaseProcessLock(path: string, token: string): void {
  try {
    if (JSON.parse(readFileSync(path, 'utf8')).token !== token) throw new Error('Process lease changed');
    unlinkSync(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
