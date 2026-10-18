function bounded(text: string, maxBytes: number): string {
  const limit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const marker = '\n…[контекст плана сокращён]';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (limit < markerBytes) return '';
  const prefix = Buffer.from(text, 'utf8').subarray(0, limit - markerBytes).toString('utf8');
  return prefix.replace(/�$/, '') + marker;
}

/** Keep contracts at the end of a long plan visible before spending the remainder on its prefix. */
export function stepPlanContext(plan: string, maxBytes: number): string {
  if (Buffer.byteLength(plan, 'utf8') <= maxBytes) return plan;
  const sections = plan.split(/(?=^##\s+)/m);
  const important = sections.filter((section) => /^##\s+(?:Контекст[- ]пакет|Последствия шагов|Затронутые вызовы\/сигнатуры)\s*$/m.test(section));
  if (!important.length) return bounded(plan, maxBytes);
  const priorityBudget = Math.floor(maxBytes / 2);
  const eachBudget = Math.floor(priorityBudget / important.length);
  const priority = important.map((section) => bounded(section.trim(), eachBudget)).join('\n\n');
  const rest = sections.filter((section) => !important.includes(section)).join('');
  const separator = '\n\n';
  return bounded(priority + separator + bounded(rest, Math.max(0, maxBytes - Buffer.byteLength(priority + separator, 'utf8'))), maxBytes);
}
