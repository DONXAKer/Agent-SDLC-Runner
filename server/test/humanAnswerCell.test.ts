/**
 * «Ответ человека» в таблице «Вопросы и ответы» отчёта этапа 3 — владение по ЯЧЕЙКЕ, а не
 * по строке (`artifact.ts::isHumanAnswerCell`): ответ — поле человека, «Что изменилось в
 * задаче» той же строки — поле модели (его требует страж `ask.ts::finishProblem`). Строку с
 * ответом на `AskHuman` модели пишет рантайм (`ask.ts::afterAskHuman`), а не модель.
 * Подписные колонки («Утвердил (человек)», «Кто») сохраняют прежнее правило «строка целиком
 * не модели» — оно намеренное.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { NormalizedCall, PolicyContext, Question } from '@sdlc-runner/shared';

import { decisionColumnValues, isHumanAnswerCell } from '../src/artifacts/artifact.ts';
import { deriveSchema, modelFields } from '../src/artifacts/formSchema.ts';
import { WitokPaths } from '../src/artifacts/paths.ts';
import { decisionFabricationProblem } from '../src/approval/humanDecision.ts';
import { groupFields } from '../src/exec/FormFillExecutor.ts';
import { askModule } from '../src/run/stages/ask.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const HEADER = '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |';
const SEP = '|---|---|---|---|---|';
const SAMPLE = '| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› / (пропущено) | ‹что поправлено или добавлено› / ничего |';
const ANSWERED = '| 1 | Ставка льготы? | да | 10% | ‹что изменилось в задаче› |';

function report(rows: readonly string[]): string {
  return ['# Вопросы и ответы: демо', '', '## Вопросы и ответы', '_легенда_', '', HEADER, SEP, ...rows, ''].join('\n');
}

describe('isHumanAnswerCell', () => {
  it('узнаёт колонку «Ответ человека», не путая с подписными и соседними', () => {
    ok(isHumanAnswerCell('Ответ человека'));
    ok(isHumanAnswerCell(' ответ человека '));
    ok(!isHumanAnswerCell('Что изменилось в задаче'));
    ok(!isHumanAnswerCell('Ответ'));
  });

  it('decisionColumnValues видит настоящий ответ и не видит образец', () => {
    deepStrictEqual(decisionColumnValues(report([SAMPLE])), []);
    deepStrictEqual(decisionColumnValues(report([ANSWERED])), ['Ответ человека@1: 10%']);
  });
});

describe('formSchema: владение ячейкой «Ответ человека»', () => {
  it('строка-образец (ответ ещё плейсхолдер) — поле человека, модели не отдаётся', () => {
    const s = deriveSchema(report([SAMPLE]));
    const row = s.fields.find((f) => f.shape === 'table');
    ok(row !== undefined);
    strictEqual(row.kind, 'decision');
    strictEqual(row.owner, 'human');
    strictEqual(modelFields(s).filter((f) => f.shape === 'table' || f.shape === 'cell').length, 0);
  });

  it('строка с ответом — «Что изменилось в задаче» остаётся полем модели', () => {
    const s = deriveSchema(report([ANSWERED]));
    const model = modelFields(s).filter((f) => f.shape === 'cell');
    strictEqual(model.length, 1);
    strictEqual(model[0]!.label, 'что изменилось в задаче');
    ok(!s.fields.some((f) => f.kind === 'decision'));
  });

  it('подписная колонка «Утвердил (человек)» — прежнее правило: строка целиком не модели', () => {
    const text = [
      '## Неприменимость',
      '',
      '| Гейт | Почему н/п | Утвердил (человек) |',
      '|---|---|---|',
      '| Тесты | ‹почему› | ‹имя› |',
      '',
    ].join('\n');
    const s = deriveSchema(text);
    strictEqual(modelFields(s).length, 0);
    ok(s.fields.some((f) => f.kind === 'decision' && f.owner === 'human'));
  });
});

describe('groupFields (основной путь дозаполнения): владение ячейкой', () => {
  it('строка-образец не отдаётся; у строки с ответом — только плейсхолдер «Что изменилось»', () => {
    deepStrictEqual(groupFields(report([SAMPLE])), []);
    const g = groupFields(report([ANSWERED, '| 2 | Кеш? | ‹да/нет› | нет | ‹что изменилось в задаче› |']));
    deepStrictEqual(
      g.map((f) => (f.kind === 'cell' ? f.text : 'row')),
      ['‹что изменилось в задаче›', '‹да/нет›', '‹что изменилось в задаче›'],
    );
  });
});

describe('humanDecision: ячейка «Ответ человека»', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-answer-cell-')));
  roots.push(root);
  const ctx: PolicyContext = {
    projectRoot: root,
    stage: 'ask',
    sdlcDir: '.sdlc/demo',
    planFiles: null,
    protectedArtifacts: [],
    readOnlyRoots: [],
    allowedTools: ['Read', 'Write', 'Edit'],
    mcpTools: [],
  };
  const dir = join(root, '.sdlc', 'demo');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'clarification-report.md');

  it('Edit модели, вписывающий ответ в образец, — отклонён', () => {
    writeFileSync(file, report([SAMPLE]));
    const call: NormalizedCall = {
      kind: 'edit',
      path: file,
      edits: [{ oldStr: SAMPLE, newStr: '| 1 | Ставка? | да | 20% | ничего |', replaceAll: false }],
    };
    const problem = decisionFabricationProblem(call, ctx);
    ok(problem !== null, 'ответ за человека обязан ловиться');
    ok(problem!.includes('Ответ человека'), problem);
  });

  it('Edit модели, подменяющий записанный рантаймом ответ, — отклонён', () => {
    writeFileSync(file, report([ANSWERED]));
    const call: NormalizedCall = {
      kind: 'edit',
      path: file,
      edits: [{ oldStr: '| 10% |', newStr: '| 20% |', replaceAll: false }],
    };
    ok(decisionFabricationProblem(call, ctx) !== null);
  });

  it('Edit «Что изменилось в задаче» той же строки — разрешён', () => {
    writeFileSync(file, report([ANSWERED]));
    const call: NormalizedCall = {
      kind: 'edit',
      path: file,
      edits: [{ oldStr: '‹что изменилось в задаче›', newStr: 'claim-1: ставка 10% для льготных позиций', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });
});

describe('ask: ответ на AskHuman модели пишет рантайм (askModule.begin(host).afterAskHuman)', () => {
  function repo(): WitokPaths {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-model-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.intent, '# Задача: демо\n');
    writeFileSync(paths.clarificationReport, report([SAMPLE]));
    return paths;
  }

  function host(paths: WitokPaths, signal: AbortSignal = new AbortController().signal): StageHost {
    return {
      paths,
      signal: () => signal,
      writeAutofilled: (path: string, text: string) => writeFileSync(path, text),
    } as unknown as StageHost;
  }

  const q = (id: string, question: string, header: string): Question => ({
    id,
    question,
    header,
    multiSelect: false,
    options: [],
  });

  it('ответ записан строкой таблицы, пометка велит заполнить «Что изменилось»', () => {
    const paths = repo();
    const inv = askModule.begin?.(host(paths), {} as never);
    const note = inv?.afterAskHuman?.(
      [q('a', 'Какая ставка льготы?', 'Блокирующий вопрос'), q('b', 'Нужен ли кеш?', 'Уточнение')],
      { a: ['10%'], b: ['нет'] },
    );
    ok(note !== null && note !== undefined);
    ok(note.includes('строками 1–2'), note);
    ok(note.includes('«Блокирующий»'), note);
    const text = readFileSync(paths.clarificationReport, 'utf8');
    ok(text.includes('| 1 | Какая ставка льготы? | да | 10% | ‹что изменилось в задаче› |'), text);
    ok(text.includes('| 2 | Нужен ли кеш? | ‹да/нет› | нет | ‹что изменилось в задаче› |'), text);
    ok(!text.includes('‹вопрос›'), 'строка-образец заменена настоящими строками');
  });

  it('без ответа — строки нет и пометки нет', () => {
    const paths = repo();
    const inv = askModule.begin?.(host(paths), {} as never);
    strictEqual(inv?.afterAskHuman?.([q('a', 'Ставка?', 'Блокирующий')], {}) ?? null, null);
    strictEqual(readFileSync(paths.clarificationReport, 'utf8'), report([SAMPLE]));
  });

  it('повторный ответ на тот же вопрос не дублирует строку', () => {
    const paths = repo();
    const inv = askModule.begin?.(host(paths), {} as never);
    inv?.afterAskHuman?.([q('a', 'Ставка?', 'Блокирующий')], { a: ['10%'] });
    strictEqual(inv?.afterAskHuman?.([q('a', 'Ставка?', 'Блокирующий')], { a: ['10%'] }) ?? null, null);
    const rows = readFileSync(paths.clarificationReport, 'utf8').split('\n').filter((l) => l.includes('Ставка?'));
    strictEqual(rows.length, 1);
  });

  it('отменённый этап — ничего не пишет', () => {
    const paths = repo();
    const ac = new AbortController();
    ac.abort();
    const inv = askModule.begin?.(host(paths, ac.signal), {} as never);
    strictEqual(inv?.afterAskHuman?.([q('a', 'Ставка?', 'Блокирующий')], { a: ['10%'] }) ?? null, null);
  });
});
