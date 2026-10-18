/** Caller-owned requirements and check bindings. Model claims are never evidence. */
export interface TaskRequirement {
  id: string;
  description: string;
  source: string;
  checks: readonly string[];
}
export interface CheckEvidence {
  name: string; baseline: boolean; revision: string; passed: boolean; output: string;
}
export function requirementEvidence(requirements: readonly TaskRequirement[], checks: readonly CheckEvidence[], revision: string) {
  return requirements.map(requirement => {
    const evidence = requirement.checks.map(name => checks.findLast(c => c.name === name && !c.baseline && c.revision === revision));
    const status = evidence.some(c => c && !c.passed) ? 'violated'
      : evidence.length > 0 && evidence.every(c => c?.passed) ? 'verified' : 'unverified';
    return { ...requirement, status, revision, evidence: evidence.filter(c => c !== undefined) };
  });
}
export function validateRequirements(requirements: readonly TaskRequirement[], checkNames: readonly string[]): void {
  if (new Set(requirements.map(r => r.id)).size !== requirements.length) throw new Error('Unique requirement ids required');
  for (const requirement of requirements) {
    if (!requirement.id.trim() || !requirement.description.trim() || !requirement.source.trim()
      || requirement.checks.some(name => !checkNames.includes(name)) || new Set(requirement.checks).size !== requirement.checks.length)
      throw new Error('Requirements need an id, description, source and unique registered check bindings');
  }
}
