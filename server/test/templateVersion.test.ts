/**
 * Версия формы `<!-- sdlc-template: X vN -->`: артефакт другой версии — блокер этапа, без
 * строки версии — предупреждение, совпадение — ок.
 */

import { deepStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkTemplateVersion, templateVersionOf } from '../src/artifacts/templateVersion.ts';

const root = mkdtempSync(join(tmpdir(), 'sdlc-tplver-'));
after(() => rmSync(root, { recursive: true, force: true }));

describe('версия формы', () => {
  it('разбор строки версии', () => {
    deepStrictEqual(templateVersionOf('<!-- sdlc-template: plan v3 -->\n# План'), { name: 'plan', v: 3 });
    strictEqual(templateVersionOf('# План без версии'), null);
  });

  it('совпадение / расхождение / без версии / без формы', () => {
    mkdirSync(join(root, 'templates'), { recursive: true });
    writeFileSync(join(root, 'templates', 'plan.template.md'), '<!-- sdlc-template: plan v2 -->\n# План\n', 'utf8');
    const plan = join(root, 'plan.md');
    writeFileSync(plan, '<!-- sdlc-template: plan v2 -->\n# План\n', 'utf8');
    deepStrictEqual(checkTemplateVersion(plan, root), { kind: 'ok' });
    writeFileSync(plan, '<!-- sdlc-template: plan v1 -->\n# План\n', 'utf8');
    deepStrictEqual(checkTemplateVersion(plan, root), { kind: 'mismatch', artifact: { name: 'plan', v: 1 }, template: { name: 'plan', v: 2 } });
    writeFileSync(plan, '# План старого витка\n', 'utf8');
    deepStrictEqual(checkTemplateVersion(plan, root), { kind: 'unversioned', template: { name: 'plan', v: 2 } });
    deepStrictEqual(checkTemplateVersion(join(root, 'handoff.md'), root), { kind: 'no-template' });
  });
});
