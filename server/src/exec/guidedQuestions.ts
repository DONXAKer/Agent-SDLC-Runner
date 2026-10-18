import { createHash } from 'node:crypto';
import { z } from 'zod';

export const questionKey = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
export const questionDigest = (text: string): string => createHash('sha256').update(text).digest('hex');
const text = z.string().trim().min(1);
// Вместо дословной цитаты модель передаёт диапазон строк показанного источника;
// точную цитату рендерит и проверяет рантайм (verifyQuestionCitation).
const lineRange = z.tuple([z.number().int().positive(), z.number().int().positive()]);
const citation = { source: text, lines: lineRange };
export const QuestionResolution = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('source'), ...citation, answer: text }).strict(),
  z.object({ kind: z.literal('engineering'), ...citation, category: z.enum(['comment', 'test_name', 'check_method']), choice: text, reason: text }).strict(),
  z.object({ kind: z.literal('context'), path: text, reason: text }).strict(),
  z.object({ kind: z.literal('human'), missingDecision: text, options: z.array(text).length(2), consequence: text, reason: text }).strict(),
]);
export function questionResponseFormat(sources?: Readonly<Record<string, string>>): Record<string, unknown> {
  const s = { type: 'string', minLength: 1 };
  const lines = (max?: number) => ({ type: 'array', items: { type: 'integer', minimum: 1, ...(max === undefined ? {} : { maximum: Math.max(1, max) }) },
    minItems: 2, maxItems: 2, description: 'номера первой и последней строки цитаты в показанном тексте источника (с 1, включительно)' });
  const cited = { source: s, lines: lines() };
  const branch = (kind: string, properties: Record<string, unknown>) => ({ type: 'object', properties: { kind: { type: 'string', enum: [kind] }, ...properties }, required: ['kind', ...Object.keys(properties)], additionalProperties: false });
  const citations = sources ? Object.entries(sources).map(([source, value]) =>
    ({ source: { type: 'string', const: source }, lines: lines(value.split('\n').length) })) : [cited];
  return { type: 'json_schema', json_schema: { name: 'guided_question_resolution', strict: true, schema: { anyOf: [
    ...citations.map(c => branch('source', { ...c, answer: s })),
    ...citations.map(c => branch('engineering', { ...c, category: { type: 'string', enum: ['comment', 'test_name', 'check_method'] }, choice: s, reason: s })),
    branch('context', { path: s, reason: s }),
    branch('human', { missingDecision: s, options: { type: 'array', items: s, minItems: 2, maxItems: 2 }, consequence: s, reason: s }),
  ] } } };
}

/** These categories cover reversible implementation details, never missing policy. */
export function engineeringQuestionAllowed(question: string, category: string): boolean {
  if (/тариф|ставк|льгот|плат[её]ж|прав[ао].{0,15}доступ|удалени|потер.{0,15}данн|измен.{0,15}контракт/iu.test(question)) return false;
  if (category === 'comment') return /комментари|оформлени/iu.test(question);
  if (category === 'test_name') return /тест/iu.test(question) && /имя|назва|путь|куда/iu.test(question);
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
  const words = questionKey(question).match(/[\p{L}\d_]{4,}/gu) ?? [];
  const generic = new Set(['какое', 'какие', 'должен', 'должна', 'нужно', 'можно', 'следует', 'находится', 'источник', 'вопрос', 'использовать']);
  if (!question.includes(source) && !words.filter(w => !generic.has(w)).some(w => questionKey(quote).includes(w.slice(0, 5)))) {
    throw new Error('Цитата не адресует предмет вопроса; найди релевантное основание');
  }
  return quote;
}

/** Preserve full requests; rank and excerpt code instead of sending the whole tree. */
export function questionSources(question: string, sources: ReadonlyMap<string, string>, maxChars: number): Record<string, string> {
  const out: Record<string, string> = {};
  let remaining = maxChars;
  for (const [name, value] of sources) if (/^request-|^human-answer-/u.test(name)) { out[name] = value; remaining -= value.length; }
  if (remaining < 0) throw new Error('Полный исходный запрос не помещается в контекст уточнения');
  const words = questionKey(question).match(/[\p{L}\d_]{4,}/gu) ?? [];
  const ranked = [...sources].filter(([name]) => !/^request-|^human-answer-/u.test(name)).map(([name, value]) => ({ name, value,
    score: (question.includes(name) ? 100 : 0) + words.filter(word => questionKey(value).includes(word)).length })).sort((a, b) => b.score - a.score);
  for (const { name, value } of ranked) {
    if (remaining < 100) break;
    const lines = value.split('\n');
    const hit = lines.findIndex(line => words.some(word => questionKey(line).includes(word)));
    const excerpt = lines.slice(Math.max(0, hit - 3), Math.max(0, hit - 3) + 60).join('\n').slice(0, Math.min(6000, remaining));
    out[name] = excerpt; remaining -= excerpt.length;
  }
  return out;
}
