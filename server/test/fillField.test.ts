/**
 * `FillField`: политика доступа и исполнение.
 *
 * Путь у вызова НЕ назван самим вызовом — резолвится по ключу артефакта через
 * `ctx.stageArtifacts` (та же карта у политики и у исполнения), тем же приёмом, что уже
 * держит внешние MCP-инструменты (`evaluateMcpPaths`). Здесь проверяется ровно это:
 * ключ вне списка отклоняется как `stageTools`, известный ключ идёт через обычные три
 * проверки (denyList/pathScope/planScope) над синтетическим `write`, а исполнение
 * (`fillFieldTool`) читает, вызывает `applyFill` и пишет результат — тем же гейтом, что
 * любая другая запись.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext, ToolName } from '@sdlc-runner/shared';

import { normalize } from '../src/exec/normalize.ts';
import { evaluate, writeTargetPaths } from '../src/policy/index.ts';
import { destructiveOverwrite } from '../src/approval/destructive.ts';
import { buildPreview } from '../src/approval/preview.ts';
import { executeTool, type ToolContext } from '../src/exec/tools/index.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function makeProject(): { root: string; planPath: string; journalPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-fillfield-'));
  roots.push(root);
  const sdlcDir = join(root, '.sdlc', 'demo');
  mkdirSync(sdlcDir, { recursive: true });
  const planPath = join(sdlcDir, 'plan.md');
  const journalPath = join(sdlcDir, 'chunk-1-journal.md');
  writeFileSync(join(root, 'src.txt'), 'x', 'utf8'); // просто чтобы root не был пуст
  return { root, planPath, journalPath };
}

const ctx = (root: string, over: Partial<PolicyContext> = {}): PolicyContext => ({
  projectRoot: root,
  stage: 'chunk',
  sdlcDir: '.sdlc/demo',
  planFiles: ['src/a.ts'],
  protectedArtifacts: [`.sdlc/demo/plan.md`],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'FillField'] satisfies ToolName[],
  mcpTools: [],
  ...over,
});

const call = (over: Partial<Extract<NormalizedCall, { kind: 'fill_field' }>> = {}): NormalizedCall => ({
  kind: 'fill_field',
  artifact: 'journal',
  field: 'подтвердил',
  value: 'x',
  op: 'set',
  ...over,
});

describe('normalize: fill_field', () => {
  it('оба флоу дают одну форму', () => {
    const sdk = normalize('mcp__sdlc__fill_field', { artifact: 'plan', field: 'подход', value: 'A' });
    const loop = normalize('FillField', { artifact: 'plan', field: 'подход', value: 'A' });
    deepStrictEqual(sdk, loop);
    deepStrictEqual(sdk, { kind: 'fill_field', artifact: 'plan', field: 'подход', value: 'A', op: 'set' });
  });

  it('op "add" распознаётся, всё остальное — "set"', () => {
    const withAdd = normalize('FillField', { artifact: 'plan', field: 'x', value: 'A', op: 'add' });
    strictEqual((withAdd as { op: string }).op, 'add');
    const withoutOp = normalize('FillField', { artifact: 'plan', field: 'x', value: 'A' });
    strictEqual((withoutOp as { op: string }).op, 'set');
  });

  it('неизвестный ключ артефакта — unknown, а не тихий пропуск', () => {
    const bad = normalize('FillField', { artifact: 'нет-такого', field: 'x', value: 'A' });
    strictEqual(bad.kind, 'unknown');
  });

  it('пустая строка value — законный fill_field: list/records выражают «пусто» именно так', () => {
    const empty = normalize('FillField', { artifact: 'plan', field: 'x', value: '' });
    strictEqual(empty.kind, 'fill_field');
    strictEqual((empty as { value: string }).value, '');
  });

  it('отсутствующий ключ value — unknown, а не молчаливое «пусто»', () => {
    const bad = normalize('FillField', { artifact: 'plan', field: 'x' });
    strictEqual(bad.kind, 'unknown');
  });
});

describe('политика: FillField', () => {
  it('ключ, которого этап не производит, — отказ stageTools с перечнем доступных', () => {
    const { root } = makeProject();
    const v = evaluate(call({ artifact: 'plan' }), ctx(root, { stageArtifacts: [] }));
    ok(!v.ok);
    strictEqual(v.policy, 'stageTools');
    ok(v.reason.includes('journal') === false); // список доступных пуст — ничего не назвал
  });

  it('известный ключ проходит через обычные проверки над синтетическим write', () => {
    const { root, journalPath } = makeProject();
    const v = evaluate(
      call({ artifact: 'journal' }),
      ctx(root, { stageArtifacts: [{ key: 'journal', path: journalPath }] }),
    );
    ok(v.ok, v.ok ? '' : v.reason);
  });

  it('защищённый артефакт (protectedArtifacts) отклоняется planScope, как обычный write', () => {
    const { root, planPath } = makeProject();
    const v = evaluate(
      call({ artifact: 'plan' }),
      ctx(root, {
        stageArtifacts: [{ key: 'plan', path: planPath }],
        protectedArtifacts: ['.sdlc/demo/plan.md'],
      }),
    );
    ok(!v.ok, 'план защищён на chunk — FillField не должен его обойти');
  });

  it('writeTargetPaths резолвит путь по ключу — та же карта, что у политики', () => {
    const { root, journalPath } = makeProject();
    const c = ctx(root, { stageArtifacts: [{ key: 'journal', path: journalPath }] });
    deepStrictEqual(writeTargetPaths(call({ artifact: 'journal' }), c), [journalPath]);
  });

  it('destructiveOverwrite никогда не срабатывает на fill_field — это не Write', () => {
    strictEqual(destructiveOverwrite(call(), 'D:/proj'), null);
  });

  it('buildPreview рисует отрендеренный applyFill результат, а не сырое значение', () => {
    const { root, journalPath } = makeProject();
    writeFileSync(
      journalPath,
      "- **Подтвердил:** ‹имя› · ‹дата› / использовано одобрение плана через ExitPlanMode этой сессии\n",
      'utf8',
    );
    const preview = buildPreview(
      { kind: 'fill_field', artifact: 'journal', field: 'подтвердил', value: 'x', op: 'set' },
      root,
      [{ key: 'journal', path: journalPath }],
    );
    ok(preview !== null);
    // "Подтвердил" — метка решения человека: applyFill обязан отказать, и превью честно
    // показывает отказ, а не выдуманное содержимое.
    ok(preview.after.includes('не применяется'));
    void root;
  });
});

describe('исполнение: fillFieldTool через executeTool', () => {
  const toolCtx = (root: string, artifacts: readonly { key: 'plan' | 'journal'; path: string }[]): ToolContext => ({
    projectRoot: root,
    maxResultBytes: 100_000,
    readRangeRequiredAboveBytes: 100_000,
    timeoutMs: 1000,
    signal: new AbortController().signal,
    artifacts,
  });

  it('заполняет поле и пишет результат на диск', async () => {
    const { root, planPath } = makeProject();
    writeFileSync(planPath, '- **Ветка витка:** ‹sdlc/слаг›\n', 'utf8');
    const outcome = await executeTool(
      { kind: 'fill_field', artifact: 'plan', field: 'ветка витка', value: 'sdlc/oversize', op: 'set' },
      toolCtx(root, [{ key: 'plan', path: planPath }]),
    );
    ok(outcome.ok, outcome.text);
    strictEqual(readFileSync(planPath, 'utf8'), '- **Ветка витка:** sdlc/oversize\n');
  });

  it('ключ вне ctx.artifacts — отказ, диск не тронут', async () => {
    const { root, planPath } = makeProject();
    const original = '- **Ветка витка:** ‹sdlc/слаг›\n';
    writeFileSync(planPath, original, 'utf8');
    const outcome = await executeTool(
      { kind: 'fill_field', artifact: 'plan', field: 'ветка витка', value: 'x', op: 'set' },
      toolCtx(root, []),
    );
    strictEqual(outcome.ok, false);
    strictEqual(readFileSync(planPath, 'utf8'), original);
  });

  it('бланк ещё не разложен на диске — понятный отказ, а не крах', async () => {
    const { root, planPath } = makeProject();
    const outcome = await executeTool(
      { kind: 'fill_field', artifact: 'plan', field: 'ветка витка', value: 'x', op: 'set' },
      toolCtx(root, [{ key: 'plan', path: planPath }]),
    );
    strictEqual(outcome.ok, false);
    ok(outcome.text.includes('не разложен'));
  });

  it('applyFill отклонил (неизвестное поле) — отказ несёт перечень допустимых id', async () => {
    const { root, planPath } = makeProject();
    writeFileSync(planPath, '- **Ветка витка:** ‹sdlc/слаг›\n', 'utf8');
    const outcome = await executeTool(
      { kind: 'fill_field', artifact: 'plan', field: 'нет-такого-поля', value: 'x', op: 'set' },
      toolCtx(root, [{ key: 'plan', path: planPath }]),
    );
    strictEqual(outcome.ok, false);
    ok(outcome.text.includes('нет поля'));
  });
});
