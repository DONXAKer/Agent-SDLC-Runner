/**
 * Индекс проекта для разведки (`server/src/explore/*`).
 *
 * Дерево — реальная фикстура стенда `bench/fixture` (пять файлов `src/`, два теста, README,
 * без зависимостей): ключевые слова из `task-freeship.md`, и ранжирование обязано поднять
 * наверх именно те файлы, о которых говорит задача. Потолки и защита от симлинка наружу —
 * на синтетическом tmpdir.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { axisMechanismCandidates } from '../src/explore/axes.ts';
import { fileCard, packCards, symbolCard } from '../src/explore/cards.ts';
import { intentKeywords } from '../src/explore/keywords.ts';
import { rankFiles, reuseCandidates } from '../src/explore/rank.ts';
import { renderIndexBlock } from '../src/explore/render.ts';
import { callersOf, declaredSymbols, enclosingSymbol } from '../src/explore/symbols.ts';
import { readTree } from '../src/explore/tree.ts';
import { buildView } from '../src/explore/view.ts';
import { symlinkSkip } from './platform.ts';

const FIXTURE = join(import.meta.dirname, '..', '..', 'bench', 'fixture');
const index = readTree(FIXTURE);
const task = readFileSync(join(FIXTURE, 'task-freeship.md'), 'utf8');
const kw = intentKeywords(task);

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('обход дерева', () => {
  it('код, тесты и README различаются по виду; .sdlc и скрытые каталоги не читаются', () => {
    const byPath = new Map(index.files.map((f) => [f.path, f]));
    strictEqual(byPath.get('src/tariffs.ts')?.kind, 'code');
    strictEqual(byPath.get('test/tariffs.test.ts')?.kind, 'test');
    strictEqual(byPath.get('README.md')?.kind, 'doc');
    ok(!index.files.some((f) => f.path.startsWith('.sdlc/')), '.sdlc попал в индекс');
    ok(index.files.every((f) => f.path === f.path.replace(/\\/g, '/')), 'пути не posix');
  });

  it('символы tariffs.ts: экспортируемые и модульная константа', () => {
    const t = index.files.find((f) => f.path === 'src/tariffs.ts')!;
    const names = new Map(t.symbols.map((s) => [s.name, s.exported]));
    strictEqual(names.get('weightStep'), true);
    strictEqual(names.get('priceFor'), true);
    strictEqual(names.get('TARIFF_TABLE'), true);
    strictEqual(names.get('WEIGHT_LIMITS_G'), false);
    ok(t.symbols.every((s) => s.signature.length <= 160));
  });

  it('несуществующий корень даёт пустой индекс, а не исключение', () => {
    const empty = readTree(join(tmpdir(), 'sdlc-no-such-root-' + Date.now()));
    deepStrictEqual(empty.files, []);
  });
});

describe('ключевые слова задачи', () => {
  it('пути и символы из бэктиков и текста', () => {
    ok(kw.paths.includes('src/tariffs.ts'), `нет src/tariffs.ts: ${kw.paths.join(', ')}`);
    ok(kw.paths.includes('discounts.ts'));
    for (const s of ['priceFor', 'weightStep', 'discountFor', 'CAP_PCT']) ok(kw.symbols.includes(s), `нет ${s}`);
    ok(kw.words.includes('бесплатная') || kw.words.includes('бесплатно'));
    ok(!kw.words.includes('claim'), 'стоп-слово бланка попало в слова');
  });

  it('intent по шаблону: читаются только названные секции, плейсхолдеры не читаются', () => {
    const intent = ['# Задача: демо', '', '## Коротко', '', 'правим `src/a.ts` через `helperOne`', '', '## Инварианты', '', '- не трогаем `src/secret.ts` ‹почему›', ''].join('\n');
    const k = intentKeywords(intent);
    ok(k.paths.includes('src/a.ts'));
    ok(k.symbols.includes('helperOne'));
    ok(!k.paths.includes('src/secret.ts'), 'секция вне списка прочитана');
  });

  it('«Приёмочный лист» не источник слов — утечка в слепой блок индекса', () => {
    const intent = ['# Задача: демо', '', '## Коротко', '', 'правим src/a.ts', '', '## Приёмочный лист', '', '1. secretMarkerWord | как проверить', ''].join('\n');
    const k = intentKeywords(intent);
    ok(!k.words.includes('secretmarkerword'), 'слово из приёмочного листа попало в ключевые');
  });

  it('хвостовая точка предложения не входит в путь', () => {
    const intent = ['# Задача: демо', '', '## Коротко', '', 'правим src/tariffs.ts.', ''].join('\n');
    const k = intentKeywords(intent);
    ok(k.paths.includes('src/tariffs.ts'), `нет src/tariffs.ts: ${k.paths.join(', ')}`);
    ok(!k.paths.includes('src/tariffs.ts.'), 'путь с хвостовой точкой');
  });
});

describe('ранжирование', () => {
  it('верх списка — файлы, о которых говорит задача', () => {
    const top = rankFiles(index, kw, 8).map((r) => r.file.path);
    deepStrictEqual(top.slice(0, 3), ['src/tariffs.ts', 'src/discounts.ts', 'test/tariffs.test.ts']);
    ok(!top.includes('README.md'), 'документ в карту не идёт');
    const why = rankFiles(index, kw, 1)[0]!.why.join(' ');
    ok(why.includes('путь назван в задаче'));
  });

  it('кандидаты на переиспользование: названные в задаче символы первыми, с вызывающими', () => {
    const ranked = rankFiles(index, kw);
    const reuse = reuseCandidates(index, ranked, kw);
    const keys = reuse.map((r) => `${r.path}:${r.symbol}`);
    ok(keys.slice(0, 3).includes('src/tariffs.ts:priceFor'));
    ok(keys.includes('src/discounts.ts:discountFor'));
    ok(keys.includes('src/tariffs.ts:weightStep'));
    const subtract = reuse.find((r) => r.symbol === 'subtract');
    ok(subtract !== undefined && subtract.callers >= 2, 'вызывающие не посчитаны');
  });

  it('вызывающие: место вызова, а не строка импорта', () => {
    deepStrictEqual(callersOf(index, 'discountFor', 'src/discounts.ts'), [
      { path: 'src/tariffs.ts', symbol: 'priceFor', line: 153 },
    ]);
    const t = index.files.find((f) => f.path === 'src/tariffs.ts')!;
    strictEqual(enclosingSymbol(t, 1), null);
  });
});

describe('кандидаты по осям', () => {
  it('ключи — все шесть осей канона; пустая ось законна', () => {
    const axes = axisMechanismCandidates(index);
    deepStrictEqual(Object.keys(axes), ['Безопасность', 'Ресурсы и скорость', 'Отказы зависимостей', 'Настройки', 'Совместимость и данные', 'Наблюдаемость']);
    deepStrictEqual(axes['Настройки'], []);
    ok(axes['Совместимость и данные'].some((h) => h.path === 'src/discounts.ts' && h.symbol === 'Tier'));
    ok(Object.values(axes).every((hits) => hits.length <= 3));
  });
});

describe('блок индекса и карточки', () => {
  const eco = [{ dir: '.', label: 'Node.js', build: null, test: 'node --test' }];

  it('режется по байтам, кандидаты держатся раньше дерева', () => {
    const { view } = buildView(index, eco, kw, true);
    const block = renderIndexBlock(view, 900);
    ok(Buffer.byteLength(block, 'utf8') <= 900, `блок ${Buffer.byteLength(block, 'utf8')} байт`);
    ok(block.includes('обрезано рантаймом'));
    ok(block.includes('src/tariffs.ts'), 'кандидат потерян раньше дерева');
    const full = renderIndexBlock(view, 20_000);
    ok(full.includes('### Дерево исходников'));
    ok(full.includes('### README'));
    ok(full.includes('node --test'));
    ok(full.includes('Опор осей'));
  });

  it('без гейта «Разбор последствий» осей в блоке нет', () => {
    const { view } = buildView(index, eco, kw, false);
    strictEqual(view.axes, null);
    ok(!renderIndexBlock(view, 20_000).includes('Кандидаты механизмов по осям'));
  });

  it('карточка файла держит потолок и помечает обрезку; упаковка называет пропущенные', () => {
    const t = index.files.find((f) => f.path === 'src/tariffs.ts')!;
    const card = fileCard(t, 800);
    ok(Buffer.byteLength(card, 'utf8') <= 800);
    ok(card.includes('обрезано рантаймом'));
    ok(card.startsWith('### `src/tariffs.ts`'));
    const sc = symbolCard(t, t.symbols.find((s) => s.name === 'priceFor')!);
    ok(sc.includes('export function priceFor'));
    const packed = packCards([fileCard(t, 4000), fileCard(t, 4000), fileCard(t, 4000)], 4500);
    ok(packed.includes('не показаны'));
  });
});

describe('потолки и симлинки', () => {
  it('файлы сверх потолка считаются пропущенными, а не молча исчезают', () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-explore-limits-'));
    roots.push(root);
    mkdirSync(join(root, 'src'));
    for (const n of ['a', 'b', 'c', 'd']) writeFileSync(join(root, 'src', `${n}.ts`), `export const ${n} = 1;\n`);
    writeFileSync(join(root, 'src', 'big.ts'), 'x'.repeat(5000));
    const idx = readTree(root, { maxFiles: 3, maxFileBytes: 1000, maxTotalBytes: 100_000 });
    strictEqual(idx.files.length, 3);
    ok(idx.skipped.files >= 2, `пропущено ${idx.skipped.files}`);
  });

  it('симлинк наружу корня не читается', { skip: symlinkSkip ?? false }, () => {
    const outside = mkdtempSync(join(tmpdir(), 'sdlc-explore-outside-'));
    const root = mkdtempSync(join(tmpdir(), 'sdlc-explore-root-'));
    roots.push(outside, root);
    writeFileSync(join(outside, 'secret.ts'), 'export const SECRET = 1;\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = 1;\n');
    symlinkSync(join(outside, 'secret.ts'), join(root, 'src', 'leak.ts'));
    const idx = readTree(root);
    deepStrictEqual(idx.files.map((f) => f.path), ['src/ok.ts']);
  });

  it('каталог-симлинк на предка не даёт бесконечной рекурсии', { skip: symlinkSkip ?? false }, () => {
    const root = mkdtempSync(join(tmpdir(), 'sdlc-explore-cycle-'));
    roots.push(root);
    mkdirSync(join(root, 'a'));
    writeFileSync(join(root, 'a', 'ok.ts'), 'export const ok = 1;\n');
    symlinkSync(root, join(root, 'a', 'link'));
    const idx = readTree(root);
    deepStrictEqual(idx.files.map((f) => f.path), ['a/ok.ts']);
  });
});
