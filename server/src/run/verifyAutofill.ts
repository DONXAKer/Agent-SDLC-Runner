/**
 * Автозаполнение отчёта приёмки фактами рантайма — ДО модели-рецензента.
 *
 * Два класса фактов, оба не знания модели:
 *  - механические поля шапки (номер chunk'а, попытка, слаг, бюджет попыток) — общей
 *    механикой `fillMechanicalPlaceholders` (см. journalAutofill.ts);
 *  - таблица «Гейты»: статусы и результаты фактического прогона `runVerifyGates`.
 *    Замер серии r9 (`docs/model-runs.md`): дешёвый рецензент-«оформитель» (gpt-oss-20b)
 *    дал 4 расхождения отчёта с фактом — все в переписанной от себя таблице гейтов.
 *    Таблицу, которую рантайм прогнал сам, он и заполняет сам: расхождений «отчёт/факт»
 *    в ней не бывает по построению, модели остаются выводы и ревью.
 *
 * Строка «Ревью независимым агентом» НЕ заполняется: на момент автозаполнения рецензент
 * ещё не запускался, и вписать туда пред-стартовый статус значило бы солгать в обе стороны.
 */

import type { GateRunResult, Verdict, VerdictAction } from '@sdlc-runner/shared';

import { gateKey } from '../gates/gatesFile.ts';
import { escapeCell, splitRow } from '../md/table.ts';
import { fillMechanicalPlaceholders } from './journalAutofill.ts';

/**
 * Границы первой таблицы после строки-заголовка: `[начало, конец)` в массиве строк.
 * `null` — заголовка нет или таблицы под ним нет.
 *
 * Одна функция на оба шага автозаполнения. Правило «до первой не-табличной строки»
 * выучено дорого (ревью К3: диапазон «до следующего заголовка» накрывал таблицу
 * неприменимости и затирал начатую человеком строку), и жить в двух копиях с чуть
 * разными регэкспами заголовка оно не должно — вторая копия уже отличалась обработкой
 * отступа.
 */
function tableRange(lines: readonly string[], heading: RegExp): { from: number; to: number } | null {
  const head = lines.findIndex((l) => heading.test(l.trim()));
  if (head < 0) return null;
  let from = head + 1;
  while (from < lines.length && !lines[from]!.trimStart().startsWith('|')) {
    if (/^#{2,3}\s/.test(lines[from]!.trim())) return null;
    from++;
  }
  let to = from;
  while (to < lines.length && lines[to]!.trimStart().startsWith('|')) to++;
  return to > from ? { from, to } : null;
}

export interface VerifyReportFacts {
  chunk: number;
  attempt: number;
  slug: string;
  attemptBudget: number;
  /**
   * Статус гейтов РАННИХ этапов, которые рантайм посчитал сам (сегодня — «Разбор
   * последствий» этапа 4). Имя гейта → статус и адрес артефакта, где он виден.
   *
   * Переносится рантаймом по той же причине, по которой он заполняет таблицу гейтов
   * этапа 6: статус, который программа знает своими глазами, не отдаётся модели на
   * пересказ. Пока строку писала модель, включённый гейт, отработавший зелёным на этапе 4,
   * терялся в отчёте — и `enabledGatesMissingFromReport` ронял вердикт за чужую забывчивость
   * (ревью).
   */
  earlyGates?: readonly { name: string; stage: string; status: string; seenIn: string }[];
  /**
   * Включённые гейты ранних этапов, статуса которых у рантайма НЕТ, — их по-прежнему
   * переносит модель.
   *
   * Поле нужно ровно для строки-образца: пока автозаполнение удаляло её всегда, отчёт
   * оставался без единого примера, модель остальные ранние гейты не добавляла, и
   * `enabledGatesMissingFromReport` ронял вердикт за них (ревью, воспроизведено сквозным
   * прогоном на наборе с двумя ранними гейтами).
   */
  earlyGatesForModel?: readonly string[];
  /**
   * Включённые гейты этапа 6, статус которых рантайм на момент автозаполнения не знает
   * (сегодня — «Ревью независимым агентом»: рецензент ещё не запускался). При
   * развороте строки-образца для них остаётся строка с плейсхолдерами — модели.
   */
  gatesForModel?: readonly string[];
  /** Гейты, статус которых ставит рантайм без прогона команды (сверка отчёта с набором). */
  runtimeGateRows?: readonly { name: string; status: string; result: string }[];
}

/** Первая ячейка строки — целиком место формы (`‹имя из набора›`): строка-образец. */
function isSampleNameCell(name: string): boolean {
  return /^‹[^‹›]*›$/.test(name.trim());
}

/** Однострочная ячейка таблицы: переносы и вертикальные черты в ней жить не могут. */
function cellSafe(text: string, max = 240): string {
  const one = text.replace(/\s*\r?\n\s*/g, '; ').replace(/\|/g, '∣').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

function resultCell(r: GateRunResult): string {
  const parts = [
    r.command ?? 'встроенная реализация',
    ...(r.exitCode === null ? [] : [`код ${r.exitCode}`]),
    ...(r.durationMs > 0 ? [`${(r.durationMs / 1000).toFixed(1)}с`] : []),
    r.lastLine,
  ];
  return cellSafe(parts.join(' · '));
}

/** Первая ячейка markdown-строки таблицы — через общий `splitRow` (знает про `\|`). */
function firstCell(line: string): string | null {
  if (!line.trimStart().startsWith('|')) return null;
  return splitRow(line)[0] ?? null;
}

/**
 * Заполняет отчёт приёмки: механические плейсхолдеры шапки и строки таблицы «Гейты» по
 * фактам прогона. Идемпотентно — заполненное плейсхолдером быть перестаёт. Гейты, которым
 * рантайм статуса не давал (ревью, чужие имена), не трогаются.
 */
export function autofillVerificationReport(
  text: string,
  gates: readonly GateRunResult[],
  f: VerifyReportFacts,
): { text: string; filled: number } {
  let filled = 0;

  // Шаг 1: ПЕРВАЯ таблица после «## Гейты» — и только она. Граница «до следующего
  // заголовка» накрывала и таблицу неприменимости (между ними заголовка нет), и строка
  // неприменимости с настоящим именем гейта переписывалась в строку статуса — колонка
  // «Утвердил (человек)» уничтожалась рантаймом (ревью, К3/К5). Первая таблица кончается
  // на первой не-табличной строке, дальше не смотрим. Принятый риск (ревью-2): граница
  // держится на пустой строке/прозе штатного шаблона между таблицами; автозаполнение
  // идёт ДО модели по бланку рантайма, где это гарантировано, — слипшиеся таблицы из-под
  // пера модели сюда не попадают.
  const byKey = new Map(gates.map((g) => [gateKey(g.name), g]));
  const used = new Set<string>();
  const lines = text.split('\n');
  // Границы таблицы — общей `tableRange`: то же правило, что у шага 1б ниже.
  const gatesTable = tableRange(lines, /^##\s+Гейты\s*$/);
  if (gatesTable !== null) {
    const tableStart = gatesTable.from;
    const tableEnd = gatesTable.to;

    for (let j = tableStart; j < tableEnd; j++) {
      const line = lines[j]!;
      const name = firstCell(line);
      if (name === null || !line.includes('‹') || isSampleNameCell(name)) continue;
      const r = byKey.get(gateKey(name));
      if (r === undefined) continue;
      // Черта в имени экранируется обратно: splitRow её разэкранировал, и пересборка без
      // `\|` ломала бы колонки строки (ревью-2; имён с чертой в эталоне нет — страховка).
      lines[j] = `| ${escapeCell(name)} | ${r.status} | ${resultCell(r)} |`;
      used.add(gateKey(name));
      filled++;
    }
    // Строка-образец разворачивается в фактические строки оставшихся прогнанных гейтов —
    // либо убирается: образец не отчёт. Образец узнаётся по первой ячейке-плейсхолдеру, а
    // не по тексту шаблона: актуальная форма эталона — одна строка `‹имя из набора›`, а
    // код ждал старую `‹прочий включённый гейт…›` и на актуальном шаблоне не заполнял
    // таблицу вовсе (code-review-all 2026-09-23). Гейтам, статуса которых у рантайма ещё
    // нет (ревью), остаётся строка модели.
    const otherIdx = lines.findIndex((l, k) => {
      if (k < tableStart || k >= tableEnd) return false;
      const name = firstCell(l);
      return name !== null && (isSampleNameCell(name) || l.includes('‹прочий включённый гейт'));
    });
    if (otherIdx >= 0) {
      const rest = gates.filter((g) => !used.has(gateKey(g.name)));
      const forModel = (f.gatesForModel ?? []).filter(
        (n) => !used.has(gateKey(n)) && !gates.some((g) => gateKey(g.name) === gateKey(n)),
      );
      lines.splice(
        otherIdx,
        1,
        // Черта в имени экранируется и здесь — та же страховка, что у именованных строк.
        ...rest.map((r) => `| ${escapeCell(r.name)} | ${r.status} | ${resultCell(r)} |`),
        ...(f.runtimeGateRows ?? [])
          .filter((g) => !used.has(gateKey(g.name)) && !gates.some((r) => gateKey(r.name) === gateKey(g.name)))
          .map((g) => `| ${escapeCell(g.name)} | ${g.status} | ${cellSafe(g.result)} |`),
        ...forModel.map((n) => `| ${escapeCell(n)} | ‹✅/❌/⏭› | ‹фактический результат› |`),
      );
      filled += rest.length > 0 ? rest.length : 1;
    }
  }

  // Шаг 1б: таблица «Гейты ранних этапов» — строки, чей статус рантайм посчитал сам.
  // Строка-образец разворачивается в фактические; уже стоящая строка того же гейта
  // переписывается фактом (модель могла вписать своё мнение до автозаполнения).
  const early = f.earlyGates ?? [];
  if (early.length > 0) {
    const range = tableRange(lines, /^###\s+Гейты ранних этапов\s*$/);
    if (range !== null) {
      const i = range.from;
      const end = range.to;
      {
        const rendered = early.map(
          (g) => `| ${escapeCell(g.name)} | ${g.stage} | ${g.status} | ${escapeCell(g.seenIn)} |`,
        );
        // Образец сохраняется, пока в наборе остаются ранние гейты, которых рантайм не
        // считает: без него модели неоткуда взять форму строки, а отчитаться за них
        // обязана она.
        const keepSample = (f.earlyGatesForModel ?? []).length > 0;
        const keep: string[] = [];
        for (let j = i; j < end; j++) {
          const line = lines[j]!;
          const name = firstCell(line);
          const isSample = line.includes('‹гейт›');
          const known = name !== null && early.some((g) => gateKey(g.name) === gateKey(name));
          if (isSample ? keepSample : !known) keep.push(line);
        }
        const before = lines.slice(i, end).join('\n');
        const after = [...keep, ...rendered].join('\n');
        if (before !== after) {
          lines.splice(i, end - i, ...keep, ...rendered);
          // Идемпотентность: повторный вызов на уже заполненном отчёте не должен
          // объявлять работу заново — на это опирается ансамбль, стартующий с прежнего
          // бланка.
          filled += rendered.length;
        }
      }
    }
  }

  // Шаг 2: механические плейсхолдеры шапки и вердикта — общей механикой (та же, что у
  // журнала chunk'а: с конца, строки решений человека не трогаются).
  const mech = fillMechanicalPlaceholders(lines.join('\n'), (inner) =>
    inner === 'N'
      ? String(f.chunk)
      : inner === 'K'
        ? String(f.attempt)
        : inner === 'название витка'
          ? f.slug
          : inner === 'бюджет'
            ? String(f.attemptBudget)
            : null,
  );

  return { text: mech.text, filled: filled + mech.filled };
}

/** Строка поля секции «Вердикт»: `- **passed:** …` — маркер списка и жирность прощаются. */
function verdictFieldRe(label: string): RegExp {
  return new RegExp(`^(\\s*[-*]\\s*[*_]*${label}[*_]*\\s*:\\s*[*_]*\\s*)(.*)$`, 'i');
}

/**
 * Вердикт, посчитанный рантаймом, — в секцию «Вердикт» отчёта приёмки.
 *
 * Прежде вердикт жил только в памяти и `iterations.md`, а handoff и восстановление
 * попытки после рестарта читают ОТЧЁТ: строка бланка `- **passed:** true / false`
 * проходила проверку «передача разрешена», и handoff (с коммитом) открывался на
 * незаполненном отчёте, а после рестарта зелёный виток терял свою попытку
 * (code-review-all 2026-09-23). Поля `passed`/`action` объявлены за рантаймом
 * (`formSchema.ts`) — пишет их только он.
 */
export function writeVerdictSection(text: string, verdict: Verdict): { text: string; changed: boolean } {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^##\s+Вердикт\s*$/i.test(l.trim()));
  if (head === -1) return { text, changed: false };
  let end = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  const values: [RegExp, string][] = [
    [verdictFieldRe('passed'), verdict.passed ? 'true' : 'false'],
    [verdictFieldRe('action'), verdict.passed ? 'continue' : verdict.action],
    [verdictFieldRe('По каким условиям упал'), verdict.reasons.length === 0 ? 'н/п' : verdict.reasons.join('; ')],
  ];
  let changed = false;
  for (let i = head + 1; i < end; i++) {
    const line = lines[i]!;
    const cr = line.endsWith('\r') ? '\r' : '';
    const bare = cr === '' ? line : line.slice(0, -1);
    for (const [re, value] of values) {
      const m = re.exec(bare);
      if (m === null) continue;
      const next = `${m[1]!}${value}${cr}`;
      if (next !== line) {
        lines[i] = next;
        changed = true;
      }
      break;
    }
  }
  return { text: lines.join('\n'), changed };
}

/**
 * Вердикт из отчёта приёмки: `passed`/`failed` — строка `passed:` несёт ОДНО значение;
 * `null` — бланк (`true / false`), плейсхолдер или нет строки. Один читатель на handoff и
 * восстановление попытки после рестарта.
 */
export function readReportVerdict(text: string): 'passed' | 'failed' | null {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*>\s]*[*_]*passed[*_]*\s*[:=]\s*[*_]*\s*(.*?)\s*[*_]*\s*$/i.exec(raw);
    if (m === null) continue;
    const value = (m[1] ?? '').trim().toLowerCase();
    if (value === 'true') return 'passed';
    if (value === 'false') return 'failed';
  }
  return null;
}

/** `action` вердикта из отчёта приёмки — одно значение словаря; бланк и прочее — `null`. */
export function readReportAction(text: string): VerdictAction | null {
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*[-*>\s]*[*_]*action[*_]*\s*[:=]\s*[*_]*\s*(.*?)\s*[*_]*\s*$/i.exec(raw);
    if (m === null) continue;
    const value = (m[1] ?? '').trim().toLowerCase();
    if (value === 'continue' || value === 'retry' || value === 'escalate' || value === 'blocked_env') return value;
  }
  return null;
}
