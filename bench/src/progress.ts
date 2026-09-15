/**
 * Живой ход прогона в консоль: какой этап идёт, какие операции, какие ветки решений рантайма
 * и сколько контекста занято.
 *
 * Прогон bench молчал от шапки профиля до итоговой сводки — часами, и понять, что делается,
 * можно было только чтением ленты событий в рабочей копии. Печать — ещё один подписчик того
 * же потока событий, что коллектор (`createCollector.onEvent`): своего учёта не заводит и в
 * результат ничего не пишет.
 */

import type { NormalizedCall, RunEvent, StageId } from '@sdlc-runner/shared';

export interface ProgressOptions {
  /** Окно контекста маршрута этапа; `undefined` — не задано в конфиге. */
  contextWindowFor: (stage: StageId) => number | undefined;
  /** Id модели маршрута этапа — для заголовка этапа. */
  routeFor: (stage: StageId) => string;
  write?: (line: string) => void;
  now?: () => Date;
}

/** Обрезка по длине без разреза суррогатной пары: одиночный суррогат в логе читался «�». */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const code = s.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return `${s.slice(0, end)}…`;
}

const flat = (text: string, max: number): string => clip(text.replace(/\s+/g, ' ').trim(), max);

const num = (n: number): string => n.toLocaleString('ru-RU');

const baseName = (path: string): string => path.split(/[\\/]/).slice(-2).join('/');

/** Вызов одной строкой — только поля, по которым видно, что именно делается. */
export function describeCall(call: NormalizedCall, toolName: string): string {
  switch (call.kind) {
    case 'read':
    case 'write':
    case 'edit':
      return `${toolName} ${call.path}`;
    case 'glob':
    case 'grep':
      return `${toolName} ${call.pattern}${call.path === null ? '' : ` в ${call.path}`}`;
    case 'bash':
      return `Bash ${flat(call.command, 120)}`;
    case 'ask_human':
      return `AskHuman (${call.questions.length}): ${flat(call.questions[0]?.question ?? '', 120)}`;
    case 'subagent':
      return `субагент ${call.agent}`;
    case 'finalize_artifact':
      return `FinalizeArtifact ${call.artifact}`;
    case 'request_scope_extension':
      return `расширение плана: ${call.path}`;
    default:
      return toolName;
  }
}

/** Доля окна: «12 345 / 32 768 (38%)» либо «12 345 (окно не задано)». */
export function contextLine(tokens: number, window: number | undefined): string {
  if (window === undefined || window <= 0) return `${num(tokens)} (окно не задано)`;
  return `${num(tokens)} / ${num(window)} (${Math.round((tokens / window) * 100)}%)`;
}

/** Сколько символов ответа модели печатать: лог читает человек, полный ответ — в ленте событий. */
const EXCHANGE_ANSWER_PRINT = 1500;

/**
 * О чём спросили — одной-двумя строками вместо всей карточки. Первая строка карточки у
 * дозаполнения всегда одна и та же («## Сейчас — ровно одно поле»), и лог из одинаковых
 * заголовков не говорил, какое поле спрашивали: предмет — id поля (карточка компактной
 * формы), иначе первая строка бланка из блока кода, иначе заголовок.
 */
export function exchangeSubject(question: string): { title: string; detail: string | null } {
  const lines = question.split('\n').map((l) => l.trim());
  const heading = lines.find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '').replace(/^Сейчас\s+—\s+/, '') ?? '';
  const title = heading === '' ? flat(lines.find((l) => l !== '') ?? '', 160) : flat(heading, 160);
  const id = /^-\s*id:\s*`([^`]+)`/.exec(lines.find((l) => /^-\s*id:/.test(l)) ?? '')?.[1];
  if (id !== undefined) return { title, detail: `поле ${id}` };
  const fence = lines.findIndex((l) => l.startsWith('```'));
  const blank = fence < 0 ? undefined : lines.slice(fence + 1).find((l) => l !== '' && !l.startsWith('```'));
  return { title, detail: blank === undefined || blank === heading ? null : `бланк: ${flat(blank, 200)}` };
}

/**
 * Markdown-таблица в ответе — списком: строка таблицы с десятком колонок в консоли
 * растягивалась на экраны и не читалась. Первая ячейка строки — пункт списка, остальные —
 * «колонка: значение» под ним. Прочий текст остаётся как есть.
 */
export function tablesAsLists(text: string): string[] {
  const cells = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const isRow = (line: string): boolean => line.trim().startsWith('|');
  const isSeparator = (line: string): boolean => /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-');

  const src = text.split('\n');
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!;
    const next = src[i + 1];
    if (!(isRow(line) && next !== undefined && isSeparator(next))) {
      out.push(line);
      continue;
    }
    const header = cells(line);
    i += 1;
    while (i + 1 < src.length && isRow(src[i + 1]!)) {
      i += 1;
      const row = cells(src[i]!);
      out.push(`• ${row[0] === '' || row[0] === undefined ? '(без первой ячейки)' : row[0]}`);
      for (let c = 1; c < row.length; c++) {
        if (row[c] === '') continue;
        out.push(`    ${header[c] === undefined || header[c] === '' ? `колонка ${c + 1}` : header[c]}: ${row[c]}`);
      }
    }
  }
  return out;
}

export function createProgressPrinter(o: ProgressOptions): (e: RunEvent) => void {
  const write = o.write ?? ((line: string) => console.log(line));
  const now = o.now ?? (() => new Date());
  const stamp = (): string => now().toTimeString().slice(0, 8);
  /** Запросы и пик контекста текущего этапа — для строки итога этапа. */
  let requests = 0;
  let peak = 0;
  /** Обмены «запрос → ответ» текущего этапа — нумерация блоков в логе. */
  let exchanges = 0;
  const denied = new Set<string>();

  return (e) => {
    switch (e.type) {
      case 'stage_started':
        requests = 0;
        peak = 0;
        exchanges = 0;
        write(
          `\n▶ ${stamp()} ${e.stage} — ${o.routeFor(e.stage)} (chunk ${e.chunk}, попытка ${e.attempt}, ` +
            `окно ${o.contextWindowFor(e.stage) === undefined ? 'не задано' : num(o.contextWindowFor(e.stage)!)})`,
        );
        return;
      case 'prompt_prepared': {
        const chars = e.prompt.system.length + e.prompt.user.length;
        write(`  промпт этапа ≈${num(Math.ceil(chars / 4))} ток. (system ${num(e.prompt.system.length)} + user ${num(e.prompt.user.length)} симв.)`);
        return;
      }
      case 'usage': {
        // Расход мимо исполнителя этапа (рецензент, ансамбль, доборы — другой маршрут и другое
        // окно) — отдельной строкой: в запросы этапа и в пик его контекста он не идёт, иначе
        // итог этапа показывал «183% окна» чужой модели.
        if (e.offPath === true) {
          write(`  · токены вне хода этапа: вход ${num(e.usage.inputTokens)}, ответ ${num(e.usage.outputTokens)}`);
          return;
        }
        requests += 1;
        const input = e.usage.inputTokens;
        // Расход — отдельной строкой «токены», а не «запрос»: запросы дозаполнения идут пачками
        // параллельно, и строки расхода с блоками «ЗАПРОС/ОТВЕТ» по порядку не совпадают.
        if (input === 0) {
          write(`  · токены №${requests}: сервер не прислал usage`);
          return;
        }
        peak = Math.max(peak, input);
        write(`  · токены №${requests}: контекст ${contextLine(input, o.contextWindowFor(e.stage))}, ответ ${num(e.usage.outputTokens)}`);
        return;
      }
      case 'model_exchange': {
        // Блок: что спросили (предмет вопроса, не вся карточка) и что модель ответила — по
        // ответу видно, чем заполнено поле и почему оно могло остаться пустым.
        exchanges += 1;
        const subject = exchangeSubject(e.question);
        write(`  ┌ ЗАПРОС №${exchanges} · ${e.stage} · ${subject.title}`);
        if (subject.detail !== null) write(`  │   ${subject.detail}`);
        write('  ├ ОТВЕТ');
        const listed = tablesAsLists(e.answer.trimEnd()).join('\n');
        const answer = clip(listed, EXCHANGE_ANSWER_PRINT);
        const lines = answer.trim() === '' ? ['(пустой ответ)'] : answer.split('\n');
        for (const line of lines) write(`  │   ${line}`);
        write('  └');
        return;
      }
      case 'assistant_text':
        write(`  ‹ ${flat(e.text, 600)}`);
        return;
      case 'tool_request':
        if (!e.policy.ok) {
          denied.add(e.requestId);
          write(`  → ${describeCall(e.call, e.toolName)}  ✗ политика [${e.policy.policy}]: ${flat(e.policy.reason, 200)}`);
          return;
        }
        write(
          `  → ${describeCall(e.call, e.toolName)}` +
            (e.destructive === null ? '' : `  ⚠ ${flat(e.destructive, 160)}`) +
            (e.repaired === undefined ? '' : `  🩹 ${flat(e.repaired, 160)}`),
        );
        return;
      case 'tool_resolved':
        if (e.decision.allowed || denied.has(e.requestId)) return;
        write(
          e.cancelled === true
            ? `    снят обрывом: ${flat(e.decision.reason, 200)}`
            : `    ✗ отклонено (${e.decision.by}): ${flat(e.decision.reason, 200)}`,
        );
        return;
      case 'tool_result':
        if (!e.ok) write(`    ✗ ${flat(e.summary, 200)}`);
        return;
      case 'artifact_written':
        write(`  ✎ ${baseName(e.path)} — незаполненных мест: ${e.placeholders}`);
        return;
      case 'gate_result':
        write(`  ▣ гейт «${e.gate.name}»: ${e.gate.status}${e.gate.lastLine === '' ? '' : ` — ${flat(e.gate.lastLine, 160)}`}`);
        return;
      case 'verdict':
        write(`  ⚖ вердикт: ${e.verdict.action}${e.verdict.passed ? ' (passed)' : ''}`);
        return;
      case 'warning':
        write(`  ⚠ ${flat(e.message, 400)}`);
        return;
      case 'error':
        write(`  ✖ ${flat(e.message, 400)}`);
        return;
      case 'stage_done':
        write(
          `■ ${stamp()} ${e.stage} ${e.ok ? '✅' : '❌'} — запросов к модели ${requests}` +
            (peak === 0 ? '' : `, пик контекста ${contextLine(peak, o.contextWindowFor(e.stage))}`) +
            ` — ${flat(e.note, 300)}`,
        );
        return;
      case 'run_finished':
        write(`\n■ ${stamp()} виток завершён ${e.ok ? '✅' : '❌'} — ${flat(e.note, 300)}`);
        return;
      default:
        return;
    }
  };
}
