/**
 * Субагенты этапов, прочитанные с диска.
 *
 * Методология требует независимости в двух местах, и оба держатся на том, что субагент —
 * отдельный прогон с отдельными правами, а не обещание в промпте:
 *
 *  - `sdlc-locator` (этап 5) читает файлы плана и не имеет инструментов записи по
 *    построению — «права выдаются на шаг, а не на прогон»;
 *  - `sdlc-reviewer` (этап 6) получает четыре артефакта и diff, но не рассказ исполнителя,
 *    и работает на модели не слабее — «автор не рецензирует себя».
 *
 * Определения читаются из каталога эталона, а не копируются в рантайм: правка методологии
 * доезжает сюда без релиза.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { SubagentDef } from './StageExecutor.ts';

/** Разбирает YAML-шапку агента Claude Code: name, description, tools, model. */
export function parseAgentFile(text: string): Omit<SubagentDef, 'name'> & { name: string | null } {
  let front = '';
  let body = text.trim();

  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) {
      front = text.slice(3, end);
      const nl = text.indexOf('\n', end + 1);
      body = nl < 0 ? '' : text.slice(nl + 1).trim();
    }
  }

  const field = (key: string): string | null => {
    const m = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi').exec(front);
    return m === null ? null : (m[1] ?? '').trim().replace(/^["']|["']$/g, '');
  };

  const toolsRaw = field('tools');
  return {
    name: field('name'),
    description: field('description') ?? '',
    prompt: body,
    tools:
      toolsRaw === null
        ? []
        : toolsRaw
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t !== ''),
    model: field('model'),
  };
}

/**
 * `null` — файла нет. Это не молчаливая деградация: вызывающий обязан сказать оператору,
 * что этап пойдёт без независимого агента, потому что «Ревью независимым агентом» входит
 * в минимальную пятёрку гейтов.
 */
export function loadSubagent(agentsDir: string, name: string): SubagentDef | null {
  const file = join(agentsDir, `${name}.md`);
  if (!existsSync(file)) return null;
  const parsed = parseAgentFile(readFileSync(file, 'utf8'));
  return {
    name: parsed.name ?? name,
    description: parsed.description,
    prompt: parsed.prompt,
    tools: parsed.tools,
    model: parsed.model,
  };
}

export function loadSubagents(agentsDir: string, names: readonly string[]): {
  agents: SubagentDef[];
  missing: string[];
} {
  const agents: SubagentDef[] = [];
  const missing: string[] = [];
  for (const n of names) {
    const a = loadSubagent(agentsDir, n);
    if (a === null) missing.push(n);
    else agents.push(a);
  }
  return { agents, missing };
}
