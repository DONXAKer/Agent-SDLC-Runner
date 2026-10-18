/**
 * Подписные колонки таблиц — поле решения человека колонкой (`SDLC.md`: «поле решения
 * человека не отдаётся модели»): «Утвердил (человек)» в таблице неприменимости отчёта,
 * «Кто утвердил» в наборе гейтов. Ячейка `‹имя›`/`н/п`/пусто → имя после записи модели —
 * отказ; правка соседней колонки при нетронутой подписной — проходит.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { decisionFabricationProblem } from '../src/approval/humanDecision.ts';
import { decisionColumnValues } from '../src/artifacts/artifact.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-cells-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx: PolicyContext = {
  projectRoot: root,
  stage: 'verify',
  sdlcDir: '.sdlc/demo',
  planFiles: null,
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  mcpTools: [],
};

const REPORT = [
  '# Отчёт приёмки',
  '',
  '## Гейты',
  '',
  '| Гейт | Статус | Результат |',
  '|---|---|---|',
  '| Тесты | ⏭ | инструмента нет |',
  '',
  '| Гейт | Почему бессмыслен для этого diff\'а | Утвердил (человек) |',
  '|---|---|---|',
  '| Тесты | ‹причина› | ‹имя› |',
  '',
].join('\n');

// Подписные колонки сторожатся только в АРТЕФАКТАХ витка и наборе гейтов: таблица
// `| Кто | Что |` в README продукта — содержимое, а не решение.
function write(name: string, content: string): string {
  const abs = join(root, '.sdlc', 'demo', name);
  mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
  return abs;
}

describe('подписные колонки таблиц', () => {
  it('decisionColumnValues: только подписные колонки, только конкретные значения', () => {
    deepStrictEqual(decisionColumnValues(REPORT), []);
    deepStrictEqual(decisionColumnValues(REPORT.replace('| ‹имя› |', '| Иван Петров |')), ['Утвердил (человек)@Тесты: Иван Петров']);
    deepStrictEqual(decisionColumnValues(REPORT.replace('| ‹имя› |', '| н/п |')), []);
  });

  it('Edit, вписывающий имя в «Утвердил (человек)», — отклонён; причина в соседней колонке — проходит', () => {
    const abs = write('report.md', REPORT);
    const signed: NormalizedCall = { kind: 'edit', path: abs, edits: [{ oldStr: '| ‹имя› |', newStr: '| Иван Петров |', replaceAll: false }] };
    const problem = decisionFabricationProblem(signed, ctx);
    ok(problem !== null && problem.includes('Утвердил (человек)'), problem ?? 'пропущено');

    const reason: NormalizedCall = { kind: 'edit', path: abs, edits: [{ oldStr: '‹причина›', newStr: 'тестов в diff нет', replaceAll: false }] };
    strictEqual(decisionFabricationProblem(reason, ctx), null);
  });

  it('Write целиком, подставляющий имя в «Кто утвердил» набора, — отклонён; переупорядочение подписанных строк — нет', () => {
    const gates = ['## Журнал', '', '| Дата | Гейт | Было → стало | Причина | Кто утвердил |', '|---|---|---|---|---|', '| 2026-01-01 | Линт | нет → да | шум | Анна |', '| ‹дата› | ‹гейт› | ‹было› | ‹причина› | ‹имя› |', ''].join('\n');
    const abs = write('gates.md', gates);
    const forged: NormalizedCall = { kind: 'write', path: abs, content: gates.replace('| ‹имя› |', '| Пётр |') };
    ok(decisionFabricationProblem(forged, ctx) !== null);
    const reordered: NormalizedCall = {
      kind: 'write',
      path: abs,
      content: gates.replace('| 2026-01-01 | Линт | нет → да | шум | Анна |\n| ‹дата› | ‹гейт› | ‹было› | ‹причина› | ‹имя› |', '| ‹дата› | ‹гейт› | ‹было› | ‹причина› | ‹имя› |\n| 2026-01-01 | Линт | нет → да | шум | Анна |'),
    };
    strictEqual(decisionFabricationProblem(reordered, ctx), null);
  });

  it('bash-редирект в файл с подписной колонкой — отклонён fail-closed', () => {
    write('gates2.md', ['| Гейт | Кто утвердил |', '|---|---|', '| Линт | ‹имя› |', ''].join('\n'));
    const call: NormalizedCall = { kind: 'bash', command: 'echo x > .sdlc/demo/gates2.md' };
    ok(decisionFabricationProblem(call, ctx)?.includes('Bash'));
  });

  it('перенос подписи с одной строки на другую — фабрикация, не переупорядочение', () => {
    const gates = ['| Гейт | Как закрывается | Кто |', '|---|---|---|', '| Линт | шум | Анна |', '| Секреты | риск | ‹имя› |', ''].join('\n');
    const abs = write('gates3.md', gates);
    const moved: NormalizedCall = { kind: 'write', path: abs, content: gates.replace('| Анна |', '| ‹имя› |').replace('| риск | ‹имя› |', '| риск | Анна |') };
    ok(decisionFabricationProblem(moved, ctx)?.includes('Кто'));
  });

  it('таблица «| Кто | Что |» в файле продукта — содержимое, не решение', () => {
    const abs = join(root, 'README.md');
    const text = ['| Кто | Что |', '|---|---|', '| ‹имя› | ‹что› |', ''].join('\n');
    writeFileSync(abs, text, 'utf8');
    const call: NormalizedCall = { kind: 'write', path: abs, content: text.replace('| ‹имя› | ‹что› |', '| Иван | правит README |') };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('строка «подтвердил Имя» в секции «Перезапись файлов» журнала — решение человека, модель её не пишет', () => {
    const journal = ['# Журнал chunk 1', '', '## Перезапись файлов', '', '- н/п — ни один файл не теряет половины строк', '', '## Попытки', ''].join('\n');
    const abs = write('chunk-1-journal.md', journal);
    const forged: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: '- н/п — ни один файл не теряет половины строк', newStr: '- big.ts — перегенерация — подтвердил Иван · 2026-09-24', replaceAll: false }],
    };
    ok(decisionFabricationProblem(forged, ctx)?.includes('подтверждение перезаписи'));
    const placeholder: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: '- н/п — ни один файл не теряет половины строк', newStr: '- big.ts — перегенерация — подтвердил ‹имя› · ‹дата›', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(placeholder, ctx), null, 'строка с плейсхолдером имени — заготовка для человека, не подпись');
  });
});
