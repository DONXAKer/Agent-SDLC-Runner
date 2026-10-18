/**
 * Закрытый словарь исходов оси плана — один источник правды для ВОПРОСА топ-апа
 * (`planAxisFill.planAxisQuestion`) и для РАЗБОРА ответа (`parseOneAxisAnswer`).
 *
 * Тот же приём, что `ChoiceOption`/`matchChoice` дают `choice`-полям бланка
 * (`artifacts/formSchema.ts`, `artifacts/sheet.ts`): модель отвечает КЛЮЧОМ из явно
 * перечисленного словаря, рантайм сопоставляет ключ и записывает дословный текст —
 * вместо того чтобы описывать закрытый набор прозой и ловить его россыпью регулярок.
 * Живой случай класса отказа, который это убирает: модель копирует формулировку словаря
 * из вопроса не в то поле (`н/п — причина` в первом поле строки — дамп
 * `00023-plan-planAxisFill.json`, test26b, gpt-oss-20b-rf, 2026-09-22).
 *
 * Словоформы ключей (`риск/риски/риска/…`) здесь НЕ свои: они переиспользуют
 * `OUTCOME_WORD_SOURCES` из `artifacts/planAxes.ts` — то, что топ-ап ЗАПИШЕТ в план,
 * читатель плана обязан ПРОЧИТАТЬ обратно, и расхождение двух наборов словоформ уже
 * стоило одного расходящегося дубля (`RISK_HEAD` в `planAxisFill.ts`).
 */

import { OUTCOME_WORD_SOURCES, type AxisOutcome } from '../artifacts/planAxes.ts';

/** Ключ словаря в том виде, как он назван в вопросе модели. */
export type AxisOutcomeKey = 'н/п' | 'claim-N' | 'инвариант' | 'гейт' | 'риск' | 'следующий виток';

interface AxisOutcomeEntry {
  key: AxisOutcomeKey;
  outcome: AxisOutcome;
  /** Строка словаря для вопроса — форма ключа и короткий глосс. */
  promptLine: string;
}

/**
 * Порядок — канонический: им рендерится список в вопросе, им же разрешается ничья
 * при равной позиции ключа в поле ответа (см. `matchAxisOutcome`).
 */
const ENTRIES: readonly AxisOutcomeEntry[] = [
  { key: 'н/п', outcome: 'notApplicable', promptLine: '- `н/п — причина` — ось не затронута, причина обязательна;' },
  { key: 'claim-N', outcome: 'claim', promptLine: '- `claim-N` — пункт УЖЕ в приёмочном листе (N — номер существующего пункта);' },
  { key: 'инвариант', outcome: 'invariant', promptLine: '- `инвариант` — исход ссылается на инвариант задачи;' },
  { key: 'гейт', outcome: 'gate', promptLine: '- `гейт «имя»` — имя строки набора гейтов, дословно;' },
  { key: 'следующий виток', outcome: 'nextWitok', promptLine: '- `следующий виток` — исход уходит в открытый вопрос задачи;' },
  { key: 'риск', outcome: 'risk', promptLine: '- `риск` — риск принимается (форма строки риска — отдельно, ниже).' },
];

const BY_OUTCOME = new Map<AxisOutcome, AxisOutcomeEntry>(ENTRIES.map((e) => [e.outcome, e]));

/** Список ключей словаря для вопроса — единственное место, где этот список перечислен. */
export function axisOutcomePromptOptions(): string {
  return ENTRIES.map((e) => e.promptLine).join('\n');
}

export interface AxisOutcomeMatch {
  /** Ключ словаря, как в вопросе. */
  key: AxisOutcomeKey;
  /** Исход в терминах читателя плана (`planAxes.ts`). */
  outcome: AxisOutcome;
  /** Текст поля после ключа (причина `н/п`, пояснение) — может быть пустым. */
  detail: string;
}

/**
 * Сопоставление поля «исход» со словарём. Терпимо к обёрткам (`*Инвариант*`), регистру,
 * префиксам вида `исход:` и хвосту-пояснению после ключа — той же терпимостью, что
 * `matchChoice` обходит «вежливости» модели. Побеждает ключ, встретившийся РАНЬШЕ по
 * тексту поля (тот же принцип, что `readOutcome` в `planAxes.ts`: «риск — см. claim-3» —
 * это риск, а не claim); при равной позиции — порядок словаря. `null` — ни один ключ не
 * нашёлся: такой исход не считается ответом, ось остаётся незакрытой.
 */
export function matchAxisOutcome(raw: string): AxisOutcomeMatch | null {
  const text = raw.trim().replace(/^[*_`]+/, '').replace(/[*_`]+$/, '');
  if (text === '') return null;
  let best: { at: number; end: number; entry: AxisOutcomeEntry } | null = null;
  for (const { source, outcome } of OUTCOME_WORD_SOURCES) {
    const entry = BY_OUTCOME.get(outcome);
    if (entry === undefined) continue;
    const m = new RegExp(source, 'i').exec(text);
    if (m === null) continue;
    if (best !== null && m.index >= best.at) continue;
    best = { at: m.index, end: m.index + m[0].length, entry };
  }
  if (best === null) return null;
  return { key: best.entry.key, outcome: best.entry.outcome, detail: text.slice(best.end).trim() };
}
