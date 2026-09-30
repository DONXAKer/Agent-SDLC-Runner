import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { intentModule } from '../src/run/stages/intent.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('intent: ответы на открытые вопросы принадлежат человеку', () => {
  it('reopens a model-checked question, asks it once, and records the answer immutably', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-intent-human-'));
    roots.push(root);
    const intent = join(root, 'intent.md');
    const report = join(root, 'clarification-report.md');
    writeFileSync(intent, [
      '# Задача',
      '',
      '## Открытые вопросы',
      '- [x] **[блокирующий]** Какая ставка применяется к льготным позициям?',
      '',
    ].join('\n'));
    writeFileSync(report, [
      '# Вопросы и ответы: demo',
      '',
      '## Вопросы и ответы',
      '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
      '|---|---|---|---|---|',
      '| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› | ‹что изменилось в задаче› |',
      '',
      '## Уточнённое требование и подход',
      '‹уточнённое требование и подход›',
    ].join('\n'));

    const asks: string[][] = [];
    const host = {
      paths: { intent, clarificationReport: report },
      slug: 'demo',
      runner: () => ({ methodologyDir: root }),
      writeAutofilled: (path: string, text: string) => writeFileSync(path, text),
      askHuman: async (_stage: string, questions: readonly { id: string; question: string }[]) => {
        asks.push(questions.map((q) => q.question));
        return { 'intent-open-0': ['Ставка 10%, если у всех позиций установлен reduced: true.'] };
      },
    } as unknown as StageHost;
    const instance = intentModule.begin!(host, {} as never);
    await instance.afterTurn?.({} as never, new AbortController().signal);

    deepStrictEqual(asks, [['Какая ставка применяется к льготным позициям?']]);
    const savedIntent = readFileSync(intent, 'utf8');
    ok(savedIntent.includes('[x] **[блокирующий]** Какая ставка применяется к льготным позициям? — Ставка 10%'));
    const savedReport = readFileSync(report, 'utf8');
    ok(savedReport.includes('Ставка 10%, если у всех позиций установлен reduced: true.'));
    strictEqual(savedReport.includes('‹ответ›'), false);
  });
});
