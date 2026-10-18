import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { WitokPaths } from '../artifacts/paths.ts';
import { preparation, seedAcceptanceFromRequests } from '../artifacts/preparation.ts';
import { readTree } from '../explore/tree.ts';
import { guardedPath } from '../exec/GuidedExecutor.ts';
import { namedExportsOf } from '../exec/tools/index.ts';
import { progressHash } from './guidedProgress.ts';
import { readGuided } from './guidedState.ts';
import { preservationConstraint } from './preservationConstraint.ts';

const Baseline = z.object({ version: z.literal(1), complete: z.boolean(), files: z.array(z.object({
  path: z.string(), kind: z.string(), hash: z.string(), exports: z.array(z.string()),
})) });
type Baseline = z.infer<typeof Baseline>;
export type InvariantCheck = { claim: string; kind: 'unchanged-files' | 'preserved-exports'; files: string[]; coversClaim: boolean };
const location = (paths: WitokPaths) => join(paths.dir, '.runner', 'invariant-baseline.json');

/** Static named exports only. Comments and string literals cannot preserve a removed export. */
export function invariantExports(source: string): Set<string> {
  const code = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, match => ' '.repeat(match.length));
  const names = namedExportsOf(code.replace(/\bexport\s+type\s*\{/gu, 'export {').replace(/\bexport\s+async\s+function\b/gu, 'export function'));
  for (const match of code.matchAll(/\bexport\s+(?:let|var)\s+(\w+)/gu)) names.add(match[1]!);
  if (/\bexport\s+default\b/u.test(code)) names.add('default');
  for (const match of code.matchAll(/\bexport\s+\*\s+(?:as\s+\w+\s+)?from\s*/gu)) {
    // Whitespace includes the masked module literal; take its location from the unmasked prefix.
    const prefix = /^export\s+\*\s+(?:as\s+\w+\s+)?from\s*/u.exec(source.slice(match.index));
    const module = prefix && /^['"]([^'"]+)['"]/u.exec(source.slice(match.index + prefix[0].length));
    if (module) names.add(`*from:${module[1]}`);
  }
  return names;
}

/** Created once, before Intent, never rebased on a repair or resume. */
export function captureInvariantBaseline(paths: WitokPaths, root: string): void {
  if (existsSync(location(paths))) throw new Error('Invariant baseline already exists');
  const tree = readTree(root);
  const baseline: Baseline = { version: 1, complete: tree.skipped.files === 0 && tree.skipped.bytes === 0,
    files: tree.files.filter(file => file.kind === 'code' || file.kind === 'test').map(file => ({
      path: file.path, kind: file.kind, hash: progressHash(readFileSync(guardedPath(root, file.path), 'utf8')),
      exports: [...invariantExports(file.text)],
    })) };
  mkdirSync(dirname(location(paths)), { recursive: true });
  writeFileSync(location(paths), JSON.stringify(baseline, null, 2) + '\n', { flag: 'wx' });
}

function baselineOf(paths: WitokPaths): Baseline {
  if (!existsSync(location(paths))) throw new Error('Нет исходного снимка для проверки инвариантов');
  return Baseline.parse(JSON.parse(readFileSync(location(paths), 'utf8')));
}

/** Only a narrow, source-backed no-touch requirement is assigned automatically.
 * Unknown or mixed requirements still need implementation/test steps. */
export function invariantChecks(paths: WitokPaths): InvariantCheck[] {
  if (readGuided(paths)?.engineVersion !== 4) return [];
  const baseline = baselineOf(paths);
  if (!baseline.complete || !baseline.files.length) return [];
  const state = preparation(paths);
  const requests = state?.requests ?? [];
  const seeds = seedAcceptanceFromRequests(requests);
  const exportPaths = new Set(requests.flatMap(request => request.split('\n').filter(line => /реэкспорт|re-export/iu.test(line))
    .flatMap(line => [...line.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+/giu)].map(match => match[0]))));
  const checks: InvariantCheck[] = [];
  for (const claim of state?.canonical?.requirements?.acceptance ?? []) {
    const source = seeds.find(seed => seed.id === claim.id);
    // Exact source text binding prevents a generated claim with extra obligations from being exempted.
    if (!source || claim.behavior.trim() !== source.behavior.trim()) continue;
    const constraint = preservationConstraint(source.behavior);
    if (!constraint) continue;
    const { coversClaim } = constraint;
    checks.push({ claim: claim.id, kind: 'unchanged-files', coversClaim, files: baseline.files.filter(file => !exportPaths.has(file.path)).map(file => file.path) });
    const barrels = baseline.files.filter(file => exportPaths.has(file.path));
    if (barrels.length) checks.push({ claim: claim.id, kind: 'preserved-exports', coversClaim, files: barrels.map(file => file.path) });
  }
  return checks;
}

export function invariantClaimIds(paths: WitokPaths): Set<string> {
  return new Set(invariantChecks(paths).filter(check => check.coversClaim).map(check => check.claim));
}

/** Runtime observation, not a model-authored assertion. Run again at Verify/handoff. */
export function checkInvariants(paths: WitokPaths, root: string): { passed: boolean; result: string } {
  const checks = invariantChecks(paths);
  if (!checks.length) return { passed: true, result: 'Нет назначенных инвариантов' };
  const baseline = baselineOf(paths);
  const failures: string[] = [];
  for (const check of checks) for (const path of check.files) {
    const before = baseline.files.find(file => file.path === path)!;
    const absolute = guardedPath(root, path);
    const current = existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
    if (current === null || (check.kind === 'unchanged-files' ? progressHash(current) !== before.hash :
      before.exports.some(name => !invariantExports(current).has(name)))) failures.push(`${check.claim}: ${check.kind}: ${path}`);
  }
  return { passed: failures.length === 0, result: failures.length ? `Нарушены инварианты:\n${failures.join('\n')}` :
    `Проверены инварианты: ${checks.map(check => `${check.claim}/${check.kind} (${check.files.length})`).join(', ')}` };
}
