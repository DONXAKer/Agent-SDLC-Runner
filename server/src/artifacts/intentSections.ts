/**
 * Три законные правки задачи внутри витка — проверяемо, а не по памяти. Порт
 * `intent-sections.py` методологии (`SDLC.md` → этап 1, восьмое условие вердикта).
 *
 * Внутри витка `intent.md` не переписывается; законных правок ровно три:
 *   1. секция «Что придётся тронуть» (разведка);
 *   2. закрытие вопросов в «Открытых вопросах» (этап 3);
 *   3. уточнение формулировки с одобрения человека — включая **дополнение приёмочного
 *      листа** по находке гейта этапа 4 (новый пункт дописывает человек).
 *
 * Снимок — `.sdlc/<slug>/.intent-sections.json`: по секциям хэш, множество claim-id листа и
 * число записей об одобрении. Тот же формат, что у терминального инструмента: виток, начатый
 * раннером, продолжается в сессии и наоборот. Проверка: `allowed` (правки 1–2),
 * `additive_claims` (лист только дополнен новыми claim-N, старые строки не тронуты — правка
 * 3 без записи), `approved_rewording` (секции с НОВОЙ записью «уточнено с одобрения ‹имя›»
 * относительно снимка — одна старая запись не легализует последующие переписывания),
 * `illegal`. После одобрения плана снимок снимается заново: с этого момента лист снова
 * неизменяем.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export const ALWAYS_ALLOWED = new Set(['Что придётся тронуть', 'Открытые вопросы']);
export const CLAIMS_SECTION = 'Приёмочный лист';
const APPROVAL_RE = /уточнен[оа]\s+с\s+одобрения\s+\S+/giu;
// Канонической строка листа считается и в обратных кавычках (`` | `claim-3 [edge]` | ``) — так
// её узнаёт `artifacts/claims.ts::claimIdOf`; тот же разбор у `intent-sections.py`.
const CLAIM_ROW = /^\s*\|\s*`?(claim-\d+)\b[^|]*\|(.*)$/;

export interface SectionEntry {
  hash: string;
  approvals: number;
  claim_rows?: Record<string, string>;
  other?: string;
}

export type IntentSnapshot = Record<string, SectionEntry>;

export interface IntentSectionsCheck {
  legal: boolean;
  changed: string[];
  allowed: string[];
  additive_claims: string[];
  approved_rewording: string[];
  illegal: string[];
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Тела секций по заголовкам `## …`; текст до первого заголовка — «(шапка)». */
export function intentSections(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name = '(шапка)';
  let buf: string[] = [];
  for (const ln of text.split(/\r?\n/)) {
    if (ln.startsWith('## ')) {
      out.set(name, buf.join('\n'));
      name = ln.slice(3).trim();
      buf = [];
    } else {
      buf.push(ln);
    }
  }
  out.set(name, buf.join('\n'));
  return out;
}

export function intentSnapshotOf(text: string): IntentSnapshot {
  const snap: IntentSnapshot = {};
  for (const [k, v] of intentSections(text)) {
    const entry: SectionEntry = { hash: sha256(v), approvals: (v.match(APPROVAL_RE) ?? []).length };
    if (k === CLAIMS_SECTION) {
      const rows: Record<string, string> = {};
      const rest: string[] = [];
      for (const ln of v.split('\n')) {
        const m = CLAIM_ROW.exec(ln);
        if (m !== null) rows[m[1]!] = sha256(ln);
        else rest.push(ln);
      }
      entry.claim_rows = rows;
      entry.other = sha256(rest.join('\n'));
    }
    snap[k] = entry;
  }
  return snap;
}

export function checkIntentSections(old: IntentSnapshot, now: IntentSnapshot): IntentSectionsCheck {
  const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].sort();
  const changed = keys.filter((k) => old[k]?.hash !== now[k]?.hash);
  const allowed: string[] = [];
  const additive: string[] = [];
  const approved: string[] = [];
  const illegal: string[] = [];
  for (const k of changed) {
    if (ALWAYS_ALLOWED.has(k)) {
      allowed.push(k);
      continue;
    }
    const o = old[k] ?? { hash: '', approvals: 0 };
    const n = now[k] ?? { hash: '', approvals: 0 };
    if (k === CLAIMS_SECTION && o.claim_rows !== undefined) {
      const oldRows = o.claim_rows;
      const newRows = n.claim_rows ?? {};
      const onlyAdded =
        Object.entries(oldRows).every(([cid, h]) => newRows[cid] === h) &&
        Object.keys(oldRows).every((cid) => cid in newRows) &&
        n.other === o.other;
      if (onlyAdded) {
        additive.push(k);
        continue;
      }
    }
    if (n.approvals > o.approvals) {
      approved.push(k);
      continue;
    }
    illegal.push(k);
  }
  return { legal: illegal.length === 0, changed, allowed, additive_claims: additive, approved_rewording: approved, illegal };
}

export function writeIntentSnapshot(path: string, intentText: string): IntentSnapshot {
  const snap = intentSnapshotOf(intentText);
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`, 'utf8');
  return snap;
}

export function readIntentSnapshot(path: string): IntentSnapshot | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as IntentSnapshot) : null;
  } catch {
    return null;
  }
}

/** Проверка задачи против снимка; `null` — снимка нет, сверять не с чем. */
export function checkIntentAgainstSnapshot(snapshotPath: string, intentText: string): IntentSectionsCheck | null {
  const old = readIntentSnapshot(snapshotPath);
  if (old === null) return null;
  return checkIntentSections(old, intentSnapshotOf(intentText));
}
