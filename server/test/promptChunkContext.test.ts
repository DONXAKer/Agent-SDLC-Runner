/**
 * Контекст этапа 5 в промпте: карточка «Факты от человека» и prefetch файлов плана.
 *
 * Тест герметичный, по образцу `promptEcosystem.test.ts`: тексты этапов и артефакты
 * подкладываются во временный каталог. Обе механики — против замеренных порогов слабых
 * моделей (потеря ответа человека; блуждание Read-ходами), и обе обязаны молчать там,
 * где им не место.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { symlinkSkip } from './platform.ts';
import type { RunnerConfig } from '../src/config/schema.ts';
import { buildPrompt } from '../src/prompt/build.ts';
import { stageById } from '../src/run/stages.ts';
import type { FlowId } from '@sdlc-runner/shared';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-chunk-prompt-')));
after(() => rmSync(root, { recursive: true, force: true }));

const skillsDir = join(root, 'skills');
for (const skill of ['sdlc-chunk', 'sdlc-plan']) {
  mkdirSync(join(skillsDir, skill), { recursive: true });
  writeFileSync(join(skillsDir, skill, 'SKILL.md'), `# ${skill}\nтело этапа\n`);
}

const runner: RunnerConfig = {
  port: 8030,
  operator: 'Гриц',
  skillsDir,
  agentsDir: join(root, 'agents'),
  methodologyDir: join(root, 'methodology'),
  limits: {
    maxToolResultBytes: 1000,
    readRangeRequiredAboveBytes: 1000,
    maxIterationsPerStage: 10,
    gateTimeoutMs: 1000,
    progressClosenessWarn: 0.9,
    chatTimeoutMs: 1000,
    localMaxToolResultBytes: 12_000,
  },
};

mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
writeFileSync(
  join(root, '.sdlc', 'demo', 'clarification-report.md'),
  '## Вопросы и ответы\n| # | Вопрос | Блокирующий | Ответ человека | Что изменилось |\n|---|---|---|---|---|\n' +
    '| 1 | Ставка? | да | 90% от базовой цены | claim-3 |\n' +
    '| 2 | Скоуп? | нет | (пропущено) | ничего |\n',
);
writeFileSync(join(root, 'tariffs.ts'), 'export const base = 100;\n');

function userOf(stage: 'chunk' | 'plan', flow: FlowId, planFiles?: string[]): string {
  return buildPrompt({
    runner,
    stage: stageById(stage),
    ctx: { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 1 },
    flow,
    slug: 'demo',
    now: new Date('2026-01-01T00:00:00Z'),
    ...(planFiles === undefined ? {} : { planFiles }),
  }).user;
}

describe('карточка «Факты от человека» на этапе 5', () => {
  it('ответы с литералами попадают в промпт chunk, пропущенные — нет', () => {
    const u = userOf('chunk', 'loop');
    ok(u.includes('Факты от человека'));
    ok(u.includes('90% от базовой цены'));
    ok(u.includes('90%'));
    strictEqual(u.includes('(пропущено)'), false);
  });

  it('на других этапах карточки нет', () => {
    strictEqual(userOf('plan', 'loop').includes('Факты от человека'), false);
  });
});

describe('prefetch файлов плана на этапе 5 (флоу loop)', () => {
  it('содержимое файла плана лежит в промпте с запретом тратить на него Read', () => {
    const u = userOf('chunk', 'loop', ['tariffs.ts']);
    ok(u.includes('Файлы плана (files_to_touch)'));
    ok(u.includes('export const base = 100;'));
    ok(u.includes('не трать ходы на Read'));
  });

  it('во флоу sdk блока нет: сильной модели дешевле прочитать самой', () => {
    strictEqual(userOf('chunk', 'sdk', ['tariffs.ts']).includes('Файлы плана'), false);
  });

  it('несуществующий, абсолютный и выводящий за корень пути пропускаются молча', () => {
    // `../…` — ревью (К4): относительный путь из плана выводил чтение рантайма за корень
    // проекта мимо pathScope, и содержимое уезжало в промпт внешнему провайдеру.
    const u = userOf('chunk', 'loop', ['нет-такого.ts', '/etc/passwd', '../secret.txt']);
    strictEqual(u.includes('Файлы плана'), false);
    strictEqual(u.includes('secret'), false);
  });

  it('симлинк внутри корня, указывающий наружу, не читается (ревью-2, BLOCKER)', { skip: symlinkSkip ?? false }, () => {
    const outside = join(tmpdir(), `sdlc-prefetch-outside-${process.pid}.txt`);
    writeFileSync(outside, 'SECRET-CONTENT\n');
    symlinkSync(outside, join(root, 'link.ts'));
    try {
      const u = userOf('chunk', 'loop', ['link.ts', 'tariffs.ts']);
      strictEqual(u.includes('SECRET-CONTENT'), false);
      // Честный файл рядом по-прежнему префетчится.
      ok(u.includes('export const base = 100;'));
    } finally {
      rmSync(join(root, 'link.ts'), { force: true });
      rmSync(outside, { force: true });
    }
  });
});
