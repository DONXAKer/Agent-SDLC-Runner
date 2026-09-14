/**
 * Стёртое перезаписью поле решения человека возвращает механика, а не отказ.
 *
 * Серия v4: 21 отказ «перезапись стирает поле решения человека» в 11 прогонах из 25 —
 * модель переписывала отчёт разведки `Write` целиком. Здесь — чистая починка и её границы.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { PolicyContext } from '@sdlc-runner/shared';

import { readDecision } from '../src/artifacts/artifact.ts';
import { repairErasedDecisions, restoreLostDecisions } from '../src/approval/destructive.ts';
import { ApprovalGate } from '../src/approval/gate.ts';

const LABEL = 'Решение человека о полноте';

const BEFORE = [
  '# Отчёт разведки: demo',
  '',
  '## Карта кодовой базы',
  '',
  '| Путь | Что там сейчас |',
  '|---|---|',
  '| ‹путь› | ‹что там› |',
  '',
  '## Сверка листов',
  '',
  'Совпало: ‹…›',
  '',
  `- **${LABEL}:** ‹полный / добавить: … — имя человека›`,
  '',
  '## Всплывшие вопросы',
  '',
  '- нет',
  '',
].join('\n');

const REWRITTEN = [
  '# Отчёт разведки: demo',
  '',
  '## Карта кодовой базы',
  '',
  '| Путь | Что там сейчас |',
  '|---|---|',
  '| src/a.ts | функция priceFor |',
  '',
  '## Сверка листов',
  '',
  'Совпало: claim-1, claim-2',
  '',
  '## Всплывшие вопросы',
  '',
  '- нет',
  '',
].join('\n');

describe('restoreLostDecisions', () => {
  it('возвращает блок поля в его секцию и не трогает остальной текст модели', () => {
    const r = restoreLostDecisions(BEFORE, REWRITTEN);
    ok(r !== null);
    strictEqual(r.restored.join(), LABEL);
    ok(r.content.includes('| src/a.ts | функция priceFor |'), r.content);
    const sverka = r.content.split('## Сверка листов')[1]!.split('## Всплывшие вопросы')[0]!;
    ok(sverka.includes(`**${LABEL}:**`), r.content);
    strictEqual(readDecision(r.content, LABEL).state, 'placeholder');
  });

  it('секции поля в новом тексте нет — поле уходит в конец документа и читается', () => {
    const r = restoreLostDecisions(BEFORE, '# Отчёт разведки: demo\n\nкороткий текст\n');
    ok(r !== null);
    strictEqual(readDecision(r.content, LABEL).state, 'placeholder');
  });

  it('поле не стёрто — чинить нечего', () => {
    strictEqual(restoreLostDecisions(BEFORE, BEFORE), null);
  });
});

describe('repairErasedDecisions', () => {
  it('Write по файлу с полем решения: исправленное содержимое; массовая потеря строк — null', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-restore-'));
    try {
      writeFileSync(join(root, 'report.md'), BEFORE);
      const fixed = repairErasedDecisions({ kind: 'write', path: 'report.md', content: REWRITTEN }, root);
      ok(fixed !== null);
      ok(fixed.content.includes(`**${LABEL}:**`));

      const long = `${BEFORE}${Array.from({ length: 60 }, (_, i) => `строка ${i}`).join('\n')}\n`;
      writeFileSync(join(root, 'long.md'), long);
      strictEqual(
        repairErasedDecisions({ kind: 'write', path: 'long.md', content: '# Отчёт\n\nпочти пусто\n' }, root),
        null,
        'новая версия потеряла больше половины файла — это решает человек, а не починка',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('не Write — не наше', () => {
    strictEqual(repairErasedDecisions({ kind: 'bash', command: 'ls' }, tmpdir()), null);
  });
});

describe('гейт: ручка restoreErasedDecisions', () => {
  const REL = '.sdlc/x/exploration-report.md';

  function setup(): { root: string; ctx: (on: boolean) => PolicyContext } {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-restore-gate-'));
    mkdirSync(join(root, '.sdlc', 'x'), { recursive: true });
    writeFileSync(join(root, REL), BEFORE);
    const ctx = (on: boolean): PolicyContext => ({
      projectRoot: root,
      stage: 'explore',
      sdlcDir: '.sdlc/x',
      planFiles: null,
      protectedArtifacts: [],
      readOnlyRoots: [],
      allowedTools: ['Read', 'Write', 'Edit'],
      mcpTools: [],
      ...(on ? { restoreErasedDecisions: true } : {}),
    });
    return { root, ctx };
  }

  async function writeThrough(gate: ApprovalGate, ctx: PolicyContext) {
    return gate.request({
      runId: 'r1',
      stage: 'explore',
      requestId: `w-${Math.random()}`,
      toolName: 'Write',
      rawInput: { file_path: REL, content: REWRITTEN },
      call: { kind: 'write', path: REL, content: REWRITTEN },
      ctx,
    });
  }

  it('включена: карточка без ноты потери, с пометкой; одобрение без правки уносит исправленный вход', async () => {
    const { root, ctx } = setup();
    try {
      const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
      const pending = writeThrough(gate, ctx(true));
      const card = gate.list()[0]!;
      strictEqual(card.destructive, null);
      ok(card.repaired?.includes(LABEL), card.repaired);
      gate.resolve('r1', card.requestId, { allowed: true, updatedInput: null, by: 'operator' });
      const d = await pending;
      ok(d.allowed);
      const content = (d.updatedInput as Record<string, unknown> | null)?.['content'];
      ok(typeof content === 'string' && content.includes(`**${LABEL}:**`), String(content));
      ok(content.includes('| src/a.ts | функция priceFor |'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('выключена: прежнее поведение — нота о стёртом поле, вход не трогается', async () => {
    const { root, ctx } = setup();
    try {
      const gate = new ApprovalGate({ onPending: () => {}, onResolved: () => {} });
      const pending = writeThrough(gate, ctx(false));
      const card = gate.list()[0]!;
      ok(card.destructive?.includes('стирает поле решения человека'), card.destructive ?? '');
      strictEqual(card.repaired, undefined);
      gate.resolve('r1', card.requestId, { allowed: true, updatedInput: null, by: 'operator' });
      const d = await pending;
      ok(d.allowed);
      strictEqual(d.updatedInput, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
