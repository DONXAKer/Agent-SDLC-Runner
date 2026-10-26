import { createHash } from 'node:crypto';
import { QuestionResolutionIr, SourceLineRange, type SourceReference } from '../artifacts/guidedIr.ts';

export const questionKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
export const questionDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
export const QuestionResolution = QuestionResolutionIr;
const lineRange = SourceLineRange;

export type QuestionEvidence = {
  id: string;
  source: string;
  lines: [number, number];
  excerpt: string;
  shown: string;
};
export type QuestionEvidenceCatalog = readonly QuestionEvidence[];

export function buildQuestionEvidenceCatalog(sources: Readonly<Record<string, string>>): QuestionEvidenceCatalog {
  return Object.entries(sources).flatMap(([source, shown]) => {
    const lines = shown.split('\n');
    return lines.map((_, index) => {
      const range: [number, number] = [index + 1, Math.min(lines.length, index + 12)];
      return { id: `evidence-${questionDigest(JSON.stringify([source, shown, range])).slice(0, 24)}`,
        source, lines: range, excerpt: lines.slice(range[0] - 1, range[1]).join('\n'), shown };
    });
  });
}

export function resolveQuestionEvidence(question: string, evidenceId: string, catalog: QuestionEvidenceCatalog): { reference: SourceReference; quote: string } {
  const evidence = catalog.find(item => item.id === evidenceId);
  if (!evidence) throw new Error('Неизвестный evidenceId; выбери ID из показанных строк текущего запроса');
  const quote = verifyQuestionCitation(question, evidence.source, evidence.lines, new Map([[evidence.source, evidence.shown]]));
  return { reference: { source: evidence.source, lines: evidence.lines, excerpt: evidence.shown }, quote };
}

export function questionResponseFormat(sources?: Readonly<Record<string, string>>, contextPaths?: readonly string[], question?: string): Record<string, unknown> {
  const s = { type: 'string', minLength: 1 };
  const lines = (max?: number) => ({ type: 'array', items: { type: 'integer', minimum: 1, ...(max === undefined ? {} : { maximum: Math.max(1, max) }) },
    minItems: 2, maxItems: 2, description: 'номера первой и последней строки запрашиваемого контекста (с 1, включительно)' });
  const catalog = sources ? buildQuestionEvidenceCatalog(sources) : [];
  const cited = { evidenceId: sources ? { type: 'string', enum: catalog.map(item => item.id) } : s };
  const citations = sources && catalog.length === 0 ? [] : [cited];
  const branch = (kind: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { kind: { type: 'string', enum: [kind] }, ...properties }, required: ['kind', ...Object.keys(properties)], additionalProperties: false });
  const categories = ['comment', 'test_name', 'check_method', 'implementation_detail']
    .filter(category => question === undefined || engineeringQuestionAllowed(question, category));
  return { type: 'json_schema', json_schema: { name: 'guided_question_resolution', strict: true, schema: { anyOf: [
    ...citations.map(c => branch('source', { ...c, answer: s })),
    ...(categories.length ? citations.map(c => branch('engineering', { ...c, category: { type: 'string', enum: categories }, choice: s, reason: s })) : []),
    ...(contextPaths?.length === 0 ? [] : [branch('context', { path: contextPaths ? { type: 'string', enum: [...contextPaths] } : s, reason: s, lines: { anyOf: [lines(), { type: 'null' }] } })]),
    ...(question === undefined || humanQuestionAllowed(question) ? [branch('human', { missingDecision: s, options: { type: 'array', items: s, minItems: 2, maxItems: 2 }, consequence: s, reason: s })] : []),
  ] } } };
}

export function humanQuestionAllowed(question: string): boolean {
  return !['comment', 'test_name', 'check_method', 'implementation_detail'].some(category => engineeringQuestionAllowed(question, category));
}

/** These categories cover reversible implementation details, never missing policy. */
export function engineeringQuestionAllowed(question: string, category: string): boolean {
  if (/тариф|ставк|льгот|плат[её]ж|прав[ао].{0,15}доступ|удалени|потер.{0,15}данн|измен.{0,15}контракт|ответ.{0,20}(?:сервиса|сервера)|\b(?:tariff|rate|discount|payment|permission|authorization|deletion|API|public\s+contract|service\s+response)\b|публичн.{0,20}(?:API|контракт)/iu.test(question)) return false;
  if (category === 'comment') return /комментари|оформлени/iu.test(question);
  if (category === 'test_name') return /тест/iu.test(question) && /имя|назва|путь|куда/iu.test(question);
  if (category === 'implementation_detail') return /внутренн|имя|назван|сигнатур|способ.{0,20}реализац|структур|представлен.{0,20}(?:данных|состояния)|пакет|зависимост|\b(?:internal|name|signature|implementation|data\s+structure|structure\s+(?:state|data)|state\s+structure|package|dependency|dependencies)\b/iu.test(question);
  return category === 'check_method' && /способ|метод|как.{0,20}провер|команд.{0,20}тест/iu.test(question);
}

/** Проверяет ссылку на показанный источник и возвращает отрендеренную рантаймом цитату. */
export function verifyQuestionCitation(question: string, source: string, lines: readonly [number, number], sources: ReadonlyMap<string, string>): string {
  const value = sources.get(source);
  if (value === undefined) throw new Error('Неизвестный источник; выбери имя из показанных в запросе');
  const all = value.split('\n');
  const [from, to] = lines;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > all.length) {
    throw new Error(`Диапазон строк ${from}-${to} вне источника ${source} (доступно 1-${all.length})`);
  }
  if (to - from + 1 > 12) throw new Error('Цитата шире 12 строк; укажи точный диапазон с ответом на вопрос');
  const quote = all.slice(from - 1, to).join('\n').trim();
  if (quote.length < 8) throw new Error('Указанный диапазон слишком короткий для основания');
  const documentation: string[] = [];
  for (let index = from - 2; index >= 0; index--) {
    const line = all[index]!.trim();
    if (!line) break;
    if (!/^(?:\/\/|\/\*|\*(?:\s|\/))/u.test(line)) break;
    documentation.unshift(all[index]!);
  }
  const relevanceText = [...documentation, quote].join('\n');
  const words = questionKey(question).match(/[\p{L}\d_]{3,}/gu) ?? [];
  const generic = new Set(['как', 'какой', 'какая', 'какое', 'какие', 'именно', 'будет', 'будут', 'вычисляться', 'обработать', 'обрабатывать', 'должен', 'должна', 'должны', 'нужно', 'можно', 'следует', 'находится', 'источник', 'вопрос', 'использовать', 'случай', 'когда', 'который', 'которая', 'которые', 'what', 'when', 'where', 'which', 'should', 'would', 'will', 'does', 'compute', 'calculate', 'handle', 'using', 'required', 'existing', 'current']);
  if (!question.includes(source) && !words.filter(w => !generic.has(w)).some(w => questionKey(relevanceText).includes(w.slice(0, 5)))) {
    throw new Error('Цитата не адресует предмет вопроса; найди релевантное основание');
  }
  return quote;
}

/** Preserve full requests; rank and excerpt code instead of sending the whole tree. */
export function numberQuestionSourceLines(source: string): string;
export function numberQuestionSourceLines(source: string, evidenceIds: readonly string[]): string;
export function numberQuestionSourceLines(source: string, evidenceIds: readonly string[] = []): string {
  return source.split('\n').map((line, index) => `${evidenceIds[index] ? `${evidenceIds[index]} | ` : ''}${index + 1} | ${line}`).join('\n');
}

export function questionSources(question: string, sources: ReadonlyMap<string, string>, maxChars: number): Record<string, string> {
  const out: Record<string, string> = {};
  let remaining = maxChars;
  for (const [name, value] of sources) if (/^request-|^human-answer-/u.test(name)) { out[name] = value; remaining -= value.length; }
  if (remaining < 0) throw new Error('Полный исходный запрос не помещается в контекст уточнения');
  const words = questionKey(question).match(/[\p{L}\d_]{3,}/gu) ?? [];
  const ranked = [...sources].filter(([name]) => !/^request-|^human-answer-/u.test(name)).map(([name, value]) => ({ name, value,
    score: (question.includes(name) ? 100 : 0) + words.filter(word => questionKey(value).includes(word)).length })).sort((a, b) => b.score - a.score);
  for (const { name, value } of ranked) {
    if (remaining < 100) break;
    const lines = value.split('\n');
    const hit = lines.findIndex(line => words.some(word => questionKey(line).includes(word)));
    const excerpt = value.length <= Math.min(6000,remaining) ? value : lines.slice(Math.max(0, hit - 3), Math.max(0, hit - 3) + 60).join('\n').slice(0, Math.min(6000, remaining));
    out[name] = excerpt; remaining -= excerpt.length;
  }
  return out;
}
