import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Shared by the simulator and launch gate: no second, divergent fingerprint. */
export function simulationSourceHash(repository: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Redirected simulator source: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (/\.(ts|mjs|json|md)$/.test(name)) hash.update(relative(repository, path)).update('\0').update(readFileSync(path)).update('\0');
    }
  };
  for (const folder of ['server/src', 'server/methodology', 'shared/src', 'bench/src', 'server/test/fixtures/guided-v4', 'bench/fixtures/guided-process']) walk(join(repository, folder));
  hash.update(readFileSync(join(repository, 'package.json')));
  hash.update(readFileSync(join(repository, 'package-lock.json')));
  return hash.digest('hex');
}
