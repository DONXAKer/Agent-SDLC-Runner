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

const flat = (text: string, max: number): string => {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

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

export function createProgressPrinter(o: ProgressOptions): (e: RunEvent) => void {
  const write = o.write ?? ((line: string) => console.log(line));
  const now = o.now ?? (() => new Date());
  const stamp = (): string => now().toTimeString().slice(0, 8);
  /** Запросы и пик контекста текущего этапа — для строки итога этапа. */
  let requests = 0;
  let peak = 0;
  const denied = new Set<string>();

  return (e) => {
    switch (e.type) {
      case 'stage_started':
        requests = 0;
        peak = 0;
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
        requests += 1;
        const input = e.usage.inputTokens;
        if (input === 0) {
          write(`  · запрос ${requests}: сервер не прислал usage`);
          return;
        }
        peak = Math.max(peak, input);
        write(`  · запрос ${requests}: контекст ${contextLine(input, o.contextWindowFor(e.stage))}, ответ ${num(e.usage.outputTokens)}`);
        return;
      }
      case 'model_exchange': {
        // Вопрос — первой непустой строкой (что спрашивали), ответ — как есть, с отступом:
        // по нему видно, чем модель заполнила поле и почему оно могло остаться пустым.
        const head = e.question.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
        write(`  ? ${flat(head, 160)}`);
        const answer = e.answer.length > EXCHANGE_ANSWER_PRINT ? `${e.answer.slice(0, EXCHANGE_ANSWER_PRINT)}…` : e.answer;
        const lines = answer.trim() === '' ? ['(пустой ответ)'] : answer.trimEnd().split('\n');
        for (const line of lines) write(`    │ ${line}`);
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
