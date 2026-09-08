/**
 * Показ путей человеку: релятивизация от projectRoot и короткие формы.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { relativizePaths, tailPath } from '../src/lib/paths.ts';

const ROOT = 'D:\\Проекты\\Agent-SDLC-Runner';

describe('relativizePaths: абсолютный projectRoot → относительный путь', () => {
  it('вырезает корень вместе с разделителем, остаток переводит на `/`', () => {
    strictEqual(
      relativizePaths(ROOT, '— нет файла D:\\Проекты\\Agent-SDLC-Runner\\.sdlc\\ui-review\\intent.md'),
      '— нет файла .sdlc/ui-review/intent.md',
    );
  });

  it('принимает разделители `/` в корне при нативных `\\` в тексте и наоборот', () => {
    strictEqual(
      relativizePaths('D:/Проекты/X', 'нет файла D:\\Проекты\\X\\.sdlc\\plan.md'),
      'нет файла .sdlc/plan.md',
    );
    strictEqual(
      relativizePaths('D:\\Проекты\\X', 'нет файла D:/Проекты/X/.sdlc/plan.md'),
      'нет файла .sdlc/plan.md',
    );
  });

  it('не трогает строку, когда root — не префикс пути (Xy против X)', () => {
    strictEqual(
      relativizePaths(ROOT, '— нет файла D:\\Проекты\\Agent-SDLC-Runner-extra\\.sdlc\\plan.md'),
      '— нет файла D:\\Проекты\\Agent-SDLC-Runner-extra\\.sdlc\\plan.md',
    );
  });

  it('не трогает пути вне корня (другой диск)', () => {
    strictEqual(
      relativizePaths(ROOT, '— нет файла C:\\Windows\\system32\\x.dll'),
      '— нет файла C:\\Windows\\system32\\x.dll',
    );
  });

  it('обрабатывает все вхождения в строке', () => {
    strictEqual(
      relativizePaths(
        ROOT,
        'сравните D:\\Проекты\\Agent-SDLC-Runner\\a.md и D:\\Проекты\\Agent-SDLC-Runner\\b.md',
      ),
      'сравните a.md и b.md',
    );
  });

  it('корень в конце строки вырезается без остатка', () => {
    strictEqual(relativizePaths(ROOT, 'каталог: D:\\Проекты\\Agent-SDLC-Runner'), 'каталог: ');
  });

  it('корень из одного сегмента (буква диска) не вырезается', () => {
    strictEqual(relativizePaths('D:\\', 'файл D:\\anywhere\\a.md'), 'файл D:\\anywhere\\a.md');
  });

  it('пустой корень не вырезается', () => {
    strictEqual(relativizePaths('', 'файл D:\\a.md'), 'файл D:\\a.md');
  });
});

describe('tailPath: короткая форма пути', () => {
  it('длинный путь схлопывается до последних двух сегментов', () => {
    strictEqual(tailPath('D:\\Проекты\\Agent-SDLC-Runner'), '…/Проекты/Agent-SDLC-Runner');
  });

  it('короткий путь возвращается как есть', () => {
    strictEqual(tailPath('D:\\X'), 'D:\\X');
  });

  it('число сегментов настраивается', () => {
    strictEqual(tailPath('D:\\Проекты\\X', 2), '…/Проекты/X');
    strictEqual(tailPath('D:\\Проекты\\X', 4), 'D:\\Проекты\\X');
  });
});

/**
 * POSIX-корни: прод раздаётся из контейнера (`docker compose`), где `projectRoot` —
 * `/work/app`. Ревью: ведущий слэш выпадал из шаблона корня, группа «перед корнем не
 * разделитель» не совпадала никогда, и функция молча ничего не делала — тесты этого не
 * видели, потому что покрывали только Windows-корни.
 */
describe('relativizePaths: POSIX-корни', () => {
  it('корень в середине строки вырезается', () => {
    strictEqual(
      relativizePaths('/work/app', 'нет файла /work/app/.sdlc/x/plan.md'),
      'нет файла .sdlc/x/plan.md',
    );
  });

  it('корень в начале строки вырезается', () => {
    strictEqual(relativizePaths('/work/app', '/work/app/.sdlc/x/plan.md в начале'), '.sdlc/x/plan.md в начале');
  });

  it('соседний каталог с тем же префиксом не трогается', () => {
    strictEqual(
      relativizePaths('/work/app', 'чужой /work/app-extra/src/a.ts'),
      'чужой /work/app-extra/src/a.ts',
    );
  });
});
