import { lastLoopSectionStart } from '../artifacts/artifact.ts';
import { escapeCell, h2SectionRanges } from '../md/table.ts';
import type { ClaimRecord } from './verifyReport.ts';

/** Facts already decided by Verify are copied exactly; human acceptance is untouched. */
export function autofillGuidedHandoff(text: string, facts: {
  loop: number; attempt: number;
  gates: readonly { name: string; status: string }[];
  claims: readonly ClaimRecord[];
  reviewHistory?: readonly { path: string; findings: readonly string[] }[];
}): string {
  const start = lastLoopSectionStart(text);
  const prefix = text.slice(0, start);
  let current = text.slice(start);
  const ids = (status: string): string => facts.claims.filter(c => c.status === status).map(c => c.id).join(', ') || 'ни одного';
  current = current.replace(/^- \*\*Предыдущая передача по этой задаче:\*\*[^\r\n]*/mu,
    `- **Предыдущая передача по этой задаче:** ${facts.loop <= 1 ? 'нет — это первый виток' : `handoff.md, секция витка ${facts.loop - 1}`}`);
  current = current.replace(/^- Пункты в `❌`:[^\r\n]*/mu, `- Пункты в \`❌\`: ${ids('❌')} · Пункты в \`⚠\`: ${ids('⚠')}`);
  current = current.replace(/^- \*\*Пункты[^\r\n]*manual[\s\S]*?\):[^\r\n]*/mu,
    `- **Пункты \`[manual]\` — открытая ручная проверка** (не проверялись этим этапом, не роняли \`passed\`): ${ids('manual')}`);
  current = current.replace(/^- Возвратов на этом chunk'е:[^\r\n]*/mu,
    `- Возвратов на этом chunk'е: ${Math.max(0, facts.attempt - 1)} _(по номеру попытки текущего chunk)_`);
  const byDiff = facts.claims.filter(c => c.status === '✅' && !/(?:test[/.]|tests?\b|тест)/iu.test(c.evidence)).map(c => c.id);
  current = current.replace(/^- Пункты, закрытые не тестом, а diff'ом:[^\r\n]*/mu,
    `- Пункты, закрытые не тестом, а diff'ом: ${byDiff.join(', ') || 'ни один'} _(по свидетельствам §1 отчёта приёмки)_`);
  const readiness = h2SectionRanges(current, /^Готовность$/u)[0];
  if (readiness) {
    const section = current.slice(readiness.start, readiness.end);
    const table = ['| Гейт | Статус |', '|---|---|',
      ...facts.gates.map(g => `| ${escapeCell(g.name)} | ${g.status} |`), ''].join('\n');
    const corrected = section.replace(/^\| Гейт \| Статус \|\r?\n\|[^\r\n]*\r?\n(?:\|[^\r\n]*\r?\n)*/mu, () => table);
    current = current.slice(0, readiness.start) + corrected + current.slice(readiness.end);
  }
  const record = h2SectionRanges(current, /^Запись о проскочившем дефекте$/u)[0];
  if (record && facts.reviewHistory !== undefined) {
    const old = current.slice(record.start, record.end);
    const signed = /^- \*\*Кто утвердил:\*\*\s*(?!н\/п|‹|_|\*\*\(не утверждено)[\p{L}]/mu.test(old);
    const uncovered = facts.reviewHistory.some(r => r.findings.some(f => /поведение[^\n]*не покрыт|uncovered behavior/iu.test(f)));
    if (!signed && !uncovered) {
      const rows = facts.reviewHistory.flatMap(r => r.findings.map(f => `- ${r.path}: ${f.replace(/\s+/gu, ' ')}`));
      const replacement = ['## Запись о проскочившем дефекте', '',
        'Подтверждённая запись о проскочившем дефекте в данных этого запуска не зарегистрирована.',
        'Классификация и действие человека не назначались рантаймом.', '',
        '### Замечания Verify, пойманные до итоговой приёмки', '',
        ...(rows.length ? rows : ['Рецензент не зарегистрировал замечаний в сохранённых ответах Verify.']), '',].join('\n');
      current = current.slice(0, record.start) + replacement + current.slice(record.end);
      current = current.replace(/^- Записи о дефектах на этом витке:[^\r\n]*/mu,
        '- Записи о дефектах на этом витке: подтверждённые проскочившие не зарегистрированы; история Verify ниже');
    }
  }
  return prefix + current;
}
