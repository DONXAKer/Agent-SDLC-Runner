/**
 * Отбор набора MCP-инструментов, который увидит модель.
 *
 * Это не оптимизация, а условие работоспособности. Один только generic-сервер Unreal
 * отдаёт 175 инструментов: их описания со схемами — порядка сорока тысяч токенов, то есть
 * вдвое-втрое больше ВСЕГО контекста локальной модели. Полный список туда не влезает
 * физически, и вопрос не «сколько сэкономить», а «какие двенадцать».
 *
 * Функция чистая: оба флоу получают её результат через `ExecRequest`, а не считают его
 * каждый у себя. Иначе оператор в панели промпта видел бы не то, что уходит в модель.
 */

import type { McpToolRule } from '@sdlc-runner/shared';

import { nameProblem } from './naming.ts';
import type { McpToolInfo } from './types.ts';

export interface Selection {
  tools: McpToolInfo[];
  /** Что и почему не попало в набор — оператору и в предупреждения, не в тишину. */
  dropped: { name: string; why: string }[];
}

function matches(rule: McpToolRule, info: McpToolInfo): boolean {
  if (rule.server !== info.server) return false;
  if (!rule.tool.endsWith('*')) return rule.tool === info.tool;
  return info.tool.startsWith(rule.tool.slice(0, -1));
}

/**
 * Пересечение разрешительного списка с тем, что сервер реально отдал.
 *
 * Правило, под которое не нашлось инструмента, — не ошибка загрузки: конфиг мог отстать
 * от сервера, а сервер мог быть не поднят. Но и молчать нельзя: «инструмента нет» и
 * «инструмент запрещён» выглядят для модели одинаково, а чинятся по-разному.
 */
export function selectTools(
  rules: readonly McpToolRule[],
  available: readonly McpToolInfo[],
  maxInline: number,
): Selection {
  const dropped: { name: string; why: string }[] = [];
  const picked: McpToolInfo[] = [];
  const seen = new Set<string>();

  for (const info of available) {
    if (!rules.some((r) => matches(r, info))) continue;
    if (seen.has(info.name)) continue;

    const problem = nameProblem(info.server, info.tool);
    if (problem !== null) {
      dropped.push({ name: info.name, why: problem });
      continue;
    }

    seen.add(info.name);
    picked.push(info);
  }

  for (const rule of rules) {
    if (rule.tool.endsWith('*')) continue;
    if (available.some((i) => i.server === rule.server && i.tool === rule.tool)) continue;
    dropped.push({
      name: `${rule.server}:${rule.tool}`,
      why: 'разрешён в конфиге, но сервер такого инструмента не отдал',
    });
  }

  if (picked.length <= maxInline) return { tools: picked, dropped };

  // Обрезка называется вслух: молча укороченный набор читается как «дали всё, что просили».
  for (const extra of picked.slice(maxInline)) {
    dropped.push({
      name: extra.name,
      why: `набор обрезан по потолку ${maxInline}: описания не влезают в контекст`,
    });
  }
  return { tools: picked.slice(0, maxInline), dropped };
}

/** Грубая оценка цены набора в токенах — для показа оператору до запуска этапа. */
export function estimateTokens(tools: readonly McpToolInfo[]): number {
  const chars = tools.reduce(
    (sum, t) => sum + t.name.length + t.description.length + JSON.stringify(t.schema).length,
    0,
  );
  return Math.round(chars / 4);
}
