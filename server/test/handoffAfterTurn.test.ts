/**
 * `handoffModule.begin(host).afterTurn` — дефолт-подстановка «Кто утвердил» проводом до
 * настоящего хука этапа, а не только через `defaultUnapprovedRecords` напрямую: это и
 * есть контракт, который должен остаться верным при рефакторинге модуля.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ok, strictEqual } from 'node:assert/strict';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { handoffModule } from '../src/run/stages/handoff.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const COMPLETE_RECORD = [
  '# Передача контекста: demo',
  '',
  '## Запись о проскочившем дефекте',
  '',
  '### Запись 1',
  '',
  '- **Имя:** дублирующийся заказ при повторном клике',
  '- **Класс**: класс «двойной сабмит формы»',
  '- **Повтор:** нет',
  '- **Что проскочило:** повторный клик на «Оформить» создавал два заказа',
  '- **Какой гейт должен был поймать и почему не поймал:** Тесты — не покрывает класс',
  '- **Действие**: проверка',
  '- **Кто утвердил:** _(только имя из явного ответа человека на вопрос об этой записи — не имя',
  '  оператора сессии по умолчанию и не имя из более раннего одобрения витка)_ н/п / ‹имя› /',
  '  **(не утверждено — классификация агента по умолчанию)** — вопрос был пропущен или без ответа',
  '- **Где реализовано:** src/checkout.ts:submitOrder — добавлен debounce',
  '- **Чем закреплено**: test/checkout.test.ts::«двойной сабмит»',
  '',
].join('\n');

function repo(): WitokPaths {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-handoff-')));
  roots.push(root);
  const paths = new WitokPaths(root, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.handoff, COMPLETE_RECORD);
  return paths;
}

function host(paths: WitokPaths): StageHost {
  const emitted: string[] = [];
  const h = {
    id: 'run-1',
    paths,
    emit: (e: { message?: string }) => {
      if (e.message !== undefined) emitted.push(e.message);
    },
    writeAutofilled: (path: string, text: string) => writeFileSync(path, text),
  } as unknown as StageHost;
  return Object.assign(h, { __emitted: emitted }) as StageHost & { __emitted: string[] };
}

describe('handoffModule.begin(host).afterTurn — дефолт «Кто утвердил» (7.4, остаток)', () => {
  it('запись доведена до конца — рантайм подставляет дефолт и пишет файл', async () => {
    const paths = repo();
    const h = host(paths) as StageHost & { __emitted: string[] };

    await handoffModule.begin?.(h, {} as never)?.afterTurn?.({} as never, {} as never);

    const text = readFileSync(paths.handoff, 'utf8');
    ok(text.includes('**(не утверждено — классификация агента по умолчанию)**'), text);
    ok(!text.includes('‹имя›'), text);
    ok(h.__emitted.some((m) => m.includes('подставил честный дефолт')), h.__emitted.join('\n'));
  });

  it('идемпотентно: второй вызов ничего не меняет и не эмитит предупреждение снова', async () => {
    const paths = repo();
    const h1 = host(paths);
    await handoffModule.begin?.(h1, {} as never)?.afterTurn?.({} as never, {} as never);
    const once = readFileSync(paths.handoff, 'utf8');

    const h2 = host(paths) as StageHost & { __emitted: string[] };
    await handoffModule.begin?.(h2, {} as never)?.afterTurn?.({} as never, {} as never);
    const twice = readFileSync(paths.handoff, 'utf8');

    strictEqual(twice, once);
    strictEqual(h2.__emitted.length, 0);
  });

  it('handoff.md ещё нет на диске — не падает, ничего не делает', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sdlc-handoff-none-')));
    roots.push(root);
    const paths = new WitokPaths(root, 'demo');
    mkdirSync(paths.dir, { recursive: true });
    const h = host(paths);
    await handoffModule.begin?.(h, {} as never)?.afterTurn?.({} as never, {} as never);
  });
});
