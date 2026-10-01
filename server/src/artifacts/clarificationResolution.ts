/** Human clarification answers must be reconciled with accepted requirements in the plan. */

import { extractHumanFacts } from './humanFacts.ts';
import { columnIndex, escapeCell, h2SectionRanges, parseTables } from '../md/table.ts';

function cleanCell(value: string): string {
  return value.trim().replace(/\\\|/g, '|').replace(/\s+/g, ' ');
}

/** Runtime-provided evidence; the agent refers to facts by ID instead of copying them. */
export function clarificationResolutionBlock(reportText: string, preparationV2 = false): string | null {
  const facts = extractHumanFacts(reportText);
  if (facts.length === 0) return null;
  const lines = [
    '## Источники ответов человека (не копировать в план)',
    '',
    'Ниже — неизменяемые факты рантайма. В таблице плана перечисли каждый ID ровно один раз, укажи ' +
      (preparationV2 ? 'исходный claim-N либо «границы», «подход», «инварианты»' : 'исходный claim-N') +
      ' и решение. Не переписывай вопрос и ответ: рантайм хранит их здесь и проверяет ссылку по ID. Если противоречие не разрешено, не выдавай план на одобрение — вернись к вопросу человеку.',
    '',
    '| ID ответа | Вопрос | Ответ человека |',
    '|---|---|---|',
  ];
  facts.forEach((fact, i) => lines.push('| ответ-' + (i + 1) + ' | ' + escapeCell(fact.question) + ' | ' + escapeCell(fact.answer) + ' |'));
  return lines.join('\n');
}

/** Blocks plan approval/chunk/verify when any answer lacks an explicit, addressable resolution. */
export function clarificationResolutionProblem(
  planText: string,
  reportText: string,
  acceptedClaimIds?: ReadonlySet<string>,
  preparationV2 = false,
): string | null {
  const facts = extractHumanFacts(reportText);
  if (facts.length === 0) return null;
  const range = h2SectionRanges(planText, /уточнения и разрешение расхождений/i)[0];
  const tables = parseTables(range === undefined ? '' : planText.slice(range.start, range.end));
  const table = tables.find((candidate) =>
    columnIndex(candidate.header, 'ID ответа') >= 0 &&
    columnIndex(candidate.header, 'Исходный пункт') >= 0 &&
    columnIndex(candidate.header, 'Решение') >= 0,
  );
  if (table === undefined) {
    return 'в плане нет таблицы сопоставления ID ответа с исходным claim и явным решением';
  }
  const idCol = columnIndex(table.header, 'ID ответа');
  const questionCol = columnIndex(table.header, 'Вопрос');
  const answerCol = columnIndex(table.header, 'Ответ человека');
  const claimCol = columnIndex(table.header, 'Исходный пункт');
  const resolutionCol = columnIndex(table.header, 'Решение');
  const problems: string[] = [];
  const expectedIds = new Set(facts.map((_, i) => 'ответ-' + (i + 1)));
  const actualIds = table.rows.map((row) => cleanCell(row[idCol] ?? ''));
  for (const actual of actualIds) {
    if (!expectedIds.has(actual)) problems.push('неизвестный ID ответа: ' + actual);
  }
  if (new Set(actualIds).size !== actualIds.length) problems.push('ID ответа повторяется');
  for (let i = 0; i < facts.length; i++) {
    const fact = facts[i]!;
    const id = 'ответ-' + (i + 1);
    const row = table.rows.find((candidate) => cleanCell(candidate[idCol] ?? '') === id);
    if (row === undefined) {
      problems.push(id + ': строка отсутствует');
      continue;
    }
    // Старый формат с копией вопроса/ответа остаётся читаемым. Новый формат опускает эти
    // колонки: ID ответа — неизменяемая ссылка на текст в clarification-report.md.
    if (questionCol >= 0 && answerCol >= 0) {
      const question = cleanCell(row[questionCol] ?? '');
      const answer = cleanCell(row[answerCol] ?? '');
      if (question !== cleanCell(fact.question) && question !== id) problems.push(id + ': вопрос не совпадает с источником');
      if (answer !== cleanCell(fact.answer) && answer !== id) problems.push(id + ': ответ не совпадает с источником');
    }
    const sourceClaim = cleanCell(row[claimCol] ?? '');
    const sourceClaimId = /^claim-\d+\b/i.exec(sourceClaim)?.[0]?.toLowerCase();
    const resolution = cleanCell(row[resolutionCol] ?? '');
    const resolvedClaim = /^(?:подтверждает|уточняет|заменяет)\s+(claim-\d+)\b/i.exec(resolution)?.[1]?.toLowerCase();
    if (preparationV2 && /^(?:границы|подход|инварианты)$/iu.test(sourceClaim)) {
      if (resolution.length < 12 || /[‹›]/u.test(resolution)) problems.push(id + ': явно запиши принятое решение');
      continue;
    }
    if (!/^claim-\d+\b/i.test(sourceClaim) || resolvedClaim === undefined) {
      problems.push(id + ': назови исходный claim-N и решение «подтверждает claim-N …» либо «уточняет/заменяет claim-N: новая формулировка»');
    } else if (sourceClaim.match(/^claim-\d+/i)?.[0]?.toLowerCase() !== resolvedClaim) {
      problems.push(id + ': решение относится к другому claim-N');
    } else if (acceptedClaimIds !== undefined && sourceClaimId !== undefined && !acceptedClaimIds.has(sourceClaimId)) {
      problems.push(id + ': \u043d\u0435\u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0439 claim-N \u0432 intent.md');
    } else if (/^(?:уточняет|заменяет)\b/i.test(resolution) && !/:\s*\S.{2,}/u.test(resolution)) {
      problems.push(id + ': для изменения claim-N запиши новую формулировку после двоеточия');
    }
  }
  return problems.length === 0
    ? null
    : 'ответы человека не сопоставлены с исходными требованиями; план нельзя одобрять:\n' + problems.map((problem) => '- ' + problem).join('\n');
}
