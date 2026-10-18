import { forbiddenCodePaths } from '../artifacts/planFiles.ts';
import { intentContractSections, type IntentContractIssue } from './intentContractReview.ts';
import { progressHash, type GuidedProgress } from '../run/guidedProgress.ts';
import { parseTables } from '../md/table.ts';
import { seedAcceptanceFromRequests } from '../artifacts/preparation.ts';

/** No reviewer may waive a dropped source requirement or inconsistent acceptance/basis IDs. */
export function intentClaimSetProblem(intent: string, requests: readonly string[]): string | null {
  const sections = intentContractSections(intent);
  const idsOf = (section: string, marker: string) => {
    const json = new RegExp(`<!--\\s*sdlc-json:${marker}:start\\s*-->([\\s\\S]*?)<!--\\s*sdlc-json:${marker}:end\\s*-->`, 'u').exec(section)?.[1];
    if (json !== undefined) {
      try { const rows: unknown = JSON.parse(json); return Array.isArray(rows) ? rows.map(row => typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : null).filter((id): id is string => typeof id === 'string') : []; }
      catch { return []; }
    }
    return parseTables(section).flatMap(table => {
      const index = table.header.findIndex(value => value.replace(/`/gu, '').trim().toLowerCase() === 'id');
      return index < 0 ? [] : table.rows.map(row => (row[index] ?? '').replace(/`/gu, '').trim()).filter(id => /^claim-\d+$/u.test(id));
    });
  };
  const acceptance = idsOf(sections['Приёмочный лист'] ?? '', 'acceptance');
  const basis = idsOf(sections['Основания и сценарии'] ?? '', 'basis');
  // Only an explicit source list fixes the number of claims. A prose request may
  // legitimately be split into several acceptance criteria; repair still freezes its existing IDs.
  const numberedRequests = requests.filter(request => /^\s*\d+[.)]\s+/mu.test(request));
  const expected = numberedRequests.length ? seedAcceptanceFromRequests(numberedRequests).map(row => row.id) : [];
  if (acceptance.length !== new Set(acceptance).size || basis.length !== new Set(basis).size) return 'Intent: повторные ID приёмки или оснований';
  if (expected.length && (expected.length !== acceptance.length || expected.some(id => !acceptance.includes(id))))
    return `Intent: потерян или подменён набор исходных требований; ожидаются ${expected.join(', ')}, получены ${acceptance.join(', ') || 'нет'}`;
  if (sections['Основания и сценарии'] !== undefined && (acceptance.length !== basis.length || acceptance.some(id => !basis.includes(id))))
    return 'Intent: приёмка и основания содержат разные ID требований';
  return null;
}

/** The request remains authoritative; a generated exclusion cannot cancel an explicit export. */
export function sourceScopeIssues(intent: string, requests: readonly string[]): IntentContractIssue[] {
  const excluded = intentContractSections(intent)['Чего не делаем'] ?? '';
  const forbidden = new Set(forbiddenCodePaths(excluded));
  const issues: IntentContractIssue[] = [];
  for (const [requestIndex, request] of requests.entries()) {
    const lines = request.split('\n');
    for (const [lineIndex, line] of lines.entries()) {
      if (!/(?:реэкспорт|экспортир|re-export|\bexport\b)/iu.test(line) || /(?:не\s+экспорт|do not export)/iu.test(line)) continue;
      for (const match of line.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+/giu)) {
        const file = match[0];
        if (!forbidden.has(file)) continue;
        if (forbiddenCodePaths(request).includes(file)) throw new Error(`Исходные указания противоречат друг другу: экспорт и запрет изменения ${file}; требуется уточнение`);
        issues.push({ problem: `Исходный запрос требует реэкспорт через ${file}, но «Чего не делаем» запрещает его. Сохрани требуемый реэкспорт как исключение из общей границы; остальные запреты сохраняются.`,
          quotes: [{ section: 'Чего не делаем', lines: [1, Math.max(1, excluded.split('\n').length)] }],
          source: { file: `request-${requestIndex + 1}`, lines: [lineIndex + 1, lineIndex + 1] } });
      }
    }
  }
  return issues;
}

export function contractDependencies(intent: string, requests: readonly string[]): Record<string, string> {
  return { intent: progressHash(intent), requests: progressHash(requests) };
}

export function checkedIntentContract(store: GuidedProgress | undefined, intent: string, requests: readonly string[]): boolean {
  const proof = store?.read().units['intent:contract-checked'];
  return proof?.status === 'observed' &&
    progressHash(proof.dependencies) === progressHash(contractDependencies(intent, requests));
}
