/**
 * Разрушающая перезапись и ложная команда в строке набора.
 *
 * Обе проверки родились из одного замера (`docs/model-runs.md`, этапы 5–6):
 *
 *  - исполнитель заменил файл на 1235 строк одиннадцатистрочной заглушкой, и все проверки
 *    отработали как написаны — путь был в плане, значит запись законна;
 *  - гейт секретов покраснел, потому что разбор строки набора взял `.env` из обратных
 *    кавычек за команду и попытался её выполнить.
 *
 * Первое проверяется на настоящих файлах: порог считается по строкам, и подделывать
 * файловую систему значило бы проверить собственную арифметику вместо поведения.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { destructiveNote, destructiveOverwrite } from '../src/approval/destructive.ts';
import { parseCommand } from '../src/gates/gatesFile.ts';
import type { NormalizedCall } from '@sdlc-runner/shared';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(join(tmpdir(), 'sdlc-destructive-'));
  roots.push(r);
  return r;
}

function lines(n: number): string {
  return Array.from({ length: n }, (_, i) => `строка ${i}`).join('\n') + '\n';
}

function write(path: string, content: string): NormalizedCall {
  return { kind: 'write', path, content };
}

describe('разрушающая перезапись', () => {
  it('замена длинного файла заглушкой ловится и называет числа', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), lines(1235));
    const d = destructiveOverwrite(write('big.ts', lines(11)), r);
    ok(d !== null, 'потеря обязана быть замечена');
    strictEqual(d.linesBefore, 1235);
    strictEqual(d.linesAfter, 11);
    strictEqual(d.linesLost, 1224);
  });

  it('создание нового файла разрушением не считается', () => {
    const r = root();
    strictEqual(destructiveOverwrite(write('новый.ts', lines(5)), r), null);
  });

  it('обычная правка длинного файла проходит без предупреждения', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), lines(200));
    strictEqual(destructiveOverwrite(write('big.ts', lines(196)), r), null);
  });

  it('короткий файл порога не достигает: правило не должно быть шумом', () => {
    const r = root();
    writeFileSync(join(r, '.gitignore'), lines(6));
    strictEqual(destructiveOverwrite(write('.gitignore', 'node_modules/\n'), r), null);
  });

  it('рост файла разрушением не считается', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), lines(100));
    strictEqual(destructiveOverwrite(write('big.ts', lines(300)), r), null);
  });

  it('перезапись, стирающая поле решения человека, ловится при ЛЮБОМ объёме', () => {
    // Класс, измеренный 2026-09-04 на пяти задачах из четырнадцати: модель перезаписывает
    // отчёт разведки целиком, текст выходит НЕ короче, порог доли молчит — и вместе с
    // записью исчезает поле, которое заполняет человек.
    const r = root();
    const before = `${lines(20)}\n**Решение человека о полноте:** лист полон — Иван · 2026-08-16\n`;
    writeFileSync(join(r, 'exploration-report.md'), before);
    const d = destructiveOverwrite(write('exploration-report.md', lines(60)), r);
    ok(d !== null, 'потеря поля решения обязана быть замечена');
    deepStrictEqual(d.decisionsLost, ['Решение человека о полноте']);
    ok(d.linesAfter > d.linesBefore, 'файл при этом ВЫРОС — доля строк такую потерю не видит');
    const note = destructiveNote(d);
    ok(note.includes('Решение человека о полноте'), 'поле названо');
    ok(note.includes('Edit'), 'сказано, чем чинить, — иначе модель повторит тот же Write');
  });

  it('перезапись, сохранившая поле решения, разрушением не считается', () => {
    const r = root();
    const field = '**Решение человека о полноте:** лист полон — Иван · 2026-08-16\n';
    writeFileSync(join(r, 'exploration-report.md'), `${lines(20)}\n${field}`);
    strictEqual(destructiveOverwrite(write('exploration-report.md', `${lines(60)}\n${field}`), r), null);
  });

  it('файл без полей решений считается по-старому, только по доле строк', () => {
    // Новая проверка не должна подменять прежнюю: у обычного файла кода полей решений нет,
    // и его судьбу по-прежнему решает порог потери.
    const r = root();
    writeFileSync(join(r, 'src.ts'), lines(200));
    strictEqual(destructiveOverwrite(write('src.ts', lines(196)), r), null);
    ok(destructiveOverwrite(write('src.ts', lines(11)), r) !== null);
  });

  it('Edit под правило не подпадает — он не может потерять файл целиком', () => {
    const r = root();
    writeFileSync(join(r, 'big.ts'), lines(1000));
    const call: NormalizedCall = {
      kind: 'edit',
      path: 'big.ts',
      edits: [{ oldStr: 'строка 1', newStr: 'строка 1 (правка)', replaceAll: false }],
    };
    strictEqual(destructiveOverwrite(call, r), null);
  });
});

describe('команда в строке набора', () => {
  it('имя файла в кавычках командой не считается', () => {
    strictEqual(
      parseCommand('встроенная реализация: ключи, токены и `.env` в добавленных строках'),
      null,
    );
  });

  it('явный вызов из текущего каталога командой считается', () => {
    strictEqual(parseCommand('прогон через `./gradlew test`'), './gradlew test');
  });

  it('вызов без аргументов, но с путём, командой считается', () => {
    strictEqual(parseCommand('собирается через `./mvnw`'), './mvnw');
  });

  it('ячейка целиком из одной команды остаётся командой', () => {
    strictEqual(parseCommand('`npm test`'), 'npm test');
    strictEqual(parseCommand('`make`'), 'make');
  });

  it('процитированный путь в прозе командой не считается', () => {
    strictEqual(parseCommand('изменения в `backend/src/test/**` сверяются с планом'), null);
  });

  // Найдено прогоном настоящего parseGates по собственному набору раннера: обязательный гейт
  // «Scope: файлы вне плана» исполнял процитированный `git diff` вместо встроенной реализации,
  // а `git diff` выходит с кодом 0 при любом выводе — гейт зеленел всегда.
  it('процитированная команда не подменяет объявленную встроенную реализацию', () => {
    strictEqual(
      parseCommand('встроенная реализация: `git diff` от базы chunk’а против `files_to_touch`'),
      null,
    );
    strictEqual(
      parseCommand('встроенная реализация: нетракованные файлы вне `.sdlc/`; игнорируемые не в счёт'),
      null,
    );
  });

  it('объявление встроенной реализации не мешает настоящей команде в соседней строке', () => {
    strictEqual(parseCommand('`npm run typecheck` — прод исполняет TypeScript напрямую'), 'npm run typecheck');
  });
});
