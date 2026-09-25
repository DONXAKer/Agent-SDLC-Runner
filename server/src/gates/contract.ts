/**
 * Контракт гейт-скрипта (`SDLC.md` → «Контракт гейт-скрипта», `gates/_common.py` эталона):
 * последняя строка stdout — JSON одной строкой
 *   `{"gate": "<имя дословно из набора>", "status": "pass"|"fail"|"skip",
 *     "evidence": ["путь:строка / hunk / имя теста", …], "detail": "<фраза>",
 *     "missing_tool": null | "<что отсутствует в среде>"}`,
 * коды возврата 0 — pass, 1 — fail, 3 — skip (исполнить нечем), 2 — неверный вызов.
 *
 * Статус считается по АРТЕФАКТУ прогона, не по коду возврата чужой команды: скрипт, который
 * обернул `mvn test` и сам разобрал его вывод, отвечает за статус, а код возврата — лишь
 * зеркало. Отказ инструмента среды — `skip` с `missing_tool`, никогда `pass`. Без JSON
 * действует прежнее правило по коду возврата (`contract: 'exit-code'`).
 */

import type { GateStatus } from '@sdlc-runner/shared';

export type ContractStatus = 'pass' | 'fail' | 'skip';

export interface GateContract {
  gate: string;
  status: ContractStatus;
  evidence: string[];
  detail: string;
  missing_tool: string | null;
}

const STATUSES: readonly ContractStatus[] = ['pass', 'fail', 'skip'];

/** Последняя непустая строка stdout как запись контракта; `null` — контракта нет. */
export function parseGateContract(stdout: string): GateContract | null {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1);
  if (line === undefined || !line.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const status = STATUSES.find((s) => s === r['status']);
  if (typeof r['gate'] !== 'string' || status === undefined) return null;
  const evidence = Array.isArray(r['evidence']) ? r['evidence'].filter((e): e is string => typeof e === 'string') : [];
  const missing = typeof r['missing_tool'] === 'string' && r['missing_tool'].trim() !== '' ? r['missing_tool'] : null;
  return {
    gate: r['gate'],
    status,
    evidence,
    detail: typeof r['detail'] === 'string' ? r['detail'] : '',
    missing_tool: missing,
  };
}

export const CONTRACT_GLYPH: Record<ContractStatus, GateStatus> = { pass: '✅', fail: '❌', skip: '⏭' };

/** Ожидаемый код возврата по контракту; `null` — код не оговорён (2 — неверный вызов). */
export const CONTRACT_EXIT: Record<ContractStatus, number> = { pass: 0, fail: 1, skip: 3 };
