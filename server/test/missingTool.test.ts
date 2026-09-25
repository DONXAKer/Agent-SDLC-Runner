/**
 * `missingTool` — улика отсутствующего инструмента называет САМ инструмент команды: «No such
 * file or directory» из лога тестов (тест честно проверяет отсутствующий файл) средой не
 * является. Порт `sdlc_common.missing_tool` методологии.
 */

import { strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { firstToken, missingTool } from '../src/gates/missingTool.ts';

describe('missingTool', () => {
  it('код 127/9009 — улика по первой строке вывода либо по коду', () => {
    strictEqual(missingTool('bash: gradlew: command not found\n', './gradlew test', 127), 'bash: gradlew: command not found');
    strictEqual(missingTool('', 'mvn test', 9009), 'код возврата 9009');
  });

  it('строка оболочки с именем инструмента — улика и при коде 1', () => {
    strictEqual(
      missingTool("'mvn' is not recognized as an internal or external command\n", 'mvn -q test', 1),
      "'mvn' is not recognized as an internal or external command",
    );
    strictEqual(missingTool('bash: ./gradlew: No such file or directory', './gradlew test', 1), 'bash: ./gradlew: No such file or directory');
  });

  it('«No such file» из лога тестов без имени инструмента — не среда', () => {
    strictEqual(missingTool('FAIL test_config: [Errno 2] No such file or directory: config.yml\n', 'pytest -q', 1), null);
    strictEqual(missingTool('all good\n', 'npm test', 0), null);
  });

  it('имя инструмента внутри пути лога (node_modules, npm-shrinkwrap) — не улика; код 126 — не среда', () => {
    strictEqual(missingTool("Error: ENOENT: no such file or directory, open 'C:\\proj\\node_modules\\pkg\\config.json'", 'node --test', 1), null);
    strictEqual(missingTool('ENOENT: no such file or directory, open npm-shrinkwrap.json', 'npm test', 1), null);
    strictEqual(missingTool("FileNotFoundError: No such file or directory: 'data/python_config.yml'", 'python -m pytest', 1), null);
    strictEqual(missingTool('bash: ./gradlew: Permission denied', './gradlew test', 126), null);
  });

  it('первый токен пропускает префиксы окружения', () => {
    strictEqual(firstToken('FOO=1 BAR=x npm test'), 'npm');
    strictEqual(firstToken('./gradlew test'), './gradlew');
    strictEqual(firstToken(''), '');
  });
});
