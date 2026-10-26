import type { SimulationCaseResult } from './taskLoop.ts';

export type Suite = 'task-loop' | 'guided' | 'full-flow' | 'guided-v4-full-flow' | 'guided-v5-full-flow' | 'state-first';
export type SimulationOutcomeKind = 'component-expectation' | 'full-flow-expectation';
export interface SimulationReport {
  version: 1;
  kind: 'deterministic-runtime-simulation';
  evidenceLevel: 'simulated-protocol';
  liveModelQuality: 'not-evaluated';
  startedAt: string;
  finishedAt: string;
  revision: string;
  dirty: boolean;
  sourceHash: string;
  node: string;
  suites: Suite[];
  passed: boolean;
  cases: (Omit<SimulationCaseResult, 'trace'> & { suite: Suite; outcomeKind: SimulationOutcomeKind; traceFile: string })[];
}

export function simulationOutcomeKind(suite: Suite): SimulationOutcomeKind {
  return suite === 'task-loop' || suite === 'guided' ? 'component-expectation' : 'full-flow-expectation';
}

/** PASS относится к ожиданию сценария, включая законную остановку, а не к приёмке продукта. */
export function reportPassed(cases: readonly Pick<SimulationCaseResult, 'passed' | 'errors' | 'checks'>[]): boolean {
  return cases.length > 0 && cases.every(c => c.passed && c.errors.length === 0 && c.checks.length > 0);
}

export function renderReport(report: SimulationReport): string {
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
  return [
    '# Испытание процесса без модели', '',
    `Результат: **${report.passed ? 'PASS' : 'FAIL'}**; сценариев: ${report.cases.length}.`, '',
    'PASS означает соответствие ожидаемому поведению. ready_for_review не означает человеческую приёмку.',
    `Машинный уровень доказательства: \`${report.evidenceLevel}\`; качество живой модели: \`${report.liveModelQuality}\`.`,
    'TaskLoop — отдельный исполнитель; guided — компоненты; full-flow — legacy v1; guided-v4-full-flow — полный Guided v4 с preparation v3 и независимой Docker-приёмкой.',
    'Симулятор не измеряет качество, скорость или VRAM реальной модели и не доказывает поддержку всех языков.', '',
    `Runner: \`${report.revision}\`${report.dirty ? ' + незакоммиченные изменения' : ''}; Node: ${report.node}.`,
    `SHA-256 исходников и сценариев: \`${report.sourceHash}\`.`,
    `Начало: ${report.startedAt}; конец: ${report.finishedAt}.`, '',
    '| Контур | Вид ожидания | Сценарий | Ожидание | Наблюдение | Итог |', '|---|---|---|---|---|---|',
    ...report.cases.map(c => `| ${c.suite} | ${c.outcomeKind} | [${c.id}](${c.traceFile}) | ${cell(c.expected)} | ${cell(c.actual)} | ${c.passed ? 'PASS' : 'FAIL'} |`), '',
    ...report.cases.filter(c => !c.passed).flatMap(c => [
      `## ${c.id}`, '', `Первое нарушение: ${c.errors[0] ?? 'Не выполнено ни одной проверки'}`, '',
      ...c.errors.slice(1).map(error => `- ${error}`), '',
    ]),
    'Отложенные задачи и реальные модельные серии запускаются отдельно. Исправление ожидания ради зелёного результата запрещено.', '',
  ].join('\n');
}
