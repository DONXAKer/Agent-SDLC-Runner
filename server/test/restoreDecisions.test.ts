/**
 * Стёртое перезаписью поле решения человека возвращает механика, а не отказ.
 *
 * Серия v4: 21 отказ «перезапись стирает поле решения человека» в 11 прогонах из 25 —
 * модель переписывала отчёт разведки `Write` целиком. Здесь — чистая починка и её границы.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { PolicyContext } from '@sdlc-runner/shared';

import { decisionLineIndexes, readDecision } from '../src/artifacts/artifact.ts';
import { isMassLoss, repairErasedDecisions, restoreLostDecisions } from '../src/approval/destructive.ts';
import type { PendingApproval } from '../src/approval/gate.ts';
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

describe('restoreLostDecisions: одинаковые метки и заголовки, переводы строк', () => {
  const WHO = 'Кто утвердил';
  const HANDOFF = [
    '# Handoff: demo',
    '',
    '## Дефект',
    '',
    '### Запись',
    '',
    '- Класс: гонка',
    `- **${WHO}:** ‹имя›`,
    '',
    '## Дефект',
    '',
    '### Запись',
    '',
    '- Класс: утечка',
    `- **${WHO}:** Иван`,
    '',
  ].join('\n');

  // Первую запись модель изменила, вторую стёрла: по тексту стёртое не опознать, и поле
  // уходило в чужую запись (code-review, 2026-09-15). Угадывать нельзя — решает человек.
  it('одна запись изменена, другая стёрта — не угадывать: null', () => {
    const changedAndErased = HANDOFF.replace(`- **${WHO}:** ‹имя›`, `- **${WHO}:** ‹имя› (правка)`)
      .split('\n')
      .filter((l) => !l.includes('Иван'))
      .join('\n');
    strictEqual(restoreLostDecisions(HANDOFF, changedAndErased), null);
  });

  it('одна из одинаковых секций удалена — номер заголовка не переносится: null', () => {
    const lines = HANDOFF.split('\n');
    const secondDefect = lines.lastIndexOf('## Дефект');
    const erased = [...lines.slice(0, secondDefect)].filter((l) => !l.includes(WHO)).join('\n');
    strictEqual(restoreLostDecisions(HANDOFF, erased), null);
  });

  it('две записи с одной меткой стёрты обе — возвращаются обе, а не одна', () => {
    const erased = HANDOFF.split('\n').filter((l) => !l.includes(WHO)).join('\n');
    const r = restoreLostDecisions(HANDOFF, erased);
    ok(r !== null);
    strictEqual(decisionLineIndexes(r.content.split('\n'), WHO).length, 2, r.content);
  });

  it('стёрта вторая из двух — поле встаёт в ВТОРУЮ одноимённую секцию', () => {
    const erased = HANDOFF.split('\n').filter((l) => !l.includes('Иван')).join('\n');
    const r = restoreLostDecisions(HANDOFF, erased);
    ok(r !== null);
    const sections = r.content.split('### Запись');
    strictEqual(sections.length, 3);
    ok(!sections[1]!.includes('Иван'), r.content);
    ok(sections[2]!.includes(`**${WHO}:** Иван`), r.content);
  });

  it('CRLF в новом содержимом — вставленный блок тоже в CRLF, без голых \\n и хвостовых \\r', () => {
    const r = restoreLostDecisions(BEFORE.replace(/\n/g, '\r\n'), REWRITTEN.replace(/\n/g, '\r\n'));
    ok(r !== null);
    ok(!/(^|[^\r])\n/.test(r.content), JSON.stringify(r.content));
    ok(!/\r(?!\n)/.test(r.content), JSON.stringify(r.content));
    ok(r.content.includes(`**${LABEL}:**`));
  });

  it('CRLF только в прежнем тексте — блок вставляется без \\r', () => {
    const r = restoreLostDecisions(BEFORE.replace(/\n/g, '\r\n'), REWRITTEN);
    ok(r !== null);
    ok(!r.content.includes('\r'), JSON.stringify(r.content));
  });
});

describe('isMassLoss', () => {
  it('короткий файл, переписанный почти в ноль, — массовая потеря; правка пары строк — нет', () => {
    strictEqual(isMassLoss({ path: 'a', linesBefore: 35, linesAfter: 3, linesLost: 32 }), true);
    strictEqual(isMassLoss({ path: 'a', linesBefore: 17, linesAfter: 15, linesLost: 2 }), false);
    strictEqual(isMassLoss({ path: 'a', linesBefore: 12, linesAfter: 4, linesLost: 8 }), false);
    strictEqual(isMassLoss({ path: 'a', linesBefore: 100, linesAfter: 40, linesLost: 60 }), true);
  });
});

describe('repairErasedDecisions', () => {
  it('Write по файлу с полем решения: исправленное содержимое; массовая потеря строк — не чинится', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-restore-'));
    try {
      writeFileSync(join(root, 'report.md'), BEFORE);
      const fixed = repairErasedDecisions({ kind: 'write', path: 'report.md', content: REWRITTEN }, root);
      ok(fixed.repair !== null);
      ok(fixed.repair.content.includes(`**${LABEL}:**`));
      deepStrictEqual(fixed.loss?.decisionsLost, [LABEL], 'потеря ИСХОДНОГО вызова возвращается вместе с починкой');
      strictEqual(fixed.repair.residual, null);

      const long = `${BEFORE}${Array.from({ length: 60 }, (_, i) => `строка ${i}`).join('\n')}\n`;
      writeFileSync(join(root, 'long.md'), long);
      strictEqual(
        repairErasedDecisions({ kind: 'write', path: 'long.md', content: '# Отчёт\n\nпочти пусто\n' }, root).repair,
        null,
        'новая версия потеряла больше половины файла — это решает человек, а не починка',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('короткий файл (35 строк), переписанный в 3 со стёртым полем, — не чинится', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-restore-'));
    try {
      const short = `${BEFORE}${Array.from({ length: 18 }, (_, i) => `строка ${i}`).join('\n')}\n`;
      writeFileSync(join(root, 'short.md'), short);
      const r = repairErasedDecisions({ kind: 'write', path: 'short.md', content: '# Отчёт\n\nпочти пусто\n' }, root);
      strictEqual(r.loss?.linesBefore, 35);
      strictEqual(r.repair, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('не Write — не наше', () => {
    const r = repairErasedDecisions({ kind: 'bash', command: 'ls' }, tmpdir());
    strictEqual(r.loss, null);
    strictEqual(r.repair, null);
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

  it('включена: починка не идёт по автоправилам — вызов всё равно у человека', async () => {
    const { root, ctx } = setup();
    try {
      const events: PendingApproval[] = [];
      const gate = new ApprovalGate({ onPending: (p) => events.push(p), onResolved: () => {} });
      gate.setAutoApprove('r1', 'explore', { planWrites: true, bash: true, rest: true, mcpWrites: true });
      const pending = writeThrough(gate, ctx(true));
      strictEqual(gate.list().length, 1, 'разрушающая перезапись с подставленным рантаймом полем не автоприменяется');
      const card = gate.list()[0]!;
      ok(card.repaired?.includes(LABEL), card.repaired);
      deepStrictEqual(card.decisionsLost, [LABEL], 'метка стёртого поля — структурно, по ИСХОДНОМУ вызову');
      deepStrictEqual(events[0]?.decisionsLost, [LABEL]);
      gate.resolve('r1', card.requestId, { allowed: false, reason: 'нет', by: 'operator' });
      strictEqual((await pending).allowed, false);
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
      deepStrictEqual(card.decisionsLost, [LABEL]);
      gate.resolve('r1', card.requestId, { allowed: true, updatedInput: null, by: 'operator' });
      const d = await pending;
      ok(d.allowed);
      strictEqual(d.updatedInput, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
