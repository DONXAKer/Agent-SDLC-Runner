/**
 * Механические поля плана, готовности задачи, отчёта разведки и отчёта по вопросам —
 * рантаймом, до модели. Тот же приём и те же границы, что у журнала chunk'а
 * (`journalAutofill.ts`): только механическое, строки решений человека не трогаются.
 *
 * Эти поля объявлены за рантаймом в `SCHEMA_OVERRIDES`, но заполнять их было некому, и
 * модель писала их сама: в relog серии v5 (`docs/model-runs.md`) `base_sha` плана выдуман
 * («`git rev-parse HEAD` (или `d994f8e`…)»). Раз поле рантайма, модель его больше не
 * спрашивается (`modelGroupFields` в `FormFillExecutor.ts`) — и потому заполнено оно
 * обязано быть всегда: неизвестный факт пишется фактом («н/п — не git-репозиторий»), а не
 * остаётся плейсхолдером, закрыть который уже некому.
 */

import { readField, replaceAfterLabel } from '../artifacts/artifact.ts';
import { fillMechanicalPlaceholders } from './journalAutofill.ts';

/**
 * Шаблоны, у которых ВСЕ поля рантайма закрывает автозаполнение этого файла до модели.
 * Только у них поля рантайма исключаются из вопросов модели (`modelGroupFields` в
 * `FormFillExecutor.ts`): у остальных исключённое поле осталось бы плейсхолдером, закрыть
 * который уже некому (журнал chunk'а — дата одобрения плана извлекается не всегда;
 * handoff — автозаполнения нет).
 *
 * Живёт здесь, а не у исполнителя: утверждение «покрыто» — про функции этого файла, и
 * второй список рядом с потребителем расходился бы с ними при первой новой форме.
 * Скрепа — `formAutofill.test.ts` по реальным шаблонам эталона.
 */
export const RUNTIME_AUTOFILLED_TEMPLATES: ReadonlySet<string> = new Set([
  'plan.template.md',
  'readiness.template.md',
  'clarification-report.template.md',
  'exploration-report.template.md',
]);

export interface PlanFacts {
  title: string;
  explorationDone: boolean;
  clarificationDone: boolean;
  /** HEAD либо причина его отсутствия — строкой: поле обязано закрыться. */
  base: string;
}

export function autofillPlan(text: string, f: PlanFacts): { text: string; filled: number } {
  return fillMechanicalPlaceholders(text, (inner, line) => {
    if (inner === 'название витка') return f.title;
    // `‹да/нет›` стоит и в таблице осей плана — там это выбор модели, а не факт рантайма.
    if (!/\*\*(Вход|База):\*\*/u.test(line)) return null;
    if (inner === 'да/нет') return f.explorationDone ? 'да' : 'нет';
    if (inner === 'да / шага не было') return f.clarificationDone ? 'да' : 'шага не было';
    if (inner.startsWith('base_sha')) return f.base;
    return null;
  });
}

export interface ReadinessFacts {
  title: string;
  date: string;
  /** Чей прогон: 1 — этап intent, 2 — этап plan. Дата другого прогона не трогается. */
  run: 1 | 2;
}

/** Секция второго прогона. Окончание перечислено явно: `\b` по кириллице не работает. */
const RUN_2_HEADING = /^##\s+Прогон\s+2(\s|$)/mu;

export function autofillReadiness(text: string, f: ReadinessFacts): { text: string; filled: number } {
  const cut = text.search(RUN_2_HEADING);
  const head = cut < 0 ? text : text.slice(0, cut);
  const tail = cut < 0 ? '' : text.slice(cut);
  const part = (chunk: string, ownRun: boolean) =>
    fillMechanicalPlaceholders(chunk, (inner) => {
      if (inner === 'название витка') return f.title;
      if (inner === 'дата' && ownRun) return f.date;
      return null;
    });
  const a = part(head, f.run === 1);
  const b = part(tail, f.run === 2);
  return { text: a.text + b.text, filled: a.filled + b.filled };
}

/** Название витка — единственное поле рантайма отчёта разведки. */
export function autofillTitle(text: string, title: string): { text: string; filled: number } {
  return fillMechanicalPlaceholders(text, (inner) => (inner === 'название витка' ? title : null));
}

export interface ClarificationFacts {
  title: string;
  /** Этап 2 состоялся — отчёт разведки есть. */
  explorationDone: boolean;
}

/**
 * Отчёт по вопросам: название витка и поле «Разведка».
 *
 * «Разведка» — поле рантайма (`SCHEMA_OVERRIDES`), но в бланке это меню БЕЗ плейсхолдера:
 * `` `exploration-report.md` / шага не было — мелкий контур ``. Модель его не спрашивается
 * (плейсхолдера нет, и поле рантайма), `fillMechanicalPlaceholders` его не видит (по той же
 * причине) — и обе ветки меню оставались в отчёте навсегда. Ветка выбирается по факту.
 *
 * Меняется только значение, ещё несущее ОБЕ ветки: выбранная ветка (или правка человека)
 * повторным вызовом не перетирается — идемпотентно.
 */
export function autofillClarification(
  text: string,
  f: { title: string; explorationDone: boolean },
): { text: string; filled: number } {
  const titled = autofillTitle(text, f.title);
  const current = readField(titled.text, 'Разведка');
  if (current === null || !current.includes('exploration-report.md') || !current.includes('шага не было')) {
    return titled;
  }
  const value = f.explorationDone ? '`exploration-report.md`' : 'шага не было — мелкий контур';
  const replaced = replaceAfterLabel(titled.text, 'Разведка', value);
  return replaced === null ? titled : { text: replaced, filled: titled.filled + 1 };
}
