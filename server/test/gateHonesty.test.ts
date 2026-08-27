/**
 * Честность встроенных гейтов: чем именно `✅` отличается от «мы ничего не проверили».
 *
 * Все кейсы здесь — про ложный зелёный и ложный красный, то есть про две ошибки, которые
 * гейт не имеет права делать: отчитаться о непроведённой проверке и обвинить код в том,
 * чего никто не читал. Фикстуры настоящие (git-репозиторий, файлы на диске), потому что
 * ровно на стыке с диском эти дефекты и жили.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { match, ok, strictEqual } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BUILTIN } from '../src/gates/builtin/index.ts';
import type { GateContext } from '../src/gates/builtin/index.ts';
import type { ModuleProfile } from '../src/config/schema.ts';

function ctx(root: string, over: Partial<GateContext> = {}): GateContext {
  return {
    projectRoot: root,
    planFiles: ['api/main.go'],
    baseline: null,
    timeoutMs: 5_000,
    ...over,
  };
}

/** Настоящий git-репозиторий с одним модулем: гейты берут список изменений из git. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-honesty-')));
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'api', 'go.mod'), 'module x\n');
  writeFileSync(join(root, 'api', 'main.go'), 'package main\n\nfunc Работа() {}\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

describe('гейт дублей не выдаёт непроверенное за проверенное', () => {
  const dup = BUILTIN.get('дубли хелперов');

  it('зарегистрирован', () => ok(dup !== undefined));

  it('вне git-репозитория — ⏭, а не зелёное «дублировать нечего»', async () => {
    // Diff берётся из git. Без репозитория он пуст, и прежний гейт печатал `✅` —
    // отчитывался о проверке, которой не было.
    const bare = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-nogit-')));
    const r = await dup!(ctx(bare));
    strictEqual(r.status, '⏭');
    match(r.lastLine, /не git-репозиторий/);
  });

  it('на отменённом прогоне — ⏭, а не зелёный', async () => {
    const root = repo();
    const aborted = AbortSignal.abort();
    const r = await dup!(ctx(root, { signal: aborted }));
    strictEqual(r.status, '⏭');
    match(r.lastLine, /отмен/);
  });
});

describe('гейт сборки: языки без компиляции', () => {
  const build = BUILTIN.get('сборка');

  it('зарегистрирован', () => ok(build !== undefined));

  it('Ruby не отчитывается зелёным по команде-заглушке', async () => {
    // Прежняя `ruby -e "true"` ничего не собирала, а вдобавок отклонялась полом
    // безопасности как однострочник интерпретатора — обязательный гейт был выключен
    // навсегда. Теперь шага сборки честно нет, и гейт уходит на проверку синтаксиса.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-ruby-')));
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app', 'Gemfile'), "source 'https://rubygems.org'\n");
    writeFileSync(join(root, 'app', 'thing.rb'), 'def x\nend\n');
    execFileSync('git', ['init', '-q'], { cwd: root });

    const r = await build!(ctx(root, { planFiles: ['app/thing.rb'] }));
    // Зелёного «собрали» тут быть не может ни при каком исходе: сборки нет.
    strictEqual(r.status === '✅' && /собрал/i.test(r.lastLine), false, r.lastLine);
    match(r.lastLine, /синтаксис|шага сборки|НЕ ПРОВЕР/i);
  });

  it('PHP не выдаёт проверку composer.json за проверку кода', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-php-')));
    mkdirSync(join(root, 'api'), { recursive: true });
    writeFileSync(join(root, 'api', 'composer.json'), '{"name":"x/y"}\n');
    writeFileSync(join(root, 'api', 'a.php'), '<?php function f() {}\n');
    execFileSync('git', ['init', '-q'], { cwd: root });

    const r = await build!(ctx(root, { planFiles: ['api/a.php'] }));
    strictEqual(r.command, null, `composer validate всё ещё выдаётся за сборку: ${r.command}`);
  });
});

describe('линт экосистемы', () => {
  const lint = BUILTIN.get('линт экосистемы');

  it('команда из конфига исполняется шеллом, а не ищется как файл', async () => {
    // `spawn('npm run lint', [])` давал ENOENT → «⏭ линтер не найден на машине», то есть
    // отправлял оператора чинить установку инструмента, который не запускали. Берём
    // заведомо доступный шеллу вход: команда обязана ВЫПОЛНИТЬСЯ.
    const root = repo();
    writeFileSync(join(root, 'api', 'other.go'), 'package main\n');
    const modules: ModuleProfile[] = [{ dir: 'api', ecosystem: 'go', lint: 'exit 3' }];

    const r = await lint!(ctx(root, { modules, planFiles: ['api/main.go'] }));
    strictEqual(r.status, '❌', r.lastLine);
    strictEqual(r.exitCode, 3, `команда не исполнилась шеллом: код ${r.exitCode}`);
  });

  it('нулевой код команды из конфига даёт зелёный', async () => {
    const root = repo();
    const modules: ModuleProfile[] = [{ dir: 'api', ecosystem: 'go', lint: 'exit 0' }];
    const r = await lint!(ctx(root, { modules, planFiles: ['api/main.go'] }));
    strictEqual(r.status, '✅', r.lastLine);
  });
});
