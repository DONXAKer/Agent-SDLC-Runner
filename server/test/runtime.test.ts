/**
 * Регрессии на то, что живёт между этапами: шина событий, гейт одобрений, чтение
 * определений субагентов, запуск команды гейта, проверка входа.
 *
 * Каждый кейс закрывает подтверждённую находку ревью — ниже сказано, какую именно.
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Decision, NormalizedCall, PolicyContext, RunEvent } from '@sdlc-runner/shared';

import { ApprovalGate } from '../src/approval/gate.ts';
import { AskGate } from '../src/approval/askGate.ts';
import { EventBus } from '../src/bus.ts';
import { loadSubagents, parseAgentFile } from '../src/exec/subagents.ts';
import { runShell } from '../src/gates/shell.ts';
import { badSlug } from '../src/validation.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-runtime-'));
after(() => rmSync(root, { recursive: true, force: true }));

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  projectRoot: root,
  stage: 'chunk',
  sdlcDir: '.sdlc/demo',
  planFiles: ['src/Foo.java'],
  protectedArtifacts: [],
  readOnlyRoots: [],
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  ...over,
});

describe('шина событий', () => {
  it('догоняющий клиент видит всё, что уже произошло', () => {
    const bus = new EventBus();
    bus.emit({ type: 'assistant_text', runId: 'r1', stage: 'plan', text: 'привет' });
    strictEqual(bus.replay('r1').length, 1);
    strictEqual(bus.replay('r2').length, 0);
  });

  // Регрессия: буфер ограничивался только числом событий. Этап chunk, десять раз
  // переписавший файл на 200 КБ, держал мегабайты в истории давно законченного витка.
  it('история ограничена и по объёму, а не только по числу событий', () => {
    const bus = new EventBus();
    const big = 'x'.repeat(1_000_000);
    for (let i = 0; i < 40; i++) {
      bus.emit({
        type: 'tool_request',
        runId: 'r1',
        stage: 'chunk',
        requestId: `t${i}`,
        toolName: 'Write',
        rawInput: { file_path: 'a.txt', content: big },
        call: { kind: 'write', path: 'a.txt', content: big },
        policy: { ok: true },
        preview: { path: 'a.txt', before: null, after: big },
        writeTargets: ['a.txt'],
      });
    }
    const kept = bus.replay('r1');
    ok(kept.length < 40, `история обязана обрезаться, осталось ${kept.length}`);
    // Обрезка идёт с начала: свежие события ценнее для догоняющего клиента.
    const last = kept[kept.length - 1];
    strictEqual(last?.type === 'tool_request' ? last.requestId : null, 't39');
  });

  it('забытый прогон освобождает историю', () => {
    const bus = new EventBus();
    bus.emit({ type: 'assistant_text', runId: 'r1', stage: 'plan', text: 'x' });
    bus.forget('r1');
    strictEqual(bus.replay('r1').length, 0);
  });

  it('умерший подписчик не роняет прогон', () => {
    const bus = new EventBus();
    bus.subscribe(() => {
      throw new Error('подписчик сломался');
    });
    const seen: RunEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    bus.emit({ type: 'assistant_text', runId: 'r1', stage: 'plan', text: 'x' });
    strictEqual(seen.length, 1);
  });
});

describe('гейт одобрений', () => {
  const write = (path: string): NormalizedCall => ({ kind: 'write', path, content: 'x' });

  function makeGate(): { gate: ApprovalGate; pending: unknown[]; resolved: Decision[] } {
    const pending: unknown[] = [];
    const resolved: Decision[] = [];
    const gate = new ApprovalGate({
      onPending: (p) => pending.push(p),
      onResolved: (_i, d) => resolved.push(d),
    });
    return { gate, pending, resolved };
  }

  it('чтение не требует шага человека — сто подтверждений подряд убивают гейт', async () => {
    const { gate } = makeGate();
    const d = await gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'a1',
      toolName: 'Write',
      rawInput: { file_path: 'README.md' },
      call: { kind: 'read', path: 'README.md', range: null },
      ctx: ctx(),
    });
    strictEqual(d.allowed, true);
  });

  // Регрессия: предпросмотр строился до проверки политики, и отклонённый
  // `Write ../../.ssh/id_rsa` успевал прочитать файл целиком и разослать его подписчикам.
  it('отклонённый политикой вызов не приводит к чтению файла', async () => {
    const secret = join(root, 'secret.key');
    writeFileSync(secret, 'ПРИВАТНЫЙ КЛЮЧ');

    const { gate, pending, resolved } = makeGate();
    const d = await gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'a2',
      toolName: 'Write',
      rawInput: {},
      call: write('secret.key'),
      ctx: ctx(),
    });

    strictEqual(d.allowed, false);
    strictEqual(resolved.length, 1);
    const p = pending[0] as { preview: unknown };
    strictEqual(p.preview, null, 'содержимое отклонённого файла не должно уйти в шину');
  });

  // Регрессия: ключом очереди был только requestId, который выдаёт исполнитель и который
  // уникален лишь внутри своей сессии — одобрение из одного витка закрывало вызов другого.
  it('ответ по чужому прогону запрос не закрывает', async () => {
    const { gate } = makeGate();
    const p = gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'shared-id',
      toolName: 'Write',
      rawInput: {},
      call: write('src/Foo.java'),
      ctx: ctx(),
    });

    strictEqual(gate.resolve('r2', 'shared-id', { allowed: true, updatedInput: null, by: 'operator' }), false);
    strictEqual(gate.resolve('r1', 'shared-id', { allowed: true, updatedInput: null, by: 'operator' }), true);
    strictEqual((await p).allowed, true);
  });

  it('автоодобрение действует на этап и снимается вместе с ним', async () => {
    const { gate } = makeGate();
    // Тумблер «одобрять всё» заменён правилами: «всё» — это `rest`.
    gate.setAutoApprove('r1', 'chunk', { planWrites: true, bash: true, rest: true });
    const d = await gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'a3',
      toolName: 'Write',
      rawInput: {},
      call: write('src/Foo.java'),
      ctx: ctx(),
    });
    strictEqual(d.allowed && d.by, 'auto');

    gate.clearAutoApprove('r1', 'chunk');
    const after = gate.autoApproveRules('r1', 'chunk');
    strictEqual(after.planWrites || after.bash || after.rest, false);
  });

  it('автоодобрение не снимает отказ политики', async () => {
    const { gate } = makeGate();
    gate.setAutoApprove('r1', 'chunk', { planWrites: true, bash: true, rest: true });
    const d = await gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'a4',
      toolName: 'Write',
      rawInput: {},
      call: write('.env'),
      ctx: ctx(),
    });
    strictEqual(d.allowed, false);
  });

  it('отмена прогона снимает всё, что ждало ответа', async () => {
    const { gate } = makeGate();
    const p = gate.request({
      runId: 'r1',
      stage: 'chunk',
      requestId: 'a5',
      toolName: 'Write',
      rawInput: {},
      call: write('src/Foo.java'),
      ctx: ctx(),
    });
    gate.cancelRun('r1', 'отменён оператором');
    const d = await p;
    strictEqual(d.allowed, false);
    strictEqual(gate.list().length, 0);
  });
});

describe('гейт вопросов', () => {
  it('обрыв витка отвечает пустым — «пропущено», а не «согласен»', async () => {
    const asks = new AskGate({ onPending: () => {}, onAnswered: () => {} });
    const p = asks.ask({
      runId: 'r1',
      stage: 'ask',
      questions: [{ id: 'q1', question: 'что?', header: 'Х', multiSelect: false, options: [] }],
    });
    asks.cancelRun('r1');
    deepStrictEqual(await p, {});
  });
});

describe('определения субагентов', () => {
  it('читаются из frontmatter', () => {
    const a = parseAgentFile(
      ['---', 'name: sdlc-reviewer', 'description: рецензент', 'tools: Read, Grep', '---', 'тело'].join('\n'),
    );
    strictEqual(a.name, 'sdlc-reviewer');
    deepStrictEqual(a.tools, ['Read', 'Grep']);
    ok(a.prompt.includes('тело'));
  });

  // Регрессия: субагенты вообще не доезжали до SDK, и этап 6 шёл без независимого
  // рецензента — гейт «Ревью независимым агентом» держался на промпте.
  it('отсутствующее определение названо, а не проглочено', () => {
    const { agents, missing } = loadSubagents(join(root, 'нет-такого-каталога'), ['sdlc-reviewer']);
    deepStrictEqual(missing, ['sdlc-reviewer']);
    strictEqual(Object.keys(agents).length, 0);
  });
});

describe('запуск команды гейта', () => {
  it('несуществующая команда завершается, а не висит вечно', async () => {
    const r = await runShell('такой-команды-нет-совсем', { cwd: root, timeoutMs: 10_000 });
    ok(r.exitCode !== 0, 'код возврата не должен быть нулевым');
    ok(r.durationMs < 10_000);
  });

  // Пол безопасности не отключается оттого, что команда пришла из файла проекта:
  // читается он каждый виток, а правится редко.
  it('разрушительная команда из набора не выполняется', async () => {
    const r = await runShell('rm -rf /', { cwd: root, timeoutMs: 1000 });
    ok(r.denied !== null);
    strictEqual(r.exitCode, null);
  });

  // Проверка на латинице намеренно: вывод декодируется как UTF-8, а консоль Windows
  // печатает в кодировке OEM, и кириллица в строке гейта приедет искажённой. Это
  // косметика (вывод сборщиков и тест-раннеров на латинице), но выдавать её за
  // проверенное поведение нельзя.
  it('вывод команды доходит целиком', async () => {
    const r = await runShell('echo gate-output-here', { cwd: root, timeoutMs: 30_000 });
    strictEqual(r.exitCode, 0);
    ok(r.lastLine.includes('gate-output-here'), r.lastLine);
  });
});

describe('проверка slug', () => {
  // Регрессия: slug становится именем каталога, и `../../..` заставлял рантайм читать
  // файлы вне проекта и вклеивать их в промпт. Политика тут не помогает — читает рантайм.
  it('обход каталога отклоняется', () => {
    for (const s of ['../../etc', '..', '.', 'a/b', 'a\\b', 'a..b', '', ' ']) {
      ok(badSlug(s) !== null, `slug «${s}» обязан быть отклонён`);
    }
  });

  it('нормальный slug проходит', () => {
    for (const s of ['demo', 'feat-123', 'a.b_c-1']) strictEqual(badSlug(s), null);
  });

  it('слишком длинный отклоняется', () => {
    ok(badSlug('a'.repeat(65)) !== null);
  });

  // Slug — тоже имя файла (для проекта, добавленного через /api/projects: <slug>.local.json),
  // а зарезервированные в Windows имена устройств валят запись на диске малопонятной
  // ОС-ошибкой вместо аккуратного отказа валидации.
  it('зарезервированные в Windows имена устройств отклоняются', () => {
    for (const s of ['con', 'CON', 'Con', 'aux', 'nul', 'prn', 'com1', 'COM9', 'lpt1', 'nul.txt', 'con.local']) {
      ok(badSlug(s) !== null, `slug «${s}» обязан быть отклонён`);
    }
  });

  it('похожие, но легитимные имена не отклоняются', () => {
    for (const s of ['console', 'connect', 'auxiliary', 'nullable', 'constant', 'comment']) {
      strictEqual(badSlug(s), null, `slug «${s}» не должен отклоняться`);
    }
  });
});
