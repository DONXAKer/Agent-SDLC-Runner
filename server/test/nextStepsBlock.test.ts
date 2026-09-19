/**
 * «Данные для «С чего начинать дальше»» (7.6) — `stages/handoff.ts::postponedItems` и
 * `nextStepsBlock`: рантайм подаёт «Уходит следующим chunk'ам» плана и «Отложено» отчёта
 * по вопросам готовым списком, модель пишет один абзац по факту, а не по памяти.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { WitokPaths } from '../src/artifacts/paths.ts';
import { nextStepsBlock, postponedItems } from '../src/run/stages/handoff.ts';
import type { StageHost } from '../src/run/stages/types.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe('postponedItems', () => {
  it('читает пункты «Отложено», пропуская «нет отложенных»', () => {
    const text = [
      '## Отложено',
      '_легенда_',
      '',
      '- Расширять ли scope на зону far? — не блокирует, зона появится следующим витком',
      '- нет отложенных',
    ].join('\n');
    deepStrictEqual(postponedItems(text), ['Расширять ли scope на зону far? — не блокирует, зона появится следующим витком']);
  });

  it('строка-образец (плейсхолдер) не возвращается', () => {
    const text = '## Отложено\n\n- ‹вопрос› — ‹почему допустимо начинать без ответа›\n- нет отложенных\n';
    deepStrictEqual(postponedItems(text), []);
  });

  it('секции нет — пустой список, не падение', () => {
    deepStrictEqual(postponedItems('# Отчёт\nбез секции\n'), []);
  });
});

function repo(): WitokPaths {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-nextsteps-'));
  roots.push(root);
  const paths = new WitokPaths(root, 'demo');
  mkdirSync(paths.dir, { recursive: true });
  return paths;
}

function host(paths: WitokPaths): StageHost {
  return { paths } as unknown as StageHost;
}

describe('nextStepsBlock', () => {
  it('оба источника есть — блок называет и то, и другое', () => {
    const paths = repo();
    writeFileSync(paths.plan, "## files_to_touch\n\n- **Уходит следующим chunk'ам:** claim-5 — chunk 2\n");
    writeFileSync(paths.clarificationReport, '## Отложено\n\n- Нужен ли кеш? — не блокирует, добавим при первом замере\n');

    const block = nextStepsBlock(host(paths));
    ok(block !== null);
    ok(block.includes("Уходит следующим chunk'ам (план): claim-5 — chunk 2"), block);
    ok(block.includes('Отложено (отчёт по вопросам):'), block);
    ok(block.includes('Нужен ли кеш?'), block);
  });

  it('оба источника пусты/недоступны — null, а не пустой блок', () => {
    const paths = repo();
    const block = nextStepsBlock(host(paths));
    strictEqual(block, null);
  });

  it('только план есть, отчёта по вопросам не было — «нет отложенных» честно называется', () => {
    const paths = repo();
    writeFileSync(paths.plan, "## files_to_touch\n\n- **Уходит следующим chunk'ам:** нет — этот chunk закрывает все пункты\n");
    const block = nextStepsBlock(host(paths));
    ok(block !== null);
    ok(block.includes('нет — этот chunk закрывает все пункты'), block);
    ok(block.includes('Отложено (отчёт по вопросам): нет отложенных'), block);
  });

  it("план ещё не заполнил «Уходит следующим chunk'ам» (плейсхолдер), но есть отложенный вопрос — «не заполнено» рядом с реальными данными", () => {
    const paths = repo();
    writeFileSync(paths.plan, "## files_to_touch\n\n- **Уходит следующим chunk'ам:** ‹id и каким chunk'ом› / нет — этот chunk закрывает все пункты\n");
    writeFileSync(paths.clarificationReport, '## Отложено\n\n- Нужен ли кеш? — не блокирует\n');
    const block = nextStepsBlock(host(paths));
    ok(block !== null);
    ok(block.includes("Уходит следующим chunk'ам (план): не заполнено"), block);
    ok(block.includes('Нужен ли кеш?'), block);
  });

  it('оба источника пусты одновременно (план не заполнен, вопросов не отложено) — null', () => {
    const paths = repo();
    writeFileSync(paths.plan, "## files_to_touch\n\n- **Уходит следующим chunk'ам:** ‹id и каким chunk'ом› / нет — этот chunk закрывает все пункты\n");
    writeFileSync(paths.clarificationReport, '## Отложено\n\n- нет отложенных\n');
    strictEqual(nextStepsBlock(host(paths)), null);
  });
});
