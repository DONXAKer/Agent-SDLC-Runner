import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keep benchmark verdicts beside the benchmark, unless the operator selected another state directory. */
export function ensureBenchStateDir(): string {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  process.env['SDLC_STATE_DIR'] ||= join(root, '.tmp', 'matrix-runtime');
  return process.env['SDLC_STATE_DIR']!;
}
