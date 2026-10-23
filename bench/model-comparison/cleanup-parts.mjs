import { existsSync, readFileSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

// Remove only disposable numeric range blocks after the assembled file was verified.
const root = resolve('.tmp/model-comparison-20261019');
const manifest = JSON.parse(readFileSync(join(root, 'preparation.json'), 'utf8'));
let count = 0;
for (const model of manifest.models) for (const file of model.files ?? []) {
  if (!file.downloaded || !file.actualSha256 || file.sha256 && file.actualSha256 !== file.sha256) continue;
  const directory = resolve(model.directory, `${file.name}.parts`);
  const within = relative(root, directory);
  if (within.startsWith('..') || resolve(root, within) !== directory) throw new Error('Range cache outside experiment');
  if (!existsSync(directory)) continue;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^\d+$/.test(entry.name)) throw new Error('Unexpected range cache entry');
    unlinkSync(join(directory, entry.name)); count++;
  }
  rmdirSync(directory);
}
console.log(`Removed ${count} verified disposable range blocks`);
