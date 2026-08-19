/**
 * Языковой контекст в adapter-блоке промпта.
 *
 * Тест герметичный: тексты этапов подкладываются во временный каталог, а не читаются из
 * эталона методологии с диска оператора. Соседний `prompt.test.ts` зависит от эталона и на
 * машине без него не проходит вовсе — повторять эту зависимость ради четырёх проверок
 * незачем.
 *
 * Главная проверяемая планка — честность: когда экосистема не определилась, блок обязан
 * молчать. Модель, которой сказали «сборка: npm run build» в проекте без `package.json`,
 * потратит итерацию на починку несуществующей поломки.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import type { RunnerConfig } from '../src/config/schema.ts';
import { buildPrompt } from '../src/prompt/build.ts';
import { stageById } from '../src/run/stages.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-eco-prompt-'));
after(() => rmSync(root, { recursive: true, force: true }));

const skillsDir = join(root, 'skills');
mkdirSync(join(skillsDir, 'sdlc-chunk'), { recursive: true });
writeFileSync(join(skillsDir, 'sdlc-chunk', 'SKILL.md'), '# Этап 5\nтело этапа\n');

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
  },
};

type EcoLine = { dir: string; label: string; build: string; test: string | null };

function systemOf(ecosystem?: EcoLine[]): string {
  return buildPrompt({
    runner,
    stage: stageById('chunk'),
    ctx: { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 1 },
    flow: 'sdk',
    slug: 'demo',
    now: new Date('2026-01-01T00:00:00Z'),
    ...(ecosystem === undefined ? {} : { ecosystem }),
  }).system;
}

describe('языковой контекст в adapter-блоке', () => {
  it('без описания экосистемы блок молчит, а не гадает', () => {
    strictEqual(systemOf().includes('проверяется на этапе 6'), false);
    strictEqual(systemOf([]).includes('проверяется на этапе 6'), false);
  });

  it('один модуль: обе команды названы дословно', () => {
    const s = systemOf([
      { dir: '.', label: 'Go', build: 'go build ./...', test: 'go test ./...' },
    ]);
    ok(s.includes('go build ./...'), 'нет команды сборки');
    ok(s.includes('go test ./...'), 'нет команды тестов');
    ok(s.includes('Go'), 'не названа экосистема');
  });

  it('отсутствие тест-раннера названо прямо, а не пропущено', () => {
    const s = systemOf([
      { dir: 'web', label: 'Node.js', build: 'npm run build', test: null },
    ]);
    ok(s.includes('НЕ ЗАПУСКАЮТСЯ'));
    // Последствие названо там же: иначе «тестов нет» читается как «тесты не нужны».
    ok(s.includes('неподтверждёнными'));
  });

  it('несколько модулей перечисляются по одному', () => {
    const s = systemOf([
      { dir: 'api', label: 'Go', build: 'go build ./...', test: 'go test ./...' },
      { dir: 'web', label: 'Node.js', build: 'npm run build', test: 'npm test --silent' },
    ]);
    ok(s.includes('Модулей в плане несколько (2)'));
    ok(s.includes('`api`') && s.includes('`web`'));
  });

  it('блок описывает факт, а не даёт наставление', () => {
    const s = systemOf([{ dir: '.', label: 'Go', build: 'go build ./...', test: null }]);
    // «Пиши идиоматично» — не проверяемое утверждение; «гейт прогоняет вот эту команду» —
    // проверяемое прогоном. В блоке должно быть второе.
    strictEqual(/пиши идиоматично|соблюдай стиль/i.test(s), false);
  });
});
