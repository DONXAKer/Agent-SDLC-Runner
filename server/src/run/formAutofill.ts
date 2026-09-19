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
  'handoff.template.md',
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

/**
 * Снимает хвостовой комментарий `# н/п …` со строки `key…`, когда её значение — уже НЕ
 * `н/п`. Комментарий поясняет условие плейсхолдера в шаблоне, а не факт: заполненное
 * реальным значением поле его не подтверждает.
 */
function dropStaleNpComment(text: string, key: string, value: string): string {
  if (value.startsWith('н/п')) return text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.trimStart().startsWith(key)) return line;
      const at = line.indexOf('# н/п');
      return at < 0 ? line : line.slice(0, at).replace(/\s+$/, '');
    })
    .join('\n');
}

/** Название витка — единственное поле рантайма отчёта разведки. */
export interface HandoffFacts {
  title: string;
  slug: string;
  /** URL origin-remote'а либо имя каталога проекта — второе, когда remote'а нет. */
  repo: string;
  /** Ветка рабочего дерева либо «н/п — …» с причиной (не git-репозиторий). */
  branch: string;
  /** База chunk'а из его журнала (`chunk-N-journal.md` → «База»), не текущий HEAD: к моменту
   *  автозаполнения `commitByRuntime` уже мог сдвинуть HEAD своим коммитом. */
  baseSha: string;
  /** Дата последнего изменения набора гейтов либо «н/п — …» с причиной (набора нет — обрыв). */
  gatesDate: string;
  chunk: number;
  attempts: number;
  verdict: 'passed' | 'aborted';
  /** sha коммита `commitByRuntime` либо «н/п — …» с причиной, когда коммита не было. */
  commit: string;
  /** Публикация — решение человека вне этого рантайма; на момент записи handoff'а она
   *  заведомо ещё не состоялась (её не делает никто, кроме человека, уже ПОСЛЕ передачи). */
  published: 'нет';
  /** Итог гейта «Проверка предусловий публикации», посчитанного рантаймом на входе этапа. */
  publishGate: { status: string; branchOk: string; hasCommit: string; junk: string };
}

/**
 * Пятнадцать механических полей шапки передачи (`SCHEMA_OVERRIDES['handoff.template.md']`):
 * название витка, девять ключей yaml-блока «Состояние» и четыре подполя строки «Статус»
 * гейта «Проверка предусловий публикации». `commit` и `published` вошли в их число ровно
 * тогда, когда стало кому их считать: `commitByRuntime` коммитит на входе этапа (`begin →
 * afterStart`), раньше, чем `mechanicalJobs` заполняет этот бланк, — до него оба поля
 * были фактом, которого рантайм ещё не знал.
 *
 * Строки `base_sha: ‹sha›` и `commit: ‹sha›` несут ОДИНАКОВЫЙ текст плейсхолдера, а строка
 * «Статус» и yaml-поле `published` — одинаковый `‹да/нет›»: различать приходится по
 * yaml-ключу/контексту СТРОКИ, не по содержимому `‹…›` (тот же приём, что у двух полей
 * «дата» в `journalAutofill.ts::valueFor`).
 *
 * `branch:`/`commit:` несут в шаблоне свой поясняющий комментарий («# н/п если ветки нет»,
 * «# н/п — коммита не было»): он верен, только пока значение действительно `н/п`. Реальным
 * значением (веткой, sha) комментарий не заменяется сам — `fillMechanicalPlaceholders`
 * трогает только сам плейсхолдер `‹…›`, а хвост строки ей не принадлежит, — и строка
 * `commit: a1b2c3d  # н/п — коммита не было` читалась самопротиворечиво (ревью
 * code-review-all, 2026-09-18). `dropStaleNpComment` снимает комментарий ровно тогда,
 * когда факт больше не `н/п`.
 */
export function autofillHandoff(text: string, f: HandoffFacts): { text: string; filled: number } {
  const filled = fillMechanicalPlaceholders(text, (inner, line) => {
    if (inner === 'название витка') return f.title;
    if (inner.startsWith('✅/❌/⏭')) return f.publishGate.status;
    if (inner === 'та / не та') return f.publishGate.branchOk;
    if (inner === 'нет / что именно') return f.publishGate.junk;
    if (inner === 'да/нет' && line.includes('коммитить')) return f.publishGate.hasCommit;
    const key = line.trimStart();
    if (key.startsWith('slug:')) return f.slug;
    if (key.startsWith('repo:')) return f.repo;
    if (key.startsWith('branch:')) return f.branch;
    if (key.startsWith('base_sha:')) return f.baseSha;
    if (key.startsWith('commit:')) return f.commit;
    if (key.startsWith('gates_date:')) return f.gatesDate;
    if (key.startsWith('chunk:')) return String(f.chunk);
    if (key.startsWith('attempts:')) return String(f.attempts);
    if (key.startsWith('verdict:')) return f.verdict;
    if (key.startsWith('published:')) return f.published;
    return null;
  });
  const text2 = dropStaleNpComment(dropStaleNpComment(filled.text, 'branch:', f.branch), 'commit:', f.commit);
  return { text: text2, filled: filled.filled };
}

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
  f: ClarificationFacts,
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
