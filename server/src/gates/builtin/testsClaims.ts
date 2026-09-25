/**
 * Гейт «Сверка тестов с claims» — порт эталона `gates/tests_claims.py` методологии.
 *
 * Конвенция, которая делает гейт механическим: **тест несёт id пункта приёмки** — в имени
 * или теге: `test_claim_3_empty_input`, `@Tag("claim-3")` (до или после `@Test`),
 * `it("claim-3: …")`, `// claim-3` строкой над декларацией. Каждая добавленная тестовая
 * декларация обязана нести хотя бы один `claim-N`, и этот id обязан существовать в задаче.
 * Побочный выход — карта `claim → тесты`.
 */

import { patchHunks } from '../../diff/diffstat.ts';
import { attemptPatchOf } from './attemptPatch.ts';
import type { BuiltinGate, BuiltinOutcome } from './index.ts';

const DECL =
  /^\s*(?:async\s+)?def (test_\w+)|@Test\b|\b(?:it|test)\s*\(\s*['"`]([^'"`]+)|^\s*func (Test\w+)|#\[test\]|\[(?:Fact|Theory|Test|TestMethod)\]|^\s*it\s+['"]([^'"]+)/;
const ANNOTATION_ONLY = /^\s*(@Test\b|#\[test\]|\[(?:Fact|Theory|Test|TestMethod)\])/;
const CLAIM = /claim[-_](\d+)/gi;
const SIGNATURE = /\b(?:void|fn|def|func|public|private|static|async)\b.*?\b(\w+)\s*\(/;

export interface TestsClaimsResult {
  without: string[];
  unknown: string[];
  mapping: Map<string, string[]>;
}

/** Чистая часть гейта: по добавленным строкам патча и id пунктов задачи. */
export function checkTestsClaims(patch: string, intentClaims: ReadonlySet<string>): TestsClaimsResult {
  const added = patchHunks(patch).filter((h) => h.sign === '+');
  const without: string[] = [];
  const unknown: string[] = [];
  const mapping = new Map<string, string[]>();
  for (let i = 0; i < added.length; i++) {
    const { path, line, text } = added[i]!;
    const m = DECL.exec(text);
    if (m === null) continue;
    let name: string | null = m.slice(1).find((g) => g !== undefined && g !== '') ?? null;
    // окно: до двух добавленных строк выше (не дальше предыдущей декларации) …
    const window = [text];
    for (const prev of added.slice(Math.max(0, i - 2), i).reverse()) {
      if (prev.path !== path || DECL.test(prev.text)) break;
      window.push(prev.text);
    }
    // … и, для аннотации без имени (@Test, #[test], [Fact]), до трёх строк ниже — до
    // сигнатуры: там живут @Tag("claim-N")/@DisplayName и само имя метода.
    if (ANNOTATION_ONLY.test(text)) {
      for (const next of added.slice(i + 1, i + 4)) {
        if (next.path !== path || ANNOTATION_ONLY.test(next.text)) break;
        window.push(next.text);
        const sig = SIGNATURE.exec(next.text);
        if (sig !== null) {
          name = name ?? sig[1] ?? null;
          break;
        }
      }
    }
    name = name ?? text.trim().slice(0, 60);
    const ids = new Set<string>();
    for (const c of window.join(' ').matchAll(CLAIM)) ids.add(`claim-${c[1]}`);
    if (ids.size === 0) {
      without.push(`${path}:${line} — ${name}`);
      continue;
    }
    for (const cid of [...ids].sort()) {
      if (!intentClaims.has(cid)) unknown.push(`${path}:${line} — ${name} → ${cid} нет в задаче`);
      const list = mapping.get(cid) ?? [];
      list.push(name);
      mapping.set(cid, list);
    }
  }
  return { without, unknown, mapping };
}

export const testsClaimsGate: BuiltinGate = async (ctx): Promise<BuiltinOutcome> => {
  if (ctx.claimIds === undefined) {
    return { status: '⏭', command: null, exitCode: null, lastLine: 'пункты приёмки задачи гейту не переданы — сверять не с чем' };
  }
  let patch: string;
  try {
    patch = await attemptPatchOf(ctx);
  } catch (e) {
    return { status: '⏭', command: null, exitCode: null, lastLine: `патч попытки не снят: ${(e as Error).message}` };
  }
  const r = checkTestsClaims(patch, new Set(ctx.claimIds.map((c) => c.toLowerCase())));
  const evidence = [...r.without.map((w) => `без claim-id: ${w}`), ...r.unknown.map((u) => `несуществующий id: ${u}`)];
  if (evidence.length > 0) {
    return {
      status: '❌',
      command: null,
      exitCode: 1,
      lastLine:
        `${r.without.length} тест(ов) без claim-id, ${r.unknown.length} с несуществующим — лист дополняет человек, id ставит исполнитель: ` +
        evidence.slice(0, 5).join('; '),
      evidence,
    };
  }
  const covered = [...r.mapping.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, t]) => `${c}: ${t.join(', ')}`);
  return {
    status: '✅',
    command: null,
    exitCode: 0,
    lastLine:
      r.mapping.size === 0
        ? 'новых тестовых деклараций в патче нет — сверять нечего, нарушений нет'
        : `каждый новый тест несёт существующий claim-id (${r.mapping.size} пунктов покрыто): ${covered.join('; ')}`,
    evidence: covered,
  };
};
