/**
 * Версия формы артефакта — первая строка шаблона `<!-- sdlc-template: <имя> vN -->`
 * (`CLAUDE.md` методологии: правка структуры поднимает N; по нему инструменты и люди
 * отличают артефакт, снятый старой формой). Артефакт витка, снятый формой другой версии,
 * этап не заполняет: его механика (автозаполнение, разбор таблиц, вердикт) написана под
 * текущую форму, и молчаливая работа по старой форме дала бы «заполненный» артефакт с
 * секциями, которых вердикт не читает.
 *
 * Артефакт без строки версии (снят до её появления либо написан рукой) — не блокер, а
 * предупреждение: старые витки должны дочитываться.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { templateNameFor } from '../run/seed.ts';

const VERSION_LINE = /<!--\s*sdlc-template:\s*(\S+)\s+v(\d+)\s*-->/;

export function templateVersionOf(text: string): { name: string; v: number } | null {
  const m = VERSION_LINE.exec(text.slice(0, 8192));
  return m === null ? null : { name: m[1]!, v: Number(m[2]) };
}

export type TemplateVersionCheck =
  | { kind: 'ok' }
  | { kind: 'no-template' }
  | { kind: 'unversioned'; template: { name: string; v: number } }
  | { kind: 'mismatch'; artifact: { name: string; v: number }; template: { name: string; v: number } };

export function checkTemplateVersion(artifactPath: string, methodologyDir: string): TemplateVersionCheck {
  const templatePath = join(methodologyDir, 'templates', templateNameFor(artifactPath));
  if (!existsSync(templatePath) || !existsSync(artifactPath)) return { kind: 'no-template' };
  const template = templateVersionOf(readFileSync(templatePath, 'utf8'));
  if (template === null) return { kind: 'no-template' };
  const artifact = templateVersionOf(readFileSync(artifactPath, 'utf8'));
  if (artifact === null) return { kind: 'unversioned', template };
  return artifact.name === template.name && artifact.v === template.v ? { kind: 'ok' } : { kind: 'mismatch', artifact, template };
}
