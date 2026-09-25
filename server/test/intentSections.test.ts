/**
 * Снимок секций `intent.md` и три законные правки (`artifacts/intentSections.ts`, порт
 * `intent-sections.py`): разведка и закрытые вопросы законны всегда; лист — только
 * дополнен при нетронутых старых строках; переформулировка — с новой записью «уточнено с
 * одобрения»; одна старая запись не легализует последующие переписывания.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkIntentAgainstSnapshot, checkIntentSections, intentSnapshotOf, writeIntentSnapshot } from '../src/artifacts/intentSections.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { intentSectionsIntact } from '../src/run/stages/preconditions.ts';
import { computeVerdict } from '../src/verdict/verdict.ts';
import type { VerdictInput } from '@sdlc-runner/shared';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const INTENT = [
  '# Задача: demo',
  '',
  '## Зачем',
  'чтобы',
  '',
  '## Что делаем',
  'делаем',
  '',
  '## Приёмочный лист',
  '',
  '| id | Пункт | Как проверить |',
  '|---|---|---|',
  '| claim-1 | первое | тест |',
  '| claim-2 [edge] | второе | тест |',
  '',
  '## Что придётся тронуть',
  '‹…›',
  '',
  '## Открытые вопросы',
  '- [ ] вопрос',
  '',
].join('\n');

describe('intentSections', () => {
  it('разведка и закрытие вопросов — законны', () => {
    const old = intentSnapshotOf(INTENT);
    const now = intentSnapshotOf(INTENT.replace('‹…›', 'src/a.ts').replace('- [ ] вопрос', '- [x] вопрос — ответ'));
    const c = checkIntentSections(old, now);
    strictEqual(c.legal, true);
    deepStrictEqual(c.allowed, ['Открытые вопросы', 'Что придётся тронуть']);
  });

  it('дописанная строка листа при нетронутых старых — законна; правка старой строки — нет', () => {
    const old = intentSnapshotOf(INTENT);
    const added = checkIntentSections(old, intentSnapshotOf(INTENT.replace('| claim-2 [edge] | второе | тест |\n', '| claim-2 [edge] | второе | тест |\n| claim-3 | третье | тест |\n')));
    strictEqual(added.legal, true);
    deepStrictEqual(added.additive_claims, ['Приёмочный лист']);

    const edited = checkIntentSections(old, intentSnapshotOf(INTENT.replace('| второе |', '| второе, но иначе |')));
    strictEqual(edited.legal, false);
    deepStrictEqual(edited.illegal, ['Приёмочный лист']);
  });

  it('переформулировка с новой записью «уточнено с одобрения» — законна; старая запись не легализует новую', () => {
    // Заменяется ТЕЛО секции, не заголовок «## Что делаем» (он совпадает подстрокой).
    const withNote = INTENT.replace('\nделаем\n', '\nделаем иначе — уточнено с одобрения Иван\n');
    const approved = checkIntentSections(intentSnapshotOf(INTENT), intentSnapshotOf(withNote));
    strictEqual(approved.legal, true);
    deepStrictEqual(approved.approved_rewording, ['Что делаем']);

    // Снимок снят уже с записью; следующая правка той же секции без НОВОЙ записи — незаконна.
    const again = checkIntentSections(intentSnapshotOf(withNote), intentSnapshotOf(withNote.replace('делаем иначе', 'делаем совсем иначе')));
    strictEqual(again.legal, false);
    deepStrictEqual(again.illegal, ['Что делаем']);
  });

  it('снимок пишется в формате инструмента методологии и читается обратно', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-intent-'));
    roots.push(root);
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    const paths = new WitokPaths(root, 'demo');
    writeFileSync(paths.intent, INTENT, 'utf8');
    const snap = writeIntentSnapshot(paths.intentSections, INTENT);
    ok(snap['Приёмочный лист']?.claim_rows?.['claim-1'] !== undefined);
    strictEqual(checkIntentAgainstSnapshot(paths.intentSections, INTENT)?.legal, true);

    const c = { paths, chunk: 1, attempt: 1 };
    strictEqual(intentSectionsIntact('x').check(c), null);
    writeFileSync(paths.intent, INTENT.replace('чтобы', 'потому что'), 'utf8');
    ok(intentSectionsIntact('x').check(c)?.includes('«Зачем»'));
    strictEqual(checkIntentAgainstSnapshot(join(dir, 'нет.json'), INTENT), null, 'без снимка сверять не с чем');
  });

  it('восьмое условие вердикта: переписанная задача роняет вердикт', () => {
    const input: VerdictInput = {
      gates: [],
      claims: [{ id: 'claim-1', status: '✅' }],
      confirmedReviewFindings: 0,
      enabledGatesMissingFromReport: [],
      openDebtRows: [],
      brokenInvariants: [],
      regressions: [],
      plannedPathsUntouched: [],
      diffMatchesTree: true,
      attempt: 1,
      attemptBudget: 3,
      noProgress: false,
    };
    strictEqual(computeVerdict(input).passed, true);
    const v = computeVerdict({ ...input, intentTamper: ['Зачем'] });
    strictEqual(v.passed, false);
    ok(v.reasons.some((r) => r.includes('вне трёх законных правок') && r.includes('«Зачем»')), v.reasons.join('; '));
  });
});
