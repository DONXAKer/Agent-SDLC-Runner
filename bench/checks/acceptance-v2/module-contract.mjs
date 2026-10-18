import { strictEqual } from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function assertFunction(file, symbol) {
  const mod = await import(pathToFileURL(join(resolve(process.env.BENCH_TARGET_DIR), file)).href);
  strictEqual(typeof mod[symbol], 'function', `${symbol} must be exported by ${file}`);
}
