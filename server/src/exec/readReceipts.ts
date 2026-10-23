import { createHash } from 'node:crypto';
import { posix } from 'node:path';

export interface ReadReceipt { path: string; hash: string; from: number; to: number; complete: boolean }
export const sourceHash = (text: string): string => createHash('sha256').update(text).digest('hex');
export class RepeatedReadError extends Error {}
const pathKey = (path: string): string => { const value = posix.normalize(path.replace(/\\/gu, '/')); return process.platform === 'win32' ? value.toLowerCase() : value; };

/** Records only text actually shown to a model. Hash changes invalidate old coverage. */
export class ReadReceipts {
  private receipts: ReadReceipt[] = [];
  private repeats = new Map<string, number>();
  add(path: string, text: string, from = 1, to = text.split('\n').length): ReadReceipt {
    path = pathKey(path);
    const hash = sourceHash(text), lines = text.split('\n').length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || from > lines) throw new RangeError('Invalid source range');
    const receipt = { path, hash, from, to: Math.min(to, lines), complete: from === 1 && to >= lines };
    this.receipts = this.receipts.filter(r => r.path !== path || r.hash === hash);
    const ranges = [...this.receipts.filter(r => r.path === path), receipt].sort((a,b) => a.from-b.from);
    const merged: ReadReceipt[] = [];
    for (const row of ranges) {
      const previous = merged.at(-1);
      if (previous && row.from <= previous.to + 1) { previous.to = Math.max(previous.to,row.to); previous.complete = previous.from === 1 && previous.to === lines; }
      else merged.push({...row});
    }
    this.receipts = [...this.receipts.filter(r=>r.path!==path), ...merged];
    return receipt;
  }
  covered(path: string, text: string, from = 1, to = text.split('\n').length): boolean {
    path = pathKey(path);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to || to > text.split('\n').length) return false;
    const ranges = this.receipts.filter(r => r.path === path && r.hash === sourceHash(text)).sort((a,b) => a.from-b.from);
    let cursor = from;
    for (const r of ranges) { if (r.from > cursor) break; if (r.to >= cursor) cursor = r.to + 1; }
    return cursor > Math.min(to, text.split('\n').length);
  }
  duplicate(path: string, text: string, from = 1, to = text.split('\n').length): boolean {
    path = pathKey(path);
    if (!this.covered(path,text,from,to)) return false;
    const key = JSON.stringify([path,sourceHash(text),from,to]);
    const count = (this.repeats.get(key) ?? 0) + 1; this.repeats.set(key,count);
    if (count >= 4) throw new RepeatedReadError(`Четыре запроса одного диапазона без прогресса: ${path}:${from}-${to}; источник повторно предоставлен. Требуется решение по источнику или другой диапазон.`);
    return true;
  }
  all(): ReadReceipt[] { return this.receipts.map(r=>({...r})); }
}
