import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableDigest } from '../bench/src/harnessComparison.ts';

export interface ComparisonManifest {
  inputs: Record<string, string>; common: Record<string, string>; profiles: readonly { id: string }[];
  acceptanceImage: string; nodeVersion: string; coordinatorHash: string;
  modelDigests?: Record<string, string>; engineVersion?: unknown;
  spec: { engine: unknown; guidedEngineVersion?: number; limits?: { stageMinutes: number; runMinutes: number; attempts: number } };
}
export function assertFollowupConditions(control: ComparisonManifest, next: ComparisonManifest): void {
  for (const field of ['inputs', 'acceptanceImage', 'nodeVersion', 'coordinatorHash', 'engineVersion'] as const)
    if (stableDigest(control[field]) !== stableDigest(next[field])) throw new Error(`Control condition changed: ${field}`);
  if (control.engineVersion === undefined) throw new Error('Control has no engine pin');
  if (stableDigest(control.spec.engine) !== stableDigest(next.spec.engine)) throw new Error('Engine configuration changed');
  if (control.spec.guidedEngineVersion !== next.spec.guidedEngineVersion) throw new Error('Guided protocol changed');
  for (const field of ['stageMinutes', 'runMinutes', 'attempts'] as const)
    if (control.spec.limits?.[field] !== next.spec.limits?.[field]) throw new Error(`Per-task budget changed: ${field}`);
  for (const profile of control.profiles) {
    if (stableDigest(profile) !== stableDigest(next.profiles.find(p => p.id === profile.id))) throw new Error(`Control profile changed: ${profile.id}`);
    const digest = control.modelDigests?.[profile.id];
    if (!digest || next.modelDigests?.[profile.id] !== digest) throw new Error(`Control model pin changed: ${profile.id}`);
  }
  const common = (m: ComparisonManifest) => Object.fromEntries(Object.entries(m.common)
    .filter(([path]) => !['config/runner.local.json', 'config/models.json'].includes(path)));
  if (stableDigest(common(control)) !== stableDigest(common(next))) throw new Error('Frozen common environment changed');
}
export function assertEnvironmentConfiguration(referenceDir: string, candidateDir: string, profiles: readonly { id: string }[]): void {
  const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, 'common/config', name), 'utf8'));
  const normalizedRunner = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['methodologyDir', 'skillsDir', 'agentsDir'].includes(key)));
  if (stableDigest(normalizedRunner(read(referenceDir, 'runner.local.json'))) !== stableDigest(normalizedRunner(read(candidateDir, 'runner.local.json'))))
    throw new Error('Runner configuration changed');
  const reference = read(referenceDir, 'models.json'), candidate = read(candidateDir, 'models.json');
  const expected = { ...reference, models: [...reference.models.filter((p: { id: string }) => !profiles.some(next => p.id === next.id)), ...profiles] };
  if (stableDigest(expected) !== stableDigest(candidate)) throw new Error('Model catalog or provider configuration changed');
}
export function assertSimulatorReport(report: { passed: boolean; sourceHash: string; kind: string; node: string; cases: readonly { id: string; passed: boolean; errors: readonly unknown[]; checks: readonly unknown[] }[] },
  currentHash: string, expectedIds: readonly string[]): void {
  if (report.kind !== 'deterministic-runtime-simulation' || !report.passed || report.sourceHash !== currentHash || report.node !== process.version)
    throw new Error('Simulator report failed or belongs to different sources');
  const ids = new Set(report.cases.map(c => c.id));
  if (ids.size !== expectedIds.length || report.cases.length !== expectedIds.length || expectedIds.some(id => !ids.has(id)) ||
      report.cases.some(c => !c.passed || c.errors.length || !c.checks.length)) throw new Error('Simulator scenario coverage is incomplete');
}
