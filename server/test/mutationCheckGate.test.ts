/**
 * Гейт «Тест ловит правку» (`docs/stage-review-2026-09-18.md`, §5.1) — против настоящего
 * git-репозитория и настоящего исполнения тестовой команды, не заглушенных вызовов. Это
 * единственный встроенный гейт, который временно пишет в рабочее дерево проекта, поэтому
 * проверяется не только исход (✅/❌/⏭), но и то, что дерево возвращается в точности в то
 * состояние, в котором было до вызова, — на успехе, на находке и на падении подготовки.
 *
 * Фикстурная тестовая команда — ПРОСТОЙ node-скрипт с `assert` (`node test/check.test.js`),
 * а не `node:test`/`node --test`: этот файл сам выполняется под `node --test`, и вложенный
 * `node --test` детектирует рекурсивный вызов и молча пропускает запуск («run() is being
 * called recursively within a test file. skipping running files.») — гейт честно получает
 * exitCode 0 без единого прогнанного теста и репортит ложный ✅. В продакшене этой ловушки
 * нет: `mutationCheckGate` вызывается из серверного процесса раннера, не из `node --test`.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

const gate = BUILTIN.get('тест ловит правку');

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/**
 * Модуль объявлен ЯВНО (`ecosystem: 'go'`, но с настоящей командой запуска фикстуры):
 * `depsDir` у go — `null`, и гейт не спотыкается об отсутствие `node_modules` в фикстуре
 * (тот же приём, что `gateHonesty.test.ts` использует для гейта «Тесты»). Команда всегда
 * запускает один и тот же путь — каждый сценарий кладёт туда свой скрипт.
 */
const MODULES: ModuleProfile[] = [{ dir: '.', ecosystem: 'go', test: 'node test/check.test.js' }];

function ctx(root: string, over: Partial<GateContext> = {}): GateContext {
  return {
    projectRoot: root,
    planFiles: ['src/calc.js'],
    baseline: null,
    timeoutMs: 30_000,
    modules: MODULES,
    // По умолчанию слаг задан — штатный вызывающий (verify/chunk) всегда его передаёт;
    // тест на отсутствие слага переопределяет явно (`{ slug: undefined }`).
    slug: 'demo',
    ...over,
  };
}

/** Живой git-репозиторий с одним продуктовым файлом в HEAD. */
function repo(headCalc: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-mutation-')));
  roots.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@test'], root);
  git(['config', 'user.name', 'test'], root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'calc.js'), headCalc);
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'init'], root);
  return root;
}

const TEST_NOT_DISTINGUISHING = [
  "const assert = require('node:assert/strict');",
  "const { add } = require('../src/calc.js');",
  'assert.strictEqual(typeof add, \'function\');',
  '',
].join('\n');

const TEST_DISTINGUISHING = [
  "const assert = require('node:assert/strict');",
  "const { add } = require('../src/calc.js');",
  'assert.strictEqual(add(2, 3), 5);',
  '',
].join('\n');

describe('гейт «Тест ловит правку»', () => {
  it('зарегистрирован', () => ok(gate !== undefined));

  it('тест не отличает «до» от «после» — находка ❌, дерево восстановлено', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    const attemptCalc = 'exports.add = (a, b) => a + b;\n';
    writeFileSync(join(root, 'src', 'calc.js'), attemptCalc);
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'check.test.js'), TEST_NOT_DISTINGUISHING);

    const r = await gate!(ctx(root));
    strictEqual(r.status, '❌', r.lastLine);
    match(r.lastLine, /не отличает/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), attemptCalc, 'продуктовый файл обязан вернуться в состояние попытки');
    ok(!existsSync(join(root, '.sdlc', 'demo', '.mutation-check-backup.json')), 'резерв обязан быть убран после восстановления');
  });

  it('тест ловит правку (падает без неё) — гейт ✅, дерево восстановлено', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n'); // баг в HEAD
    const attemptCalc = 'exports.add = (a, b) => a + b;\n'; // попытка чинит баг
    writeFileSync(join(root, 'src', 'calc.js'), attemptCalc);
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'check.test.js'), TEST_DISTINGUISHING);

    const r = await gate!(ctx(root));
    strictEqual(r.status, '✅', r.lastLine);
    match(r.lastLine, /ловит правку/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), attemptCalc);
  });

  it('новых/изменённых тестовых файлов нет — ⏭, дерево не тронуто', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    const attemptCalc = 'exports.add = (a, b) => a + b;\n';
    writeFileSync(join(root, 'src', 'calc.js'), attemptCalc);

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /тестовых файлов нет/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), attemptCalc);
  });

  it('продуктовых правок нет (только новый тест) — ⏭', async () => {
    const root = repo('exports.add = (a, b) => a + b;\n');
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'check.test.js'), TEST_DISTINGUISHING);

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /продуктовых правок нет/);
  });

  it('новый (нетракованный) продуктовый файл — скрывается и восстанавливается', async () => {
    const root = repo('exports.add = (a, b) => a + b;\n');
    const newContent = 'exports.val = 42;\n';
    writeFileSync(join(root, 'src', 'newmod.js'), newContent);
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(
      join(root, 'test', 'check.test.js'),
      [
        "const assert = require('node:assert/strict');",
        "const { val } = require('../src/newmod.js');",
        'assert.strictEqual(val, 42);',
        '',
      ].join('\n'),
    );

    await gate!(ctx(root, { planFiles: ['src/newmod.js'] }));
    ok(existsSync(join(root, 'src', 'newmod.js')), 'новый продуктовый файл обязан вернуться на место');
    strictEqual(readFileSync(join(root, 'src', 'newmod.js'), 'utf8'), newContent);
  });

  it('.sdlc/ не считается продуктовым и не трогается, даже если он грязный', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    const attemptCalc = 'exports.add = (a, b) => a + b;\n';
    writeFileSync(join(root, 'src', 'calc.js'), attemptCalc);
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'check.test.js'), TEST_NOT_DISTINGUISHING);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(join(root, '.sdlc', 'demo', 'plan.md'), '# план\n');

    const r = await gate!(ctx(root));
    strictEqual(r.status, '❌', r.lastLine);
    strictEqual(readFileSync(join(root, '.sdlc', 'demo', 'plan.md'), 'utf8'), '# план\n');
  });

  it('файл, дирный ДО chunk\'а и не тронутый попыткой (baseline), не откатывается', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    // Грязный ДО начала chunk'а — как есть, попытка его не трогала.
    const preExisting = 'exports.untouched = true; // чужая правка до chunk\'а\n';
    writeFileSync(join(root, 'src', 'other.js'), preExisting);
    const hash = createHash('md5').update(readFileSync(join(root, 'src', 'other.js'))).digest('hex');

    const attemptCalc = 'exports.add = (a, b) => a + b;\n';
    writeFileSync(join(root, 'src', 'calc.js'), attemptCalc);
    mkdirSync(join(root, 'test'), { recursive: true });
    writeFileSync(join(root, 'test', 'check.test.js'), TEST_NOT_DISTINGUISHING);

    const baseline = new Map([['src/other.js', hash]]);
    const r = await gate!(ctx(root, { baseline, planFiles: ['src/calc.js', 'src/other.js'] }));
    strictEqual(r.status, '❌', r.lastLine);
    strictEqual(readFileSync(join(root, 'src', 'other.js'), 'utf8'), preExisting, 'чужая грязь baseline не должна откатываться');
  });

  it('прерванная прошлая проверка, дерево ещё в HEAD-состоянии — восстанавливает резерв', async () => {
    const HEAD = 'exports.add = (a, b) => a - b;\n';
    const CURRENT = 'exports.add = (a, b) => a + b; // ПОДЛИННОЕ\n';
    const root = repo(HEAD);
    // Симулируем «крах между applyBaseline и restoreEntries»: дерево ещё в том виде, в
    // который его поставил applyBaseline (HEAD), резерв на диске хранит настоящую правку.
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', '.mutation-check-backup.json'),
      JSON.stringify({
        entries: [{ path: 'src/calc.js', current: CURRENT, existedAtHead: true, baselineContent: HEAD }],
      }),
    );

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    strictEqual(r.envBlocked, true);
    match(r.lastLine, /восстановлены файлы \(1\)/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), CURRENT);
    ok(!existsSync(join(root, '.sdlc', 'demo', '.mutation-check-backup.json')), 'резерв обязан быть убран после восстановления');
  });

  it('прерванная прошлая проверка, дерево уже восстановлено — повторная запись идемпотентна', async () => {
    const HEAD = 'exports.add = (a, b) => a - b;\n';
    const CURRENT = 'exports.add = (a, b) => a + b; // ПОДЛИННОЕ\n';
    const root = repo(HEAD);
    // Симулируем «крах между restoreEntries и clearMutationBackup»: дерево уже несёт
    // настоящую правку, резерв просто не был расчищен.
    writeFileSync(join(root, 'src', 'calc.js'), CURRENT);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', '.mutation-check-backup.json'),
      JSON.stringify({ entries: [{ path: 'src/calc.js', current: CURRENT, existedAtHead: true, baselineContent: HEAD }] }),
    );

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /восстановлены файлы \(1\)/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), CURRENT);
    ok(!existsSync(join(root, '.sdlc', 'demo', '.mutation-check-backup.json')));
  });

  it('прерванная прошлая проверка, но файл с тех пор менялся ещё раз — НЕ восстанавливается', async () => {
    // Регрессия ревью (2026-09-19): раньше устаревший резерв восстанавливался безусловно —
    // легитимная правка, легшая поверх дерева между крахом и повтором гейта, тихо терялась.
    const HEAD = 'exports.add = (a, b) => a - b;\n';
    const CURRENT = 'exports.add = (a, b) => a + b; // ПОДЛИННОЕ\n';
    const THIRD_PARTY = 'exports.add = (a, b) => a - b; // ПРАВКА ПОСЛЕ КРАХА\n';
    const root = repo(HEAD);
    writeFileSync(join(root, 'src', 'calc.js'), THIRD_PARTY);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', '.mutation-check-backup.json'),
      JSON.stringify({ entries: [{ path: 'src/calc.js', current: CURRENT, existedAtHead: true, baselineContent: HEAD }] }),
    );

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /восстановлены файлы \(0\)/);
    match(r.lastLine, /НЕ восстановлены/);
    match(r.lastLine, /src\/calc\.js/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), THIRD_PARTY, 'легитимная правка после краха обязана уцелеть');
    ok(!existsSync(join(root, '.sdlc', 'demo', '.mutation-check-backup.json')));
  });

  it('резерв старого формата (без baselineContent) — не восстанавливается вслепую', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    const leftover = 'exports.add = (a, b) => a - b; // MUTATED-LEFTOVER\n';
    writeFileSync(join(root, 'src', 'calc.js'), leftover);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', '.mutation-check-backup.json'),
      JSON.stringify({
        entries: [{ path: 'src/calc.js', current: 'exports.add = (a, b) => a + b; // ПОДЛИННОЕ\n', existedAtHead: true }],
      }),
    );

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /восстановлены файлы \(0\)/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), leftover);
  });

  it('резерв со слагом — путь под `.sdlc/<slug>/`, не общий на весь projectRoot', async () => {
    const HEAD = 'exports.add = (a, b) => a - b;\n';
    const CURRENT = 'exports.add = (a, b) => a + b; // ПОДЛИННОЕ\n';
    const root = repo(HEAD);
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'demo', '.mutation-check-backup.json'),
      JSON.stringify({ entries: [{ path: 'src/calc.js', current: CURRENT, existedAtHead: true, baselineContent: HEAD }] }),
    );

    const r = await gate!(ctx(root, { slug: 'demo' }));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /восстановлены файлы \(1\)/);
    strictEqual(readFileSync(join(root, 'src', 'calc.js'), 'utf8'), CURRENT);
    ok(!existsSync(join(root, '.sdlc', 'demo', '.mutation-check-backup.json')));
  });

  it('регрессия ревью (2026-09-19): два слага на одном projectRoot не делят один файл резерва', async () => {
    const HEAD = 'exports.add = (a, b) => a - b;\n';
    const CURRENT_A = 'exports.add = (a, b) => a + b; // ВИТОК A\n';
    const root = repo(HEAD);
    mkdirSync(join(root, '.sdlc', 'witok-a'), { recursive: true });
    writeFileSync(
      join(root, '.sdlc', 'witok-a', '.mutation-check-backup.json'),
      JSON.stringify({ entries: [{ path: 'src/calc.js', current: CURRENT_A, existedAtHead: true, baselineContent: HEAD }] }),
    );

    // Другой виток (другой слаг) на том же projectRoot не должен увидеть чужой резерв и
    // не должен потерять свою собственную грязную правку продуктового файла как «стейл».
    writeFileSync(join(root, 'src', 'calc.js'), 'exports.add = (a, b) => a + b; // ВИТОК B, ещё в работе\n');
    const rB = await gate!(ctx(root, { slug: 'witok-b' }));
    strictEqual(rB.lastLine.includes('восстановлены файлы'), false, 'виток B не должен увидеть резерв витка A');
    strictEqual(
      readFileSync(join(root, 'src', 'calc.js'), 'utf8'),
      'exports.add = (a, b) => a + b; // ВИТОК B, ещё в работе\n',
      'резерв чужого слага не должен трогать дерево этого витка',
    );
    ok(existsSync(join(root, '.sdlc', 'witok-a', '.mutation-check-backup.json')), 'резерв витка A остаётся нетронутым');
  });

  it('вне git-репозитория — ⏭, а не попытка мутировать', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-mutation-nogit-')));
    roots.push(root);
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'calc.js'), 'exports.add = (a, b) => a + b;\n');

    const r = await gate!(ctx(root));
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /не git-репозиторий/);
  });

  it('слаг не передан гейту — явный отказ, а не тихий фолбэк на общий путь резерва (регрессия ревью, 2026-09-19)', async () => {
    const root = repo('exports.add = (a, b) => a - b;\n');
    // GateContext.slug опционален на уровне типа (нужен вызывающим вроде ecosystemFor, где
    // слага в принципе нет), но mutationCheckGate штатно ждёт его всегда — конструируем
    // контекст без поля `slug`, а не `{ slug: undefined }` (exactOptionalPropertyTypes
    // различает «отсутствует» и «есть, но undefined»).
    const withoutSlug: GateContext = {
      projectRoot: root,
      planFiles: ['src/calc.js'],
      baseline: null,
      timeoutMs: 30_000,
      modules: MODULES,
    };

    const r = await gate!(withoutSlug);
    strictEqual(r.status, '⏭', r.lastLine);
    match(r.lastLine, /слаг витка не передан/);
  });
});
