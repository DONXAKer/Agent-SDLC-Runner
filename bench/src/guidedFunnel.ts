export interface GuidedFunnelCell {
  status: string;
  outcome?: {
    success: boolean;
    reached?: { stage: string; ok: boolean; skipped: boolean }[];
    firstMutation?: unknown;
  };
  evidence?: { verifyReached?: boolean };
}

export interface GuidedFunnel {
  started: number;
  intent: number;
  ask: number;
  plan: number;
  firstMutation: number;
  verify: number;
  acceptance: number;
}

export function guidedFunnel(cells: readonly GuidedFunnelCell[]): GuidedFunnel {
  const complete = cells.filter(cell => cell.status === 'complete');
  const passed = (cell: GuidedFunnelCell, stage: string): boolean =>
    cell.outcome?.reached?.some(item => item.stage === stage && (item.ok || item.skipped)) ?? false;
  return {
    started: complete.length,
    intent: complete.filter(cell => passed(cell, 'intent')).length,
    ask: complete.filter(cell => passed(cell, 'ask')).length,
    plan: complete.filter(cell => passed(cell, 'plan')).length,
    firstMutation: complete.filter(cell => Boolean(cell.outcome?.firstMutation)).length,
    verify: complete.filter(cell => cell.evidence?.verifyReached === true).length,
    acceptance: complete.filter(cell => cell.outcome?.success === true).length,
  };
}

export function renderGuidedFunnel(funnel: GuidedFunnel): string {
  return [
    '## Воронка завершённых ячеек',
    '',
    '| Переход | Ячеек |',
    '|---|---:|',
    `| Запущено | ${funnel.started} |`,
    `| Intent пройден | ${funnel.intent} |`,
    `| Ask пройден или пропущен | ${funnel.ask} |`,
    `| Plan пройден | ${funnel.plan} |`,
    `| Есть фактическая правка | ${funnel.firstMutation} |`,
    `| Запущен Verify | ${funnel.verify} |`,
    `| Приёмка пройдена | ${funnel.acceptance} |`,
    '',
    'Считаются только завершённые ячейки; пропуск Ask засчитывается как успешный переход. Остановка до Verify не считается проверкой Verify.',
  ].join('\n');
}
