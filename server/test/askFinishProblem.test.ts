/**
 * `askModule.begin(host).finishProblem` — страж завершения этапа 3 (`ask.ts`), часть про
 * «Что изменилось в задаче» (Р6, серия local6 2026-09-24): колонка заполнена, но не
 * отражает собственный ответ человека той же строки — см. `humanFacts.ts::unreflectedAnswers`.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { askModule } from '../src/run/stages/ask.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function repo(reportBody: string): WitokPaths {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-finish-')));
  roots.push(root);
  const paths = new WitokPaths(root, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.clarificationReport, reportBody);
  return paths;
}

function report(changed: string, answer = 'Льготная ставка НДС — 10%. Применяется, только если ВСЕ позиции льготные.'): string {
  return [
    '# Вопросы и ответы: демо',
    '',
    '## Вопросы и ответы',
    '_легенда_',
    '',
    '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
    '|---|---|---|---|---|',
    `| 1 | Какую ставку льготы использовать? | да | ${answer} | ${changed} |`,
    '',
    '## Уточнённое требование и подход',
    'текст',
    '',
  ].join('\n');
}

function host(paths: WitokPaths): StageHost {
  return { paths } as unknown as StageHost;
}

describe('askModule.begin(host).finishProblem — «Что изменилось» против ответа', () => {
  it('«Что изменилось» пересказывает 20% без единой цифры ответа (10%) — находка, называет вопрос', () => {
    const paths = repo(report('Invoice обновлён: при opts.vat=\'std\' добавляется 20 % от subtotal'));
    const problem = askModule.begin?.(host(paths), {} as never)?.finishProblem?.() ?? null;
    ok(problem !== null);
    ok(problem!.includes('Какую ставку льготы использовать?'), problem ?? '');
    ok(problem!.includes('Что изменилось'), problem ?? '');
  });

  it('«Что изменилось» содержит цифру ответа (10%) — не находка', () => {
    const paths = repo(report('Добавлена льготная ставка 10% для счетов, где все позиции reduced'));
    strictEqual(askModule.begin?.(host(paths), {} as never)?.finishProblem?.() ?? null, null);
  });

  it('«Что изменилось» называет claim-N — не находка', () => {
    const paths = repo(report('см. claim-1'));
    strictEqual(askModule.begin?.(host(paths), {} as never)?.finishProblem?.() ?? null, null);
  });

  it('отчёта нет на диске — н/п (условный этап мог его не создать)', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-finish-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    strictEqual(askModule.begin?.(host(paths), {} as never)?.finishProblem?.() ?? null, null);
  });
});
