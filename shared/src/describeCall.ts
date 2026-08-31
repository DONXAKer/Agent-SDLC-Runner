import type { NormalizedCall } from './types.ts';

/**
 * Как вызов инструмента называется в журнале и в панели одобрений.
 *
 * Одна реализация на сервер и UI: две редакции этой функции разошлись в тексте за один
 * коммит, а свитч без `default` на вебе при добавлении нового вида вызова возвращал бы
 * `undefined` — оператор перестал бы видеть, что делает агент, ровно в том единственном
 * месте, ради которого сервис существует. Здесь свитч исчерпывающий по типу, и пропуск
 * нового вида — ошибка компиляции.
 */
export function describeCall(call: NormalizedCall): string {
  switch (call.kind) {
    case 'read': {
      const range =
        call.range === null
          ? ''
          : ` [${call.range.from}–${call.range.to ?? 'конец'}]`;
      return `Read ${call.path}${range}`;
    }
    case 'glob':
      return `Glob ${call.pattern}`;
    case 'grep':
      return `Grep /${call.pattern}/`;
    case 'write':
      return `Write ${call.path} (${call.content.length} симв.)`;
    case 'edit':
      return `Edit ${call.path} (${call.edits.length} правк.)`;
    case 'bash':
      return `Bash ${firstLine(call.command)}`;
    case 'ask_human':
      return `Вопрос человеку (${call.questions.length})`;
    case 'finalize_artifact':
      return `Финализация ${call.artifact}`;
    case 'subagent':
      return `Субагент ${call.agent}`;
    case 'request_scope_extension':
      return `Расширить scope: ${call.path} (${call.reason})`;
    case 'record_claim':
      return `Пункт приёмки ${call.id}: ${call.status}`;
    case 'record_finding':
      return `Находка (${call.section}): ${firstLine(call.text)}`;
    case 'mcp':
      return `MCP ${call.server}.${call.tool} ${firstLine(JSON.stringify(call.args))}`;
    case 'unknown':
      return `Неизвестный инструмент ${call.toolName}`;
  }
}

/** Заголовок карточки одобрения — короче, чем строка журнала. */
export function callTitle(call: NormalizedCall): string {
  switch (call.kind) {
    case 'write':
      return `Записать ${call.path}`;
    case 'edit':
      return `Изменить ${call.path}`;
    case 'bash':
      return 'Выполнить команду';
    case 'finalize_artifact':
      return `Финализировать ${call.artifact}`;
    case 'subagent':
      return `Запустить субагента ${call.agent}`;
    case 'mcp':
      return `Сервер ${call.server} · ${call.tool}`;
    case 'unknown':
      return `Неизвестный инструмент ${call.toolName}`;
    default:
      return describeCall(call);
  }
}

function firstLine(s: string): string {
  const line = s.split('\n')[0] ?? '';
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}
