/**
 * Фабрикация поля решения человека — `Edit`/`Write`, который переводит поле из
 * «не решено» (плейсхолдер) в «решено», минуя оператора. Отдельно от `destructiveWrite.test.ts`:
 * там теряется МЕТКА поля, здесь метка остаётся на месте, меняется только значение —
 * `lostDecisionLabels` этот класс не видит по построению.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { NormalizedCall, PolicyContext } from '@sdlc-runner/shared';

import { decisionFabricationProblem } from '../src/approval/humanDecision.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-humandecision-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx: PolicyContext = {
  projectRoot: root,
  stage: 'handoff',
  sdlcDir: '.sdlc/demo',
  planFiles: null,
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit'],
  mcpTools: [],
};

function write(rel: string, content: string): string {
  const abs = join(root, rel);
  writeFileSync(abs, content, 'utf8');
  return abs;
}

const HANDOFF = [
  '# Передача контекста: demo',
  '',
  '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
  '',
  '## Что сделано',
  '',
  '- версия поднята до 2',
  '',
].join('\n');

describe('decisionFabricationProblem', () => {
  it('Edit, вписывающий имя и дату в плейсхолдер решения, — отклонён', () => {
    const abs = write('handoff.md', HANDOFF);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: '‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**', newStr: 'Иван Петров · 2026-09-18', replaceAll: false }],
    };
    const problem = decisionFabricationProblem(call, ctx);
    ok(problem !== null, 'ожидался отказ');
    ok(problem!.includes('Приёмка'), problem);
  });

  it('Edit вне поля решения — не трогает', () => {
    const abs = write('handoff.md', HANDOFF);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: 'версия поднята до 2', newStr: 'версия поднята до 3', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('Write целиком, фабрикующий решение, — отклонён', () => {
    const abs = write('handoff.md', HANDOFF);
    const content = HANDOFF.replace(
      '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
      '- **Приёмка:** принял Иван Петров · 2026-09-18',
    );
    const call: NormalizedCall = { kind: 'write', path: abs, content };
    ok(decisionFabricationProblem(call, ctx) !== null);
  });

  it('old_string не найден дословно — гейт не гадает, пропускает', () => {
    const abs = write('handoff.md', HANDOFF);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: 'текста, которого в файле нет', newStr: 'что угодно', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('решение уже принято и правка его не меняет — пропускает', () => {
    const already = HANDOFF.replace(
      '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
      '- **Приёмка:** принял Иван Петров · 2026-09-18',
    );
    const abs = write('handoff.md', already);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: 'версия поднята до 2', newStr: 'версия поднята до 3', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('файла ещё нет на диске — пропускает (нечего сравнивать)', () => {
    const abs = join(root, 'nope.md');
    const call: NormalizedCall = { kind: 'write', path: abs, content: '- **Приёмка:** принял X · 2026-01-01\n' };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('несколько вхождений одной метки: фабрикация одной из двух ловится, число вхождений не изменилось', () => {
    const twoRecords = [
      '### Запись 1',
      '- **Кто утвердил:** н/п / ‹имя›',
      '',
      '### Запись 2',
      '- **Кто утвердил:** н/п / ‹имя›',
      '',
    ].join('\n');
    const abs = write('two.md', twoRecords);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [
        {
          oldStr: '### Запись 2\n- **Кто утвердил:** н/п / ‹имя›',
          newStr: '### Запись 2\n- **Кто утвердил:** Иван Петров · 2026-09-18',
          replaceAll: false,
        },
      ],
    };
    ok(decisionFabricationProblem(call, ctx) !== null);
  });

  it('добавление новой записи со своим пустым полем — не фабрикация (число вхождений выросло)', () => {
    const oneRecord = ['### Запись 1', '- **Кто утвердил:** н/п / ‹имя›', ''].join('\n');
    const abs = write('grow.md', oneRecord);
    const withSecond = oneRecord + ['### Запись 2', '- **Кто утвердил:** н/п / ‹имя›', ''].join('\n');
    const call: NormalizedCall = { kind: 'write', path: abs, content: withSecond };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('read не проверяется — не запись вовсе', () => {
    write('handoff.md', HANDOFF);
    const read: NormalizedCall = { kind: 'read', path: 'handoff.md', range: null };
    strictEqual(decisionFabricationProblem(read, ctx), null);
  });

  it('bash без цели записи (нет редиректа) — не проверяется, проверять нечего', () => {
    write('handoff.md', HANDOFF);
    const bash: NormalizedCall = { kind: 'bash', command: 'echo hi' };
    strictEqual(decisionFabricationProblem(bash, ctx), null);
  });

  // Регрессия ревью (2026-09-19): раньше `call.kind === 'bash'` пропускался с первой
  // строки функции целиком — редирект в файл с полем решения фабриковал его мимо
  // единственной защиты. Теперь bash-редирект в такой файл отклоняется fail-closed
  // (дословно предсказать результат произвольной команды нельзя), а не молча пропускается.

  it('bash-редирект в файл с полем решения — отклонён fail-closed, даже без сравнения «до/после»', () => {
    write('handoff.md', HANDOFF);
    const bash: NormalizedCall = { kind: 'bash', command: 'echo "Иван Петров · 2026-09-19" >> handoff.md' };
    const problem = decisionFabricationProblem(bash, ctx);
    ok(problem !== null, 'ожидался отказ');
    ok(problem!.includes('Bash'), problem);
  });

  it('bash-редирект в файл БЕЗ полей решения — не отклоняется', () => {
    write('notes.md', '# Заметки\n\nобычный файл без решений\n');
    const bash: NormalizedCall = { kind: 'bash', command: 'echo "готово" >> notes.md' };
    strictEqual(decisionFabricationProblem(bash, ctx), null);
  });

  it('bash-редирект в НЕСУЩЕСТВУЮЩИЙ файл — не отклоняется (нечего фабриковать)', () => {
    const bash: NormalizedCall = { kind: 'bash', command: 'echo "x" >> new-file.md' };
    strictEqual(decisionFabricationProblem(bash, ctx), null);
  });

  // Три регрессии, найденные code-review-all (2026-09-18) и подтверждённые живым прогоном
  // против настоящего handoff.template.md — воспроизведены здесь герметично.

  const HANDOFF_WRAPPED = [
    '# Передача контекста: demo',
    '',
    '### Запись 1',
    '',
    '- **Кто утвердил:** _(только имя из явного ответа человека на вопрос об этой записи — не имя',
    '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
    '  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа',
    '- **Где реализовано:** н/п / ‹путь:символ›',
  ].join('\n');

  it('минимальная правка ‹имя› на строке-продолжении не читается как решение (обе ветки меню ещё в тексте)', () => {
    // `readDecision` намеренно не признаёт поле решённым, пока в нём остались ОБЕ ветки
    // меню («н/п / … / **(дефолт)**…») — та же защита, что уже работает для однострочных
    // полей. Точечная правка ‹имя› без удаления соседних веток честно остаётся
    // «placeholder», а не тихо становится дырой — фиксируем это явно, а не считаем багом.
    const abs = write('handoff-wrapped-partial.md', HANDOFF_WRAPPED);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: 'н/п / ‹имя› /', newStr: 'н/п / Иван Петров · 2026-09-18 /', replaceAll: false }],
    };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });

  it('фабрикация на СТРОКЕ-ПРОДОЛЖЕНИИ (реальная форма поля «Кто утвердил») — ловится', () => {
    // Правдоподобная фабрикация: поле схлопнуто до чистого решённого значения — так
    // выглядит легитимно заполненное поле везде в методологии. До фикса continuation-
    // строка вообще не читалась `readDecision`, и это проходило гейт как «н/п».
    const abs = write('handoff-wrapped.md', HANDOFF_WRAPPED);
    const oldStr = [
      '_(только имя из явного ответа человека на вопрос об этой записи — не имя',
      '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
      "  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа",
    ].join('\n');
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr, newStr: 'Иван Петров · 2026-09-18', replaceAll: false }],
    };
    const problem = decisionFabricationProblem(call, ctx);
    ok(problem !== null, 'фабрикация на строке-продолжении обязана ловиться');
  });

  it('отмена принятого отказа (declined → granted) — ловится как фабрикация', () => {
    const declined = HANDOFF.replace(
      '- **Приёмка:** принял ‹имя› · ‹дата› / **не принималась — обрыв: ‹почему›**',
      '- **Приёмка:** не принималась — обрыв: сломан билд',
    );
    const abs = write('declined.md', declined);
    const call: NormalizedCall = {
      kind: 'edit',
      path: abs,
      edits: [{ oldStr: 'не принималась — обрыв: сломан билд', newStr: 'принял Иван Петров · 2026-09-18', replaceAll: false }],
    };
    ok(decisionFabricationProblem(call, ctx) !== null, 'отмена отказа человека обязана ловиться');
  });

  it('одновременно: добавлена новая пустая запись И сфабрикована существующая — ловится', () => {
    const oneRecord = ['### Запись 1', '- **Кто утвердил:** н/п / ‹имя›', ''].join('\n');
    const abs = write('simultaneous.md', oneRecord);
    const withBoth = [
      '### Запись 1',
      '- **Кто утвердил:** Иван Петров · 2026-09-18', // фабрикация существующей
      '',
      '### Запись 2', // легитимно новая, поле по-прежнему пусто
      '- **Кто утвердил:** н/п / ‹имя›',
      '',
    ].join('\n');
    const call: NormalizedCall = { kind: 'write', path: abs, content: withBoth };
    ok(
      decisionFabricationProblem(call, ctx) !== null,
      'число вхождений выросло (легитимно), но фабрикация первой записи всё равно обязана ловиться',
    );
  });

  it('переупорядочение двух УЖЕ решённых записей без изменения текста — не фабрикация', () => {
    const twoDecided = [
      '### Запись 1',
      '- **Кто утвердил:** Анна Смирнова · 2026-09-10',
      '',
      '### Запись 2',
      '- **Кто утвердил:** Иван Петров · 2026-09-18',
      '',
    ].join('\n');
    const abs = write('reordered.md', twoDecided);
    const reordered = [
      '### Запись 2',
      '- **Кто утвердил:** Иван Петров · 2026-09-18',
      '',
      '### Запись 1',
      '- **Кто утвердил:** Анна Смирнова · 2026-09-10',
      '',
    ].join('\n');
    const call: NormalizedCall = { kind: 'write', path: abs, content: reordered };
    strictEqual(decisionFabricationProblem(call, ctx), null);
  });
});
