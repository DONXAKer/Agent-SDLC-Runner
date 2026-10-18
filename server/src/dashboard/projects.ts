/**
 * Проекты дашборда: несколько имён конфига с одним корнем — один проект.
 *
 * Витки лежат в `.sdlc/` корня, а не имени: `example` и `Runner` (или `WarCard` и
 * `WarCard-MCP-проба`) указывают на один каталог, и без сведения каждый виток показывался
 * бы дважды под разными именами. Ключ сведения — тот же канонический корень, что у вердиктов.
 */

import type { DashboardProjectRef } from '@sdlc-runner/shared';

import { canonicalRoot } from '../run/verdictStore.ts';

export function dashboardProjects(projects: Iterable<{ name: string; projectRoot: string }>): DashboardProjectRef[] {
  const byRoot = new Map<string, DashboardProjectRef>();
  for (const p of projects) {
    const key = canonicalRoot(p.projectRoot);
    const hit = byRoot.get(key);
    if (hit === undefined) byRoot.set(key, { key: p.name, aliases: [p.name], projectRoot: p.projectRoot });
    else hit.aliases.push(p.name);
  }
  return [...byRoot.values()];
}

/** Проект по ключу адреса; принимает и любое другое имя того же корня. */
export function projectByKey(refs: readonly DashboardProjectRef[], key: string): DashboardProjectRef | null {
  return refs.find((r) => r.key === key) ?? refs.find((r) => r.aliases.includes(key)) ?? null;
}
