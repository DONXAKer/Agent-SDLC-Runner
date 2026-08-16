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

import type { CallKind, EditOp, NormalizedCall, Question } from '@sdlc-runner/shared';

/** Инструменты, которые рантайм подаёт через MCP во флоу `sdk`. */
const MCP_PREFIX = 'mcp__sdlc__';

/**
 * Map, а не объектный литерал: у литерала есть прототип, и инструмент с именем `toString`
 * или `constructor` возвращал функцию вместо `undefined`. Тогда ни одна ветка switch не
 * срабатывала, `normalize` отдавал `undefined`, и политика падала с TypeError вместо
 * отказа по худшему случаю — то есть ровно наоборот к заявленному принципу.
 */
const NAME_TO_KIND = new Map<string, CallKind>([
  ['Read', 'read'],
  ['Glob', 'glob'],
  ['Grep', 'grep'],
  ['Write', 'write'],
  ['Edit', 'edit'],
  ['MultiEdit', 'edit'],
  ['Bash', 'bash'],
  ['AskHuman', 'ask_human'],
  ['ask_human', 'ask_human'],
  ['FinalizeArtifact', 'finalize_artifact'],
  ['finalize_artifact', 'finalize_artifact'],
  ['Task', 'subagent'],
  ['Agent', 'subagent'],
]);

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

/**
 * Разбор правок. `null` — набор битый целиком.
 *
 * Некорректный элемент раньше молча выбрасывался, и пачка из трёх правок применялась
 * двумя: модель получала «применено» и считала, что прошли все три. Это ровно тот
 * частично применённый набор, от которого `editTool` защищается своим «ни одна правка не
 * применена» — защита обходилась на уровень выше, в нормализации.
 */
function editsOf(input: Record<string, unknown>): EditOp[] | null {
  const raw = input['edits'];
  if (Array.isArray(raw)) {
    const out: EditOp[] = [];
    for (const e of raw) {
      if (typeof e !== 'object' || e === null) return null;
      const r = e as Record<string, unknown>;
      const oldStr = str(r, 'old_string', 'oldString');
      const newStr = str(r, 'new_string', 'newString');
      if (oldStr === null || newStr === null) return null;
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
  const kind = NAME_TO_KIND.get(name);

  if (kind === undefined) return { kind: 'unknown', toolName, raw: input };

  switch (kind) {
    case 'read': {
      const path = str(input, 'file_path', 'path', 'filePath');
      if (path === null) return { kind: 'unknown', toolName, raw: input };
      const offset = num(input, 'offset');
      const limit = num(input, 'limit');
      if (offset === null && limit === null) return { kind: 'read', path, range: null };

      const from = Math.max(1, offset ?? 1);
      // `offset` без `limit` — это «отсюда и до конца файла», как в Claude Code, на
      // семантике которого модель обучена. Пока это давало одну строку, модель после
      // отказа «читай диапазоном» выедала бюджет ходов по строке за ход.
      // Диапазон включающий: `offset=10, limit=5` это строки 10..14, а не 10..15.
      const to = limit === null ? Number.MAX_SAFE_INTEGER : from + Math.max(1, limit) - 1;
      return { kind: 'read', path, range: { from, to } };
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
      // Правка без единой операции — не правка, а набор с битым элементом — не набор.
      // И то и другое пусть политика отклонит как незнакомый вызов, а не пропустит как
      // безобидный.
      if (edits === null || edits.length === 0) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'edit', path, edits };
    }

    case 'bash': {
      const command = str(input, 'command');
      if (command === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'bash', command };
    }

    case 'ask_human':
      return { kind: 'ask_human', questions: questionsOf(input) };

    case 'finalize_artifact': {
      const artifact = str(input, 'artifact', 'file_path', 'path');
      if (artifact === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'finalize_artifact', artifact, note: str(input, 'note') };
    }

    case 'subagent': {
      const agent = str(input, 'subagent_type', 'agent', 'name');
      if (agent === null) return { kind: 'unknown', toolName, raw: input };
      return { kind: 'subagent', agent, prompt: str(input, 'prompt', 'description') ?? '' };
    }

    case 'unknown':
      return { kind: 'unknown', toolName, raw: input };
  }
}
