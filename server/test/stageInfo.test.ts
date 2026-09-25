/**
 * `run/stageInfo.ts` — расчёт «этап пройден / решение записано» по диску, общий у страницы
 * живого витка (`GET /api/runs/:id`) и дашборда. Жил внутри обработчика ручки; здесь же
 * скрепа, что обработчик не завёл вторую копию.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { writeArtifact } from '../src/artifacts/artifact.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { artifactProduced, decisionState, pendingDecisionCount, stageInfos } from '../src/run/stageInfo.ts';
import { stageById } from '../src/run/stages/index.ts';
import type { StageContext } from '../src/run/stages/types.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-stageinfo-test-')));
after(() => rmSync(root, { recursive: true, force: true }));

function ctxOf(slug: string): StageContext {
  return { paths: new WitokPaths(root, slug), chunk: 1, attempt: 1 };
}

describe('artifactProduced', () => {
  it('существует И без плейсхолдеров — иначе не пройден', () => {
    const c = ctxOf('produced');
    writeArtifact(c.paths.plan, '# План\n\n- поле: ‹заполнить›\n');
    strictEqual(artifactProduced([c.paths.plan], c), false);
    writeArtifact(c.paths.plan, '# План\n\n- поле: готово\n');
    strictEqual(artifactProduced([c.paths.plan], c), true);
  });

  it('пустой список и отсутствующий файл — не пройден', () => {
    const c = ctxOf('produced-missing');
    strictEqual(artifactProduced([], c), false);
    strictEqual(artifactProduced([c.paths.intent], c), false);
  });
});

describe('decisionState', () => {
  it('нет артефакта — null (решать нечего), есть без подписи — pending, с подписью — granted', () => {
    const c = ctxOf('decision');
    const plan = stageById('plan');
    strictEqual(decisionState(plan, c), null);
    writeArtifact(c.paths.plan, '# План\n\n- **Одобрение:** ‹имя, дата›\n');
    strictEqual(decisionState(plan, c), 'pending');
    writeArtifact(c.paths.plan, '# План\n\n- **Одобрение:** Иван · 2026-09-25\n');
    strictEqual(decisionState(plan, c), 'granted');
  });

  it('у этапа без слота решения — null', () => {
    strictEqual(decisionState(stageById('intent'), ctxOf('decision')), null);
  });

  it('handoff читает ПОСЛЕДНЮЮ секцию витка', () => {
    const c = ctxOf('handoff-last');
    writeArtifact(
      c.paths.handoff,
      [
        '# Передача',
        '',
        '## Виток 1',
        '',
        '- **Приёмка:** Иван · 2026-09-01',
        '',
        '## Виток 2',
        '',
        '- **Приёмка:** ‹имя, дата›',
        '',
      ].join('\n'),
    );
    strictEqual(decisionState(stageById('handoff'), c), 'pending');
  });

  it('pendingDecisionCount считает неподписанные слоты написанных артефактов', () => {
    const c = ctxOf('pending-count');
    writeArtifact(c.paths.plan, '# План\n\n- **Одобрение:** ‹имя, дата›\n');
    strictEqual(pendingDecisionCount(c), 1);
  });
});

describe('stageInfos', () => {
  it('семь этапов в порядке витка; блокеры и проба среды — от вызывающего', () => {
    const c = ctxOf('infos');
    writeArtifact(c.paths.intent, '# Задача: сделать\n');
    const infos = stageInfos(c, { blockers: (id, o) => (o?.abortHandoff === true ? ['обрыв'] : [`блок ${id}`]) });
    deepStrictEqual(
      infos.map((s) => s.id),
      ['intent', 'explore', 'ask', 'plan', 'chunk', 'verify', 'handoff'],
    );
    strictEqual(infos[0]?.blockers[0], 'блок intent');
    deepStrictEqual(infos.find((s) => s.id === 'handoff')?.abortBlockers, ['обрыв']);
    strictEqual(infos.find((s) => s.id === 'plan')?.abortBlockers, null);
    // Без `envNotes` у вызывающего (дашборд) поле не появляется вовсе.
    ok(!('envNotes' in infos[0]!));
  });

  it('обработчик GET /api/runs/:id не держит второй копии расчёта', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
    ok(!/\bproduced:/.test(text), 'index.ts снова считает produced сам');
    ok(!/\bdecisionRecorded:/.test(text), 'index.ts снова считает decisionRecorded сам');
  });
});
