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

import { ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { destructiveOverwrite } from '../src/approval/destructive.ts';
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
});
