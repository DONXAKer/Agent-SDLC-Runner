/**
 * Персистентная лента событий витка (`eventLog.ts`) — часть «истории витков»: без записи
 * на диск `readPersistedEvents` не могла бы показать полный флоу закрытого/убранного
 * витка, только финальный статус (`history.ts`).
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { RunEvent } from '@sdlc-runner/shared';

import { appendEvent, readPersistedEvents } from '../src/eventLog.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-eventlog-')));
  roots.push(root);
  return root;
}

const started = (runId: string): RunEvent => ({
  type: 'run_started',
  runId,
  slug: 'demo',
  profile: 'p',
  projectRoot: '/proj',
});

describe('eventLog: персистентная лента событий витка', () => {
  it('файла нет — пустой список, без исключения', () => {
    const root = tempRoot();
    deepStrictEqual(readPersistedEvents(root, 'demo'), []);
  });

  it('записанные события читаются обратно в том же порядке', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'demo'), { recursive: true });
    appendEvent(root, 'demo', started('r1'));
    appendEvent(root, 'demo', { type: 'assistant_text', runId: 'r1', stage: 'intent', text: 'привет' });

    const events = readPersistedEvents(root, 'demo');
    strictEqual(events.length, 2);
    strictEqual(events[0]?.type, 'run_started');
    strictEqual(events[1]?.type, 'assistant_text');
  });

  it('события разных витков (слагов) не смешиваются', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.sdlc', 'a'), { recursive: true });
    mkdirSync(join(root, '.sdlc', 'b'), { recursive: true });
    appendEvent(root, 'a', started('ra'));
    appendEvent(root, 'b', started('rb'));

    strictEqual(readPersistedEvents(root, 'a').length, 1);
    strictEqual(readPersistedEvents(root, 'b').length, 1);
  });

  it('одна битая строка не роняет чтение остальных', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.events.ndjson'),
      `${JSON.stringify(started('r1'))}\nне json вовсе\n${JSON.stringify(started('r2'))}\n`,
    );

    const events = readPersistedEvents(root, 'demo');
    strictEqual(events.length, 2);
    strictEqual(events[0]?.type, 'run_started');
    strictEqual(events[1]?.type, 'run_started');
  });

  it('пустые строки (в т.ч. хвостовой перевод строки) не считаются событиями', () => {
    const root = tempRoot();
    const dir = join(root, '.sdlc', 'demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.events.ndjson'), `${JSON.stringify(started('r1'))}\n\n`);
    strictEqual(readPersistedEvents(root, 'demo').length, 1);
  });

  it('appendEvent не бросает, если каталог витка ещё не создан — только логирует', () => {
    const root = tempRoot();
    // Каталог .sdlc/demo НЕ создан заранее — лента вспомогательна, не должна ронять emit.
    appendEvent(root, 'demo', started('r1'));
    // Файл не появился без каталога — это ожидаемо (лучшее усилие), проверка не падает.
    deepStrictEqual(readPersistedEvents(root, 'demo'), []);
  });
});
