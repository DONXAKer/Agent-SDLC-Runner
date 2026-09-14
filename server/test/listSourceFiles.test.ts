/**
 * `listSourceFiles` — опция `includeDotDirs` для заземления карты кода (`FormFillExecutor`).
 *
 * Без неё обход отбрасывал всё, что начинается с точки, и существующий `.storybook/main.ts`
 * модель называла «новым»: в списке реальных файлов его не было. Гейт дублей при этом ведёт
 * себя как раньше — точечные каталоги ему не нужны.
 */

import { deepStrictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { listSourceFiles } from '../src/gates/builtin/index.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'sdlc-lsf-'));
  roots.push(root);
  const put = (rel: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), 'export const x = 1;\n');
  };
  put('src/a.ts');
  put('.storybook/main.ts');
  put('.git/hooks/pre-commit.ts');
  put('.sdlc/demo/x.ts');
  put('node_modules/lib/index.ts');
  put('.next/cache/page.ts');
  return root;
}

describe('listSourceFiles: includeDotDirs', () => {
  it('по умолчанию (гейт дублей) — точечные каталоги пропускаются, как раньше', async () => {
    const { files } = await listSourceFiles(tree(), 100);
    deepStrictEqual(files.sort(), ['src/a.ts']);
  });

  it('includeDotDirs — .storybook в списке, а .git/.sdlc/node_modules и кэши сборщиков — нет', async () => {
    const { files } = await listSourceFiles(tree(), 100, undefined, { includeDotDirs: true });
    deepStrictEqual(files.sort(), ['.storybook/main.ts', 'src/a.ts']);
  });
});
