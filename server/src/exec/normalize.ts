/**
 * Приведение вызова инструмента к `NormalizedCall`.
 *
 * Это единственное место в рантайме, где различия между именами и аргументами инструментов
 * флоу `sdk` и флоу `loop` вообще имеют значение. Дальше по течению — политика доступа,
 * панель одобрений, журнал — видят одну форму, и потому не могут разъехаться.
 *
 * Незнакомый инструмент нормализуется в `unknown`, а не отбрасывается: политика обязана
 * считать его записью по худшему случаю и отклонить, а не пропустить молча.
 */

import type { CallKind, EditOp, NormalizedCall, Question } from '../types.ts';

/** Инструменты, которые рантайм подаёт через MCP во флоу `sdk`. */
const MCP_PREFIX = 'mcp__sdlc__';

const NAME_TO_KIND: Record<string, CallKind> = {
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  Bash: 'bash',
  AskHuman: 'ask_human',
  ask_human: 'ask_human',
  FinalizeArtifact: 'finalize_artifact',
  finalize_artifact: 'finalize_artifact',
};

function str(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

function num(input: Record<string, unknown>, key: string): number | null {
  const v = input[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(input: Record<string, unknown>, key: string): boolean {
  return input[key] === true;
}

function editsOf(input: Record<string, unknown>): EditOp[] {
  const raw = input['edits'];
  if (Array.isArray(raw)) {
    const out: EditOp[] = [];
    for (const e of raw) {
      if (typeof e !== 'object' || e === null) continue;
      const r = e as Record<string, unknown>;
      const oldStr = str(r, 'old_string', 'oldString');
      const newStr = str(r, 'new_string', 'newString');
      if (oldStr === null || newStr === null) continue;
      out.push({ oldStr, newStr, replaceAll: bool(r, 'replace_all') || bool(r, 'replaceAll') });
    }
    return out;
  }

  const oldStr = str(input, 'old_string', 'oldString');
  const newStr = str(input, 'new_string', 'newString');
  if (oldStr === null || newStr === null) return [];
  return [
    { oldStr, newStr, replaceAll: bool(input, 'replace_all') || bool(input, 'replaceAll') },
  ];
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const raw = input['questions'];
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  raw.forEach((q, i) => {
    if (typeof q !== 'object' || q === null) return;
    const r = q as Record<string, unknown>;
    const question = str(r, 'question');
    if (question === null) return;
    const optionsRaw = Array.isArray(r['options']) ? (r['options'] as unknown[]) : [];
    const options = optionsRaw.flatMap((o) => {
      if (typeof o !== 'object' || o === null) return [];
      const or = o as Record<string, unknown>;
      const label = str(or, 'label');
      if (label === null) return [];
      return [{ label, description: str(or, 'description') ?? '' }];
    });
    out.push({
      id: str(r, 'id') ?? `q${i + 1}`,
      question,
      header: str(r, 'header') ?? '',
      multiSelect: bool(r, 'multiSelect'),
      options,
    });
  });
  return out;
}

/** Имя инструмента без транспортного префикса MCP. */
export function baseToolName(toolName: string): string {
  return toolName.startsWith(MCP_PREFIX) ? toolName.slice(MCP_PREFIX.length) : toolName;
}

export function normalize(toolName: string, input: Record<string, unknown>): NormalizedCall {
  const name = baseToolName(toolName);
  const kind = NAME_TO_KIND[name];

  if (kind === undefined) return { kind: 'unknown', toolName, raw: input };

  switch (kind) {
    case 'read': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      const offset = num(input, 'offset');
      const limit = num(input, 'limit');
      const range =
        offset === null && limit === null
          ? null
          : { from: offset ?? 1, to: (offset ?? 1) + (limit ?? 0) };
      return { kind: 'read', path, range };
    }

    case 'glob': {
      const pattern = str(input, 'pattern');
      if (pattern === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'glob', pattern, path: str(input, 'path') };
    }

    case 'grep': {
      const pattern = str(input, 'pattern');
      if (pattern === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'grep', pattern, path: str(input, 'path') };
    }

    case 'write': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'write', path, content: str(input, 'content') ?? '' };
    }

    case 'edit': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      const edits = editsOf(input);
      // Правка без единой операции — не правка. Пусть политика отклонит её как незнакомую,
      // а не пропустит как безобидную.
      if (edits.length === 0) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'edit', path, edits };
    }

    case 'bash': {
      const command = str(input, 'command');
      if (command === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'bash', command, writeTargets: [] };
    }

    case 'ask_human':
      return { kind: 'ask_human', questions: questionsOf(input) };

    case 'finalize_artifact': {
      const artifact = str(input, 'artifact', 'file_path', 'path');
      if (artifact === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'finalize_artifact', artifact, data: input };
    }

    case 'unknown':
      return { kind: 'unknown', toolName, raw: input };
  }
}

/** Короткая строка для журнала и панели: что именно вызвали. */
export function describeCall(call: NormalizedCall): string {
  switch (call.kind) {
    case 'read':
      return `Read ${call.path}`;
    case 'glob':
      return `Glob ${call.pattern}`;
    case 'grep':
      return `Grep /${call.pattern}/`;
    case 'write':
      return `Write ${call.path} (${call.content.length} симв.)`;
    case 'edit':
      return `Edit ${call.path} (${call.edits.length} правк.)`;
    case 'bash':
      return `Bash ${call.command.split('\n')[0] ?? ''}`;
    case 'ask_human':
      return `Вопрос человеку (${call.questions.length})`;
    case 'finalize_artifact':
      return `Финализация ${call.artifact}`;
    case 'unknown':
      return `Неизвестный инструмент ${call.toolName}`;
  }
}
