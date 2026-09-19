/**
 * Вопрос человеку задаёт рантайм на этапе `ask` (3.4 / S1) — через `askModule.begin(host)
 * .beforeExecutor`, тем же путём, что и настоящий виток, а не через приватную функцию
 * напрямую: это и есть контракт, который должен остаться верным при рефакторинге модуля.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ok, strictEqual } from 'node:assert/strict';

import type { Question, StageId } from '@sdlc-runner/shared';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { askModule } from '../src/run/stages/ask.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const INTENT = [
  '# Задача: демо',
  '',
  '## Открытые вопросы',
  '',
  '- [ ] **[блокирующий]** Ставка для суммы >300см?',
  '- [ ] **[неблокирующий]** Нужен ли отдельный кеш?',
  '',
].join('\n');

const REPORT_TEMPLATE = [
  '# Вопросы и ответы: демо',
  '',
  '## Вопросы и ответы',
  '_легенда_',
  '',
  '| # | Вопрос | Блокирующий | Ответ человека | Что изменилось в задаче |',
  '|---|---|---|---|---|',
  '| 1 | ‹вопрос› | ‹да/нет› | ‹ответ› / (пропущено) | ‹что поправлено› |',
  '',
].join('\n');

function repo(): { root: string; paths: WitokPaths } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-')));
  roots.push(root);
  const paths = new WitokPaths(root, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.intent, INTENT);
  writeFileSync(paths.explorationReport, '## Всплывшие вопросы\n\n- [ ] **[блокирующий]** ‹вопрос›\n');
  writeFileSync(paths.clarificationReport, REPORT_TEMPLATE);
  return { root, paths };
}

/** Минимальный `StageHost`: реализует только то, что трогает `askOpenQuestions`. */
function host(
  paths: WitokPaths,
  askHuman: (stage: StageId, questions: readonly Question[]) => Promise<Record<string, string[]>>,
): StageHost {
  const writes: { path: string; text: string }[] = [];
  const h = {
    paths,
    askHuman,
    writeAutofilled: (path: string, text: string) => {
      writes.push({ path, text });
      writeFileSync(path, text);
    },
  } as unknown as StageHost;
  return Object.assign(h, { __writes: writes }) as StageHost & { __writes: typeof writes };
}

describe('askOpenQuestions (через askModule.begin(host).beforeExecutor)', () => {
  it('задаёт открытые вопросы блокирующими первыми, ≤4 за раз, пишет ответы в отчёт', async () => {
    const { paths } = repo();
    const seen: { stage: StageId; questions: readonly Question[] }[] = [];
    const h = host(paths, async (stage, questions) => {
      seen.push({ stage, questions });
      const answers: Record<string, string[]> = {};
      for (const q of questions) {
        answers[q.id] = q.question.includes('Ставка') ? ['90% от базовой цены'] : [];
      }
      return answers;
    });

    await askModule.begin?.(h, {} as never)?.beforeExecutor?.();

    strictEqual(seen.length, 1);
    strictEqual(seen[0]?.stage, 'ask');
    // Блокирующий первым.
    strictEqual(seen[0]?.questions[0]?.question, 'Ставка для суммы >300см?');
    ok(seen[0]?.questions.every((q) => q.multiSelect === false && q.options.length === 0));

    const report = readFileSync(paths.clarificationReport, 'utf8');
    ok(report.includes('| 1 | Ставка для суммы >300см? | да | 90% от базовой цены | ‹что изменилось в задаче› |'), report);
    ok(report.includes('(пропущено)'), report);
    ok(!report.includes('‹вопрос›'), 'строка-образец обязана быть заменена');

    // Регрессия ревью (2026-09-19): чек-бокс intent.md обязан закрыться СРАЗУ в этом же
    // входе — mechanicalJobs (закрытие intent.md) выполняется рантаймом ДО этого хука и
    // на момент своего прогона отчёта с ответом ещё не видит.
    const intent = readFileSync(paths.intent, 'utf8');
    ok(intent.includes('- [x] **[блокирующий]** Ставка для суммы >300см?'), intent);
    // Пропущенный (неблокирующий) вопрос остаётся открытым — уходит следующему витку.
    ok(intent.includes('- [ ] **[неблокирующий]** Нужен ли отдельный кеш?'), intent);
  });

  it('идемпотентно: повторный вход не переспрашивает уже отвеченные вопросы', async () => {
    const { paths } = repo();
    let calls = 0;
    const h = host(paths, async (_stage, questions) => {
      calls++;
      const answers: Record<string, string[]> = {};
      for (const q of questions) answers[q.id] = ['ответ'];
      return answers;
    });

    await askModule.begin?.(h, {} as never)?.beforeExecutor?.();
    strictEqual(calls, 1);
    await askModule.begin?.(h, {} as never)?.beforeExecutor?.();
    strictEqual(calls, 1, 'второй вход не должен снова звать askHuman — вопросов не осталось');
  });

  it('открытых вопросов нет — askHuman не вызывается вовсе', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-none-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.intent, '# Задача\n\n## Открытые вопросы\n\n- [x] **[блокирующий]** уже закрыт\n');
    writeFileSync(paths.explorationReport, '## Всплывшие вопросы\n\n- [ ] **[блокирующий]** ‹вопрос›\n');
    writeFileSync(paths.clarificationReport, REPORT_TEMPLATE);

    let called = false;
    const h = host(paths, async () => {
      called = true;
      return {};
    });
    await askModule.begin?.(h, {} as never)?.beforeExecutor?.();
    strictEqual(called, false);
  });

  it('отчёт ещё не разложен на диске — askHuman не вызывается (защитный случай)', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-noreport-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.intent, INTENT);
    writeFileSync(paths.explorationReport, '');
    // clarificationReport НЕ создан.

    let called = false;
    const h = host(paths, async () => {
      called = true;
      return {};
    });
    await askModule.begin?.(h, {} as never)?.beforeExecutor?.();
    strictEqual(called, false);
  });

  it('больше 4 открытых вопросов — за один вход задаётся не больше 4, блокирующие первыми', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ask-many-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    const lines = ['# Задача', '', '## Открытые вопросы', ''];
    for (let i = 1; i <= 6; i++) {
      lines.push(`- [ ] **[${i <= 2 ? 'блокирующий' : 'неблокирующий'}]** Вопрос ${i}?`);
    }
    writeFileSync(paths.intent, lines.join('\n'));
    writeFileSync(paths.explorationReport, '');
    writeFileSync(paths.clarificationReport, REPORT_TEMPLATE);

    const h = host(paths, async (_stage, questions) => {
      const answers: Record<string, string[]> = {};
      for (const q of questions) answers[q.id] = ['ответ'];
      return answers;
    });
    let batchSize = 0;
    const wrapped = host(paths, async (stage, questions) => {
      batchSize = questions.length;
      return h.askHuman(stage, questions);
    });
    await askModule.begin?.(wrapped, {} as never)?.beforeExecutor?.();
    strictEqual(batchSize, 4);

    const report = readFileSync(paths.clarificationReport, 'utf8');
    ok(report.includes('Вопрос 1?') && report.includes('Вопрос 2?'), 'оба блокирующих обязаны войти в первую партию');
  });
});
