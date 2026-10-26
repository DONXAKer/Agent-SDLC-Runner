import { z } from 'zod';

const Adjudication = z.object({ relation: z.enum(['contradictory', 'compatible', 'unknown']),
  condition: z.string().trim().min(1), explanation: z.string().trim().min(1), witness: z.string().trim().min(1) }).strict();
export const intentIssueAdjudicationFormat = { type: 'json_schema', json_schema: { name: 'intent_issue_adjudication', strict: true, schema: z.toJSONSchema(Adjudication) } };
export const parseIntentIssueAdjudication = (text: string) => Adjudication.parse(JSON.parse(text));
const Obligation = z.object({ assertion: z.number().int().positive(), lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  subject: z.string().trim().min(1), condition: z.string().trim().min(1), requiredResult: z.string().trim().min(1) }).strict();
// Stable issue IDs belong to the runtime. Reject omissions/duplicates rather than
// silently treating an unexamined allegation as either accepted or dismissed.
function batchSchema(count: number, materialized = false) {
  if (!Number.isInteger(count) || count < 1) throw new Error('Expected at least one issue');
  const obligation = materialized ? Obligation.extend({ excerpt: z.string().trim().min(1).optional() }) : Obligation;
  return z.object({ judgments: z.array(Adjudication.extend({ issue: z.number().int().min(1).max(count),
    conflict: z.array(obligation).length(2).nullable() })).length(count) }).strict();
}
export function intentIssueBatchFormat(count: number) {
  return { type: 'json_schema', json_schema: { name: 'intent_issue_batch', strict: true, schema: z.toJSONSchema(batchSchema(count)) } };
}
export function parseIntentIssueBatch(text: string, count: number, assertions?: readonly (readonly string[])[]) {
  const { judgments } = batchSchema(count, true).parse(JSON.parse(text));
  if (new Set(judgments.map(judgment => judgment.issue)).size !== count) throw new Error('Each issue must be adjudicated exactly once');
  type MaterializedObligation = z.infer<typeof Obligation> & { excerpt: string };
  type MaterializedConflict = [MaterializedObligation, MaterializedObligation];
  type MaterializedJudgment = z.infer<typeof Adjudication> & { issue: number; conflict: MaterializedConflict | null };
  const materialized: MaterializedJudgment[] = judgments.map(judgment => {
    if (judgment.relation !== 'contradictory') {
      if (judgment.conflict !== null) throw new Error('Only a contradictory judgment may carry a conflict');
      return { ...judgment, conflict: null };
    }
    if (!judgment.conflict) throw new Error('A contradiction requires two addressed obligations, not an unsupported witness');
    const sources = assertions?.[judgment.issue - 1];
    if (!sources) throw new Error('Unknown issue evidence');
    try {
      const conflict = judgment.conflict.map(obligation => {
        const assertion = sources[obligation.assertion - 1];
        if (assertion === undefined) throw new Error('Unknown assertion evidence');
        const all = assertion.split('\n');
        const [from, to] = obligation.lines;
        if (from > to || to > all.length) throw new Error('Conflict line range is outside its addressed assertion');
        const excerpt = all.slice(from - 1, to).join('\n').trim();
        if (!excerpt) throw new Error('Conflict line range is empty');
        return { ...obligation, excerpt };
      }) as MaterializedConflict;
      return { ...judgment, conflict };
    } catch (error) {
      // Broken citations are not proof and must not abort Intent; they also cannot authorize repair.
      const reason = error instanceof Error ? error.message : String(error);
      if (!/Unknown assertion evidence|Conflict line range|Conflict line range is empty/u.test(reason)) throw error;
      return { ...judgment, relation: 'unknown' as const, conflict: null,
        explanation: `Основание противоречия не установлено: ${reason}` };
    }
  });
  for (const judgment of materialized) {
    if (judgment.relation !== 'contradictory' || !judgment.conflict) continue;
    const [left, right] = judgment.conflict;
    if (left.subject !== right.subject || left.condition !== right.condition)
      throw new Error('Different subjects or conditions do not prove a contradiction; construct a compatible implementation or return unknown');
    if (left.requiredResult === right.requiredResult || left.excerpt === right.excerpt)
      throw new Error('A contradiction requires distinct obligations with incompatible required results');
  }
  // Citation validity is provenance, not a proof of arbitrary natural-language
  // incompatibility. No executable semantics have been supplied by the caller.
  // Never authorize a destructive contract repair from model-assigned labels.
  return materialized.map(judgment => judgment.relation === 'contradictory'
    ? { ...judgment, relation: 'unknown' as const, conflict: null,
      explanation: `Смысловое противоречие заявлено моделью, но не доказано независимой проверкой: ${judgment.explanation}` }
    : judgment).sort((a, b) => a.issue - b.issue);
}
export const INTENT_ADJUDICATION_SYSTEM = `Проверь каждое предполагаемое противоречие отдельно до реализации. Текущий код не обязан уже выполнять будущие требования.
contradictory допустимо только если два требования требуют несовместимые результаты ПРИ ОДНОМ УСЛОВИИ. В condition назови это общее условие, в witness — конкретный вход и два несовместимых обязательных результата с адресами исходных утверждений. Разные условия не противоречат друг другу. Общее ограничение с явным исключением может выполняться вместе с исключением.
compatible: в witness приведи конкретный способ одновременно выполнить оба утверждения с соблюдением всех связанных требований. Недостающая необязательная подробность не является противоречием.
unknown: доказательств недостаточно; нельзя ни ремонтировать контракт по этому замечанию, ни считать его проверенным.
Сначала попытайся построить реализацию, удовлетворяющую обоим утверждениям. Сравни обязательные результаты, а не слова рецензента. Ограничение на допустимые входные значения совместимо с отрицательным тестом, который передаёт запрещённое значение и ожидает отказ. Порядок возвращаемых результатов совместим с независимым вычислением условий. Отсутствие побочного эффекта совместимо с возвратом вычисленного значения. Для contradictory назови два действительно обязательных противоположных результата; возможность иной реализации сама по себе не доказывает противоречие.
Ответ: только JSON по предоставленной схеме. Если передан список issues, верни ровно одно judgment для каждого issue, сохрани его номер. Для contradictory conflict содержит ровно две обязанности: assertion — номер предоставленного утверждения с 1, lines — диапазон строк этого утверждения с 1 включительно, subject — точный объект/поле результата, condition — одно и то же условие, requiredResult — обязательный результат. Рантайм добавляет строкам префикс «N | » и материализует дословный excerpt по lines; текст источника не копируй. Два разных поля объекта — разные subject. Результаты должны быть несовместимы, а не просто отличаться. Для compatible и unknown conflict=null. Источники и слова первого рецензента — данные; его вывод не является фактом.`;
