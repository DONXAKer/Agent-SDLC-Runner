/**
 * Блок «Индекс проекта» в промпте этапа 2 (`BuildPromptInput.exploreIndex`).
 *
 * Герметично, по образцу `promptEcosystem.test.ts`: тексты этапов во временном каталоге.
 * Главные планки: без поля промпт байт-в-байт прежний (ничего не подмешивается незаметно);
 * блок только на explore; потолок по флоу; adapter-блок говорит «не трать ходы на обход».
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ok, strictEqual } from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { WitokPaths } from '../src/artifacts/paths.ts';
import type { RunnerConfig } from '../src/config/schema.ts';
import { INDEX_BLOCK_BYTES, renderIndexBlock } from '../src/explore/render.ts';
import type { ExploreIndexView } from '../src/explore/view.ts';
import { buildPrompt } from '../src/prompt/build.ts';
import { stageById } from '../src/run/stages.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-explore-prompt-')));
after(() => rmSync(root, { recursive: true, force: true }));

const skillsDir = join(root, 'skills');
for (const skill of ['sdlc-explore', 'sdlc-plan']) {
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
    localHistoryBudgetBytes: 40_000,
  },
};

function view(treeSize = 3): ExploreIndexView {
  return {
    stack: [{ dir: '.', label: 'Node.js', build: null, test: 'node --test' }],
    tree: Array.from({ length: treeSize }, (_, i) => ({ path: `src/file${i}.ts`, lines: 10 + i, kind: 'code' as const })),
    treeTotal: treeSize,
    skipped: { files: 0, bytes: 0 },
    readmeHead: '# demo\nсоглашения проекта',
    candidates: [{ path: 'src/tariffs.ts', lines: 157, kind: 'code', symbols: ['priceFor', 'weightStep'], why: ['путь назван в задаче'] }],
    reuse: [{ path: 'src/money.ts', symbol: 'subtract', signature: 'export function subtract(a, b)', callers: 3, why: [] }],
    axes: null,
  };
}

function build(
  stage: 'explore' | 'plan',
  flow: 'loop' | 'sdk',
  v?: ExploreIndexView,
  contextWindow?: number,
  extra?: string,
) {
  return buildPrompt({
    runner,
    stage: stageById(stage),
    ctx: { paths: new WitokPaths(root, 'demo'), chunk: 1, attempt: 1 },
    flow,
    slug: 'demo',
    now: new Date('2026-01-01T00:00:00Z'),
    ...(v === undefined ? {} : { exploreIndex: v }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(extra === undefined ? {} : { extra }),
  });
}

describe('блок индекса проекта в промпте', () => {
  it('без поля промпт байт-в-байт прежний и блока нет', () => {
    const a = build('explore', 'loop');
    strictEqual(a.user.includes('Индекс проекта'), false);
    strictEqual(a.system.includes('УЖЕ прочитаны рантаймом'), false);
  });

  it('на explore с полем: блок в пользовательском сообщении, строка в adapter-блоке', () => {
    const p = build('explore', 'loop', view());
    ok(p.user.includes('## Индекс проекта (собран рантаймом)'));
    ok(p.user.includes('src/tariffs.ts'), 'кандидат не показан');
    ok(p.user.includes('src/money.ts:subtract'), 'переиспользование не показано');
    ok(p.user.includes('node --test'), 'команда тестов не показана');
    ok(p.user.includes('пометкой «новый»'), 'правило про будущий файл не названо');
    ok(p.system.includes('УЖЕ прочитаны рантаймом'), 'adapter-блок молчит про индекс');
  });

  it('на другом этапе поле игнорируется', () => {
    const p = build('plan', 'loop', view());
    strictEqual(p.user.includes('Индекс проекта'), false);
    strictEqual(p.system.includes('УЖЕ прочитаны рантаймом'), false);
  });

  it('потолок блока — по флоу: loop режет раньше sdk', () => {
    const big = view(2000);
    const loop = build('explore', 'loop', big).user;
    const sdk = build('explore', 'sdk', big).user;
    const blockOf = (u: string): string => u.slice(u.indexOf('## Индекс проекта'));
    ok(Buffer.byteLength(blockOf(loop), 'utf8') < Buffer.byteLength(blockOf(sdk), 'utf8'));
    ok(Buffer.byteLength(renderIndexBlock(big, INDEX_BLOCK_BYTES.loop), 'utf8') <= INDEX_BLOCK_BYTES.loop, 'блок больше потолка');
    ok(loop.includes('обрезано рантаймом'));
  });

  it('заданное окно режет блок сильнее плоской константы, если остаток мал', () => {
    // Без окна — обычный потолок флоу (INDEX_BLOCK_BYTES.loop). С маленьким окном (4096
    // токенов) блок обязан сжаться сильнее этой константы, а не переполнить запрос
    // (регресс `qwen3-8b`/`oversize`, 2026-09-12: 34042 токена запроса против окна 32768 —
    // индекс был в границах СВОЕЙ константы, но общий промпт уже не влезал).
    const blockOf = (u: string): string => u.slice(u.indexOf('## Индекс проекта'));
    const flatBlock = Buffer.byteLength(blockOf(build('explore', 'loop', view(2000)).user), 'utf8');
    const windowedBlock = Buffer.byteLength(blockOf(build('explore', 'loop', view(2000), 4096).user), 'utf8');
    ok(windowedBlock < flatBlock, 'малое окно обязано срезать блок сильнее плоской константы');

    // Щедрое окно с той же задачей блок не трогает — регресс не должен резать всех подряд.
    const generous = build('explore', 'loop', view(50), 200_000);
    ok(generous.user.includes('## Индекс проекта (собран рантаймом)'));
    ok(!generous.user.includes('Пропущен рантаймом'));
  });

  it('бриф ретрая (`extra`) занимает окно ДО расчёта бюджета индекса, а не после (code-review-all, 2026-09-14)', () => {
    // `extra` физически попадает в промпт ПОСЛЕ блока индекса (recency для карточки
    // человека), но бюджет индекса обязан увидеть его тело заранее — иначе на маленьком
    // окне общий промпт переполняется тем же классом регресса, что тест выше ловит для
    // одних лишь входных артефактов. Окно (6000 токенов) подобрано так, что БЕЗ брифа
    // индекс умещается целиком, а С брифом (6000 байт текста) бюджета уже не хватает даже
    // под минимальный блок — до фикса расчёт не видел бриф вовсе и рисовал бы блок целиком
    // в обоих случаях, переполняя запрос.
    const window = 6000;
    const withoutExtra = build('explore', 'loop', view(50), window);
    const withExtra = build('explore', 'loop', view(50), window, 'x'.repeat(6000));

    ok(withExtra.user.includes('## Что чинить в этой попытке'), 'бриф не попал в промпт');
    ok(withoutExtra.user.includes('Дерево, символы и кандидаты'), 'без брифа индекс обязан поместиться целиком');
    ok(withExtra.user.includes('Пропущен рантаймом'), 'с брифом индексу не должно хватить места');
  });

  it('окна не хватает даже под минимальный блок — явное предупреждение, а не тихий обрыв', () => {
    // Окно меньше, чем уже занято одним base-промптом (запас на ответ уже съеден) —
    // индекс обязан замениться предупреждением, а не выдать пустой/обрезанный до мусора блок.
    const p = build('explore', 'loop', view(5), 10);
    ok(p.user.includes('## Индекс проекта'));
    ok(p.user.includes('Пропущен рантаймом'), 'нет явного предупреждения о пропуске блока');
    ok(!p.user.includes('Дерево, символы и кандидаты ниже'), 'обычный текст блока не должен появляться');
  });
});
