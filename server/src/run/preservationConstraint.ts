export interface PreservationConstraint { coversClaim: boolean }

/** Conservative grammar for preserving existing source and tests, independent of task names.
 * Extra obligations are never discharged by a byte-preservation check. Unknown wording is unassigned. */
export function preservationConstraint(text: string): PreservationConstraint | null {
  const plain = text.replace(/[`*_]/gu, '').replace(/\s+/gu, ' ').trim();
  const parts = /^(.*?)(?:[.:;!]\s*(.*))?$/u.exec(plain)!;
  const clause = parts[1]!.trim();
  const rest = parts[2]?.trim() ?? '';
  const existingRu = '(?:существующие|имеющиеся|текущие|исходные)';
  const sourceRu = '(?:модули|файлы|исходники|исходные файлы|исходный код)';
  const groupRu = `(?:${sourceRu}\\s+и\\s+(?:${existingRu}\\s+)?тесты|тесты\\s+и\\s+(?:${existingRu}\\s+)?${sourceRu})`;
  const scopeRu = `${existingRu}\\s+${groupRu}`;
  const sourceEn = '(?:source(?: files)?|modules|files|code)';
  const existingEn = '(?:existing|current|original)';
  const groupEn = `(?:${sourceEn} and (?:${existingEn} )?tests|tests and (?:${existingEn} )?${sourceEn})`;
  const scopeEn = `${existingEn} ${groupEn}`;
  const rules = [
    `^${scopeRu}\\s+(?:не\\s+(?:трогаем|меняем|изменяем)|(?:остаются|оставить)\\s+без\\s+(?:изменений|правок))$`,
    `^(?:не\\s+(?:изменять|менять|трогать|изменяйте|меняйте|трогайте)|сохранить\\s+без\\s+изменений)\\s+${scopeRu}$`,
    `^${scopeEn} (?:must )?(?:remain|stay) (?:unchanged|unmodified|intact)$`,
    `^(?:keep|leave) ${scopeEn} (?:unchanged|unmodified|intact)$`,
    `^(?:do not|don't) (?:change|modify|touch) ${scopeEn}$`,
  ];
  return rules.some(rule => new RegExp(rule, 'iu').test(clause)) ? { coversClaim: rest.length === 0 } : null;
}
