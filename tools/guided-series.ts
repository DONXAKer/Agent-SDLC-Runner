export interface SeriesRun {
  model: string; task: string; version: number; repeat: number; status: string; success?: boolean;
  falseSuccess?: boolean; scopeFailure?: boolean; tokens?: number | null; minutes?: number | null;
}
const median = (values: number[]) => {
  const sorted = values.sort((a, b) => a - b);
  if (!sorted.length) return Infinity;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Predeclared holdout selection; incomplete/repeated cases cannot inflate success. */
export function selectV4HoldoutModels(runs: readonly SeriesRun[]): string[] {
  const tasks = ['add-validator', 'config-default'];
  return [...new Set(runs.map(run => run.model))].map(model => {
    const selected = runs.filter(run => run.model === model && run.version === 4 && tasks.includes(run.task));
    const eligible = tasks.every(task => {
      const samples = selected.filter(run => run.task === task);
      return samples.length === 3 && [1, 2, 3].every(repeat => samples.filter(run => run.repeat === repeat).length === 1) &&
        samples.every(run => ['success', 'failed'].includes(run.status) && !run.falseSuccess && !run.scopeFailure) &&
        samples.filter(run => run.success === true).length >= 2;
    });
    return { model, eligible, successes: selected.filter(run => run.success === true).length,
      tokens: median(selected.map(run => run.tokens ?? Infinity)), minutes: median(selected.map(run => run.minutes ?? Infinity)) };
  }).filter(value => value.eligible).sort((a, b) => b.successes - a.successes || a.tokens - b.tokens || a.minutes - b.minutes || a.model.localeCompare(b.model))
    .slice(0, 2).map(value => value.model);
}

export function seriesCases(models: readonly string[], tasks: readonly string[], versions: readonly number[], repeats: number) {
  const cases = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const [m, model] of models.entries()) for (const [t, task] of tasks.entries()) {
    for (const version of (repeat + m + t) % 2 ? versions : [...versions].reverse()) cases.push({ model, task, repeat, version });
  }
  return cases;
}
