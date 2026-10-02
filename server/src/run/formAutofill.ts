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
import { escapeCell, h2SectionRanges, parseTables } from '../md/table.ts';

export interface PlanAcceptanceCheck {
  id: string;
  behavior: string;
  procedure: string;
  expected: string;
}

export function acceptanceChecksFromIntent(intentText: string): PlanAcceptanceCheck[] {
  const block = /<!--\s*sdlc-json:acceptance:start\s*-->([\s\S]*?)<!--\s*sdlc-json:acceptance:end\s*-->/u.exec(intentText)?.[1];
  if (block !== undefined) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (Array.isArray(parsed)) {
        const checks = parsed.flatMap((item: unknown) => {
          if (typeof item !== 'object' || item === null) return [];
          const row = item as Record<string, unknown>;
          return typeof row.id === 'string' && /^claim-\d+$/u.test(row.id) &&
            typeof row.behavior === 'string' && row.behavior.trim() !== '' &&
            typeof row.procedure === 'string' && row.procedure.trim() !== '' &&
            typeof row.expected === 'string' && row.expected.trim() !== ''
            ? [{ id: row.id, behavior: row.behavior, procedure: row.procedure, expected: row.expected }]
            : [];
        });
        if (checks.length > 0) return checks;
      }
    } catch {
      // The finalized intent may have been rendered to its markdown table already.
    }
  }
  // The finalizer renders and removes the temporary JSON comments after validating them.
  // Recover the same four canonical fields from the stable table representation.
  return parseTables(intentText)
    .filter((table) => table.section.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').includes('приемочн'))
    .flatMap((table) => table.rows.flatMap((row) => {
      const id = row[0]?.trim() ?? '';
      const behavior = row[1]?.trim() ?? '';
      const combined = row[2]?.trim() ?? '';
      const split = /Ожидаемо\s*:\s*/iu.exec(combined);
      if (!/^claim-\d+$/u.test(id) || behavior === '' || split === null) return [];
      const procedure = combined.slice(0, split.index).replace(/^Процедура:\s*/iu, '').replace(/[.\s]+$/u, '').trim();
      const expected = combined.slice(split.index + split[0].length).trim();
      return procedure !== '' && expected !== '' ? [{ id, behavior, procedure, expected }] : [];
    }));
}

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
  requirementsHash: string;
  acceptanceChecks?: readonly PlanAcceptanceCheck[];
}

function replacePlanAcceptanceTable(text: string, checks: readonly PlanAcceptanceCheck[]): { text: string; filled: number } {
  if (checks.length === 0) return { text, filled: 0 };
  const range = h2SectionRanges(text, /^Проверки приёмки$/iu)[0];
  if (range === undefined) return { text, filled: 0 };
  const body = text.slice(range.start, range.end);
  const lines = body.split(/\r?\n/u);
  const headerAt = lines.findIndex((line) => /^\|\s*ID\s*\|/iu.test(line));
  if (headerAt < 0 || headerAt + 1 >= lines.length || !/^\|?\s*:?-{2,}/u.test(lines[headerAt + 1]!)) {
    return { text, filled: 0 };
  }
  let tableEnd = headerAt + 2;
  while (tableEnd < lines.length && /^\s*\|/u.test(lines[tableEnd]!)) tableEnd++;
  const rows = checks.map((check) => `| ${[check.id, check.behavior, check.procedure, check.expected].map(escapeCell).join(' | ')} |`);
  if (lines.slice(headerAt + 2, tableEnd).join('\n') === rows.join('\n')) return { text, filled: 0 };
  lines.splice(headerAt + 2, tableEnd - (headerAt + 2), ...rows);
  const replacement = lines.join('\n');
  return { text: text.slice(0, range.start) + replacement + text.slice(range.end), filled: 1 };
}

export function autofillPlan(text: string, f: PlanFacts): { text: string; filled: number } {
  const filled = fillMechanicalPlaceholders(text, (inner, line) => {
    if (inner === 'sha256 требований' && /\*\*Требования \(SHA-256\):\*\*/u.test(line)) return f.requirementsHash;
    if (inner === 'название витка') return f.title;
    // `‹да/нет›` стоит и в таблице осей плана — там это выбор модели, а не факт рантайма.
    if (!/\*\*(Вход|База):\*\*/u.test(line)) return null;
    if (inner === 'да/нет') return f.explorationDone ? 'да' : 'нет';
    if (inner === 'да / шага не было') return f.clarificationDone ? 'да' : 'шага не было';
    if (inner.startsWith('base_sha')) return f.base;
    return null;
  });
  // Older templates have no fingerprint field. Add it while preparing the plan,
  // before human approval; never repair an approved snapshot on restore.
  let withHash: { text: string; filled: number };
  if (!/^\s*- \*\*Требования \(SHA-256\):\*\*/mu.test(filled.text)) {
    const line = `- **Требования (SHA-256):** ${f.requirementsHash}\n`;
    const base = /^- \*\*База:\*\*[^\n]*(?:\n|$)/mu;
    const text2 = base.test(filled.text)
      ? filled.text.replace(base, (match) => `${match.trimEnd()}\n${line}`)
      : `${filled.text.trimEnd()}\n\n${line}`;
    withHash = { text: text2, filled: filled.filled + 1 };
  } else {
    const refreshed = replaceAfterLabel(filled.text, 'Требования (SHA-256)', f.requirementsHash);
    withHash = refreshed !== null && refreshed !== filled.text
      ? { text: refreshed, filled: filled.filled + 1 }
      : filled;
  }
  const acceptance = replacePlanAcceptanceTable(withHash.text, f.acceptanceChecks ?? []);
  return { text: acceptance.text, filled: withHash.filled + acceptance.filled };
}

export interface ReadinessFacts {
  title: string;
  date: string;
  /** Чей прогон: 1 — этап intent, 2 — этап plan. Дата другого прогона не трогается. */
  run: 1 | 2;
  /** Runtime-computed compact evidence; absent during the initial mechanical seed pass. */
  checks?: string;
  verdict?: 'ready' | 'not';
}

/** Секция второго прогона. Окончание перечислено явно: `\b` по кириллице не работает. */
const RUN_2_HEADING = /^##\s+Прогон\s+2(\s|$)/mu;
const RUN_2_PENDING = {
  date: '\u041e\u0436\u0438\u0434\u0430\u0435\u0442 \u043f\u0440\u043e\u0433\u043e\u043d\u0430 2',
  checks: '\u041e\u0436\u0438\u0434\u0430\u0435\u0442 \u044d\u0442\u0430\u043f\u0430 \u043f\u043b\u0430\u043d\u0430',
  verdict: '\u041d\u0435 \u0432\u044b\u0447\u0438\u0441\u043b\u0435\u043d',
} as const;
const RUN_1_PENDING = {
  checks: 'Ожидает проверки этапа intent',
  verdict: 'Не вычислен',
} as const;

export function autofillReadiness(text: string, f: ReadinessFacts): { text: string; filled: number } {
  // The original readiness template asked the model to certify a table and four
  // generic human answers. Readiness now comes from executable artifact checks.
  // Normalize that known template while seeding it, retaining recorded answers.
  if (/^\|\s*#\s*\|\s*Проверка\s*\|\s*Статус\s*\|/mu.test(text)) {
    const answers = text.split(/\r?\n/u).filter((line) =>
      /^- \*\*Ответ человека \(/u.test(line) && !/[‹›]/u.test(line),
    );
    const sections = text.split(/(?=^##\s+Прогон\s+[12](?:\s|$))/mu);
    const title = sections.shift() ?? '# Готовность задачи: ‹название витка›\n\n';
    text = title + sections.map((section) => {
      const run = /^##\s+Прогон\s+([12])/mu.exec(section)?.[1];
      const date = /^(?:- )?\*\*Дата:\*\*\s*(.*)$/mu.exec(section)?.[1] ?? '‹дата›';
      return [section.split(/\r?\n/u)[0], '', `- **Дата:** ${date}`,
        `- **Проверки:** ‹проверки прогона ${run}›`,
        `- **Вердикт прогона ${run}:** ‹готова / не готова›`, '', ''].join('\n');
    }).join('');
    if (answers.length) text += `## Ранее записанные ответы человека\n\n${answers.join('\n')}\n`;
  }
  const cut = text.search(RUN_2_HEADING);
  let head = cut < 0 ? text : text.slice(0, cut);
  let tail = cut < 0 ? '' : text.slice(cut);
  let resolvedRun1Pending = 0;
  let resolvedPending = 0;
  if (f.run === 1) {
    const replacements: Array<[string, string | undefined]> = [
      [RUN_1_PENDING.checks, f.checks],
      [RUN_1_PENDING.verdict, f.verdict === undefined ? undefined : f.verdict === 'ready' ? 'готова' : 'не готова'],
    ];
    for (const [pending, value] of replacements) {
      if (value !== undefined && head.includes(pending)) {
        head = head.replaceAll(pending, value);
        resolvedRun1Pending++;
      }
    }
  }
  if (f.run === 2) {
    const replacements: Array<[string, string | undefined]> = [
      [RUN_2_PENDING.date, f.date],
      [RUN_2_PENDING.checks, f.checks],
      [RUN_2_PENDING.verdict, f.verdict === undefined ? undefined : f.verdict === 'ready' ? 'готова' : 'не готова'],
    ];
    for (const [pending, value] of replacements) {
      if (value !== undefined && tail.includes(pending)) {
        tail = tail.replaceAll(pending, value);
        resolvedPending++;
      }
    }
  }
  const part = (chunk: string, ownRun: boolean) =>
    fillMechanicalPlaceholders(chunk, (inner, line) => {
      if (inner === 'название витка') return f.title;
      if (inner === 'дата' && ownRun) return f.date;
      if (ownRun && line.includes('**Проверки:**')) return f.checks ?? RUN_1_PENDING.checks;
      if (ownRun && line.includes('**Вердикт прогона') && f.verdict !== undefined) {
        return f.verdict === 'ready' ? 'готова' : 'не готова';
      }
      if (ownRun && line.includes('**Вердикт прогона')) return RUN_1_PENDING.verdict;
      if (!ownRun && f.run === 1) {
        if (inner === 'дата') return RUN_2_PENDING.date;
        if (line.includes('**Проверки:**')) return RUN_2_PENDING.checks;
        if (line.includes('**Вердикт прогона')) return RUN_2_PENDING.verdict;
      }
      return null;
    });
  const a = part(head, f.run === 1);
  const b = part(tail, f.run === 2);
  let own = f.run === 1 ? a.text : b.text;
  let refreshed = 0;
  for (const [label, value] of [
    ['Проверки', f.checks],
    [`Вердикт прогона ${f.run}`, f.verdict === undefined ? undefined : f.verdict === 'ready' ? 'готова' : 'не готова'],
  ]) {
    if (value === undefined) continue;
    const replaced = replaceAfterLabel(own, label!, value);
    if (replaced !== null && replaced !== own) { own = replaced; refreshed++; }
  }
  return {
    text: f.run === 1 ? own + b.text : a.text + own,
    filled: a.filled + b.filled + resolvedRun1Pending + resolvedPending + refreshed,
  };
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
  /** Номер витка по этой задаче — число секций «## Виток» в handoff (эта — последняя). */
  loop: number;
  /** Дата секции витка — сегодня. */
  date: string;
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
    // Заголовок секции витка «## Виток ‹K› — ‹дата›»: номер и дата — факты рантайма.
    if (line.trimStart().startsWith('## Виток')) {
      if (inner === 'K') return String(f.loop);
      if (inner === 'дата') return f.date;
    }
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
