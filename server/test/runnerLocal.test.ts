/**
 * Машинное поверх переносимого: `config/runner.local.json` и переменные окружения.
 *
 * Смысл разделения в том, что в репозитории не должно лежать ни имени человека, ни
 * абсолютных путей его машины. Отсюда три проверки: локальный файл побеждает общий,
 * окружение побеждает оба, а `~` в закоммиченном умолчании разворачивается — иначе
 * «переносимое умолчание» работало бы ровно на одной машине.
 */

import { ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { RunnerConfig } from '../src/config/schema.ts';
import {
  OPERATOR_PLACEHOLDER,
  expandUserPath,
  loadConfig,
  operatorProblem,
} from '../src/config/load.ts';
import { withEnv, withEnvAll } from './testUtils.ts';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Каталог конфигурации с общим `runner.json` и — по желанию — локальным поверх него. */
function configDir(local: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-runnercfg-'));
  dirs.push(dir);

  writeFileSync(
    join(dir, 'runner.json'),
    JSON.stringify({
      port: 8030,
      operator: OPERATOR_PLACEHOLDER,
      skillsDir: '~/.claude/skills',
      agentsDir: '~/.claude/agents',
      methodologyDir: '~/Code/Agent-SDLC',
      limits: { maxToolResultBytes: 60000 },
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ providers: {}, models: [] }), 'utf8');

  // Хотя бы один проект: без него загрузка честно отказывается — «нечего запускать».
  mkdirSync(join(dir, 'projects'));
  writeFileSync(
    join(dir, 'projects', 'p.json'),
    JSON.stringify({
      name: 'p',
      projectRoot: dir,
      activeProfile: 'x',
      maxBudgetUsd: 1,
      profiles: {},
    }),
    'utf8',
  );

  if (local !== null) {
    writeFileSync(join(dir, 'runner.local.json'), JSON.stringify(local), 'utf8');
  }
  return dir;
}

const runnerFrom = (dir: string): RunnerConfig => loadConfig(dir).runner;

describe('runner.local.json поверх runner.json', () => {
  it('без локального файла остаются переносимые умолчания', () => {
    withEnvAll({ SDLC_OPERATOR: undefined, SDLC_METHODOLOGY_DIR: undefined }, () => {
      const r = runnerFrom(configDir(null));
      strictEqual(r.operator, OPERATOR_PLACEHOLDER);
      strictEqual(r.methodologyDir, join(homedir(), 'Code/Agent-SDLC'));
    });
  });

  it('локальный файл побеждает общий', () => {
    withEnvAll({ SDLC_OPERATOR: undefined, SDLC_METHODOLOGY_DIR: undefined }, () => {
      const r = runnerFrom(configDir({ operator: 'Иванов Иван', methodologyDir: 'D:/эталон' }));
      strictEqual(r.operator, 'Иванов Иван');
      strictEqual(r.methodologyDir, 'D:/эталон');
      // Незаданное локально берётся из общего файла — это наложение, а не замена.
      strictEqual(r.port, 8030);
    });
  });

  it('окружение побеждает и локальный файл', () => {
    const dir = configDir({ operator: 'Иванов Иван' });
    withEnv('SDLC_OPERATOR', 'Петров Пётр', () => {
      strictEqual(runnerFrom(dir).operator, 'Петров Пётр');
    });
  });

  it('лимиты сливаются, а не заменяются целиком', () => {
    withEnv('SDLC_OPERATOR', undefined, () => {
      const r = runnerFrom(configDir({ limits: { chatTimeoutMs: 1234 } }));
      strictEqual(r.limits.chatTimeoutMs, 1234);
      // Остальные значения не потерялись вместе с блоком.
      strictEqual(r.limits.maxToolResultBytes, 60000);
    });
  });
});

describe('пути в конфигурации переносимы', () => {
  it('ведущая тильда разворачивается в домашний каталог', () => {
    strictEqual(expandUserPath('~/.claude/skills'), join(homedir(), '.claude/skills'));
    strictEqual(expandUserPath('~'), homedir());
  });

  it('тильда в середине пути — это имя каталога, а не домашний', () => {
    strictEqual(expandUserPath('/opt/~backup/x'), '/opt/~backup/x');
  });

  it('${VAR} берётся из окружения, незаданная переменная остаётся как есть', () => {
    withEnv('SDLC_TEST_DIR', 'D:/эталон', () => {
      strictEqual(expandUserPath('${SDLC_TEST_DIR}/skills'), 'D:/эталон/skills');
    });
    strictEqual(expandUserPath('${НЕТ_ТАКОЙ_XYZ}/skills'), '${НЕТ_ТАКОЙ_XYZ}/skills');
  });
});

describe('виток не стартует с безымянным оператором', () => {
  const withOperator = (operator: string): RunnerConfig =>
    ({ operator }) as unknown as RunnerConfig;

  it('заглушка из репозитория — не имя', () => {
    const problem = operatorProblem(withOperator(OPERATOR_PLACEHOLDER));
    ok(problem !== null);
    // Сообщение обязано называть, что именно чинить: без этого оператор видит только отказ.
    ok(problem.includes('SDLC_OPERATOR'));
    ok(problem.includes('runner.local.json'));
  });

  it('пустая строка и пробелы — тоже не имя', () => {
    ok(operatorProblem(withOperator('')) !== null);
    ok(operatorProblem(withOperator('   ')) !== null);
  });

  it('заданное имя проблемой не считается', () => {
    strictEqual(operatorProblem(withOperator('Иванов Иван')), null);
  });
});
