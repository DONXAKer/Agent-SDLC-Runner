import { escapeCell } from '../md/table.ts';
import { IntentIr, QuestionsIr, type QuestionEntryIr, type SourceReference } from './guidedIr.ts';

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
};

export function canonicalGuidedJson(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

export function materializeSourceReference(reference: SourceReference, sources: Readonly<Record<string, string>>): string {
  const source = sources[reference.source];
  if (source === undefined) throw new Error(`Неизвестный источник: ${reference.source}`);
  const full = source.replace(/\r\n/gu, '\n');
  const shown = reference.excerpt?.replace(/\r\n/gu, '\n') ?? full;
  if (!full.includes(shown)) throw new Error(`Выдержка не принадлежит источнику ${reference.source}`);
  const lines = shown.split('\n');
  const [from, to] = reference.lines;
  if (from < 1 || to < from || to > lines.length) throw new Error(`Диапазон ${reference.source}:${from}-${to} вне источника`);
  if (to - from + 1 > 12) throw new Error(`Диапазон ${reference.source}:${from}-${to} шире 12 строк`);
  const quote = lines.slice(from - 1, to).join('\n').trim();
  if (!quote) throw new Error(`Пустое основание ${reference.source}:${from}-${to}`);
  return quote;
}

const referenceLabel = (reference: SourceReference, quote: string): string =>
  `${reference.source}:L${reference.lines[0]}-L${reference.lines[1]} «${quote.replace(/[|\r\n]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()}»`;

export function compileIntent(raw: unknown, sources: Readonly<Record<string, string>>) {
  const ir = IntentIr.parse(raw);
  const acceptanceIds = new Set<string>();
  for (const claim of ir.acceptance) {
    if (acceptanceIds.has(claim.id)) throw new Error(`Дубль требования ${claim.id}`);
    acceptanceIds.add(claim.id);
  }
  const basisIds = new Set<string>();
  const basis = ir.basis.map(claim => {
    if (!acceptanceIds.has(claim.id)) throw new Error(`Основание для неизвестного требования ${claim.id}`);
    if (basisIds.has(claim.id)) throw new Error(`Дубль основания ${claim.id}`);
    basisIds.add(claim.id);
    return { id: claim.id, basis: referenceLabel(claim.basis, materializeSourceReference(claim.basis, sources)),
      scenario: claim.scenario, counterexample: claim.counterexample };
  });
  const missing = ir.acceptance.filter(claim => !basisIds.has(claim.id)).map(claim => claim.id);
  if (missing.length) throw new Error(`Нет оснований для требований: ${missing.join(', ')}`);
  const requirements = { acceptance: ir.acceptance.map(claim => ({ ...claim })), basis };
  return {
    ir,
    requirements,
    canonical: canonicalGuidedJson(ir),
    acceptanceJson: JSON.stringify(requirements.acceptance),
    basisJson: JSON.stringify(requirements.basis),
  };
}

const resolved = (entry: QuestionEntryIr): boolean =>
  ['source', 'engineering', 'answered', 'deferred'].includes(entry.status);

export function compileQuestions(raw: unknown, sources: Readonly<Record<string, string>>, input: {
  slug: string;
  humanFacts: readonly { question: string; answer: string; changed: string }[];
}) {
  const ir = QuestionsIr.parse(raw);
  const ids = new Set<string>();
  const entries = ir.entries.map(entry => {
    if (ids.has(entry.id)) throw new Error(`Дубль вопроса ${entry.id}`);
    ids.add(entry.id);
    if (!entry.evidence?.length) return { ...entry };
    const citations = entry.evidence.map(reference => ({ source: reference.source,
      quote: materializeSourceReference(reference, sources) }));
    return { ...entry, citations };
  });
  const row = (...cells: string[]): string => `| ${cells.map(escapeCell).join(' | ')} |`;
  const identity = (value: string): string => value.trim().replace(/\s+/gu, ' ').toLowerCase().replace(/ё/gu, 'е');
  const human = entries.filter(entry => entry.status === 'human' || entry.status === 'answered');
  const markdown = [
    '<!-- sdlc-template: clarification-report v1 -->',
    `# Вопросы и ответы: ${input.slug}`,
    '', '- **Задача:** intent.md', '- **Разведка:** exploration-report.md', '',
    '## Вопросы и ответы',
    '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |', '|---|---|---|---|---|',
    ...input.humanFacts.map((fact, index) => row(String(index + 1), fact.question, 'да', fact.answer, fact.changed || fact.answer)),
    ...human.filter(entry => !input.humanFacts.some(fact => identity(fact.question) === identity(entry.question)))
      .map((entry, index) => row(String(input.humanFacts.length + index + 1), entry.question, 'да', '(пропущено)', entry.reason)),
    '', '## Ответы из источников', '| Вопрос | Ответ модели по источнику | Источник | Дословная цитата |', '|---|---|---|---|',
    ...entries.filter(entry => entry.status === 'source').flatMap(entry => entry.citations.map(citation => row(entry.question, entry.answer, citation.source, citation.quote))),
    '', '## Инженерные решения', '| Вопрос | Выбор модели | Основание |', '|---|---|---|',
    ...entries.filter(entry => entry.status === 'engineering').map(entry => row(entry.question, entry.answer, entry.reason)),
    '', '## Журнал разрешения вопросов', '| ID | Вопрос | Класс | Статус | Основание |', '|---|---|---|---|---|',
    ...entries.map(entry => row(entry.id, entry.question, entry.status === 'deferred' ? 'deferrable' : resolved(entry) ? 'already-answered' : 'blocking', entry.status, entry.reason)),
    '', '## Исторические основания, требующие проверки',
    ...entries.filter(entry => !resolved(entry)).flatMap(entry => entry.citations.map(citation => `- ${entry.question}: ${citation.source} — ${citation.quote}`)),
    '', '## Уточнённое требование и подход',
    'Ответы человека, выводы по источникам и обратимые инженерные решения переданы в план отдельно. Существенные выводы проверяются ревью и тестами.',
    '', '## Отложено',
    ...entries.filter(entry => !resolved(entry)).map(entry => `- ${entry.question} — ${entry.status}: ${entry.reason}`), '',
  ].join('\n');
  return { ir: { ...ir, entries }, entries, markdown, canonical: canonicalGuidedJson({ ...ir, entries }) };
}
