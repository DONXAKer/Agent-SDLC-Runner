/**
 * Черновик `.sdlc/sandbox.json` по составу репозитория — то, что человек потом либо
 * подтверждает как есть, либо правит и сохраняет сам. Ничего не пишет на диск: это разведка,
 * а не решение, и то же самое разделение, на котором стоит `sdlc-locator` этапа 5 —
 * инструмент с правом видеть, не с правом менять.
 *
 * Эвристики нарочно грубые и заведомо неполные (JDK/Node — то, что реально понадобилось
 * CV; Python/Go/Rust не детектятся вовсе). Ложноотрицательный детект стоит недорого — черновик
 * выйдет короче, оператор дополнит руками; ложноположительный (версия, которой в проекте
 * не было) стоит попытки витка на пустом месте, поэтому там, где найденное неоднозначно,
 * функция молчит, а не гадает.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { SandboxSpec } from './types.ts';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'out', '.sdlc']);
const MAX_FILES_SCANNED = 4_000;

/** Обход в ограниченную глубину: сотни тысяч файлов `node_modules` в детекте видеть незачем
 * — манифесты (`pom.xml`, `package.json`, `Dockerfile`) живут у корня модуля, не глубоко. */
function walk(root: string, onFile: (path: string, name: string) => void): void {
  let scanned = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && scanned < MAX_FILES_SCANNED) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (scanned >= MAX_FILES_SCANNED) break;
      if (e.name.startsWith('.') && e.name !== '.sdlc') continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(join(dir, e.name));
      } else {
        scanned += 1;
        onFile(join(dir, e.name), e.name);
      }
    }
  }
}

function firstMatch(text: string, re: RegExp): string | null {
  return re.exec(text)?.[1] ?? null;
}

/** `java.version`/`maven.compiler.release` — тот же порядок значимости, что читает Maven
 * сам: явный `release` перекрывает пару `source`/`target`, `java.version` — соглашение
 * Spring Boot parent, встречается чаще обоих. */
function jdkVersionFromPom(xml: string): string | null {
  return (
    firstMatch(xml, /<java\.version>\s*(\d+)\s*<\/java\.version>/) ??
    firstMatch(xml, /<maven\.compiler\.release>\s*(\d+)\s*<\/maven\.compiler\.release>/)
  );
}

function nodeVersionFromPackageJson(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as { engines?: { node?: string } };
    const raw = parsed.engines?.node;
    if (raw === undefined) return null;
    // ">=22.0.0", "^22", "22.x" — берём первое целое число мажора, версии тулчейна в
    // спеке всё равно резолвятся до мажора (см. `dockerfile.ts`).
    return firstMatch(raw, /(\d+)/);
  } catch {
    return null;
  }
}

function nodeVersionFromDockerfile(text: string): string | null {
  return firstMatch(text, /FROM\s+node:(\d+)/);
}

export interface DetectResult {
  spec: SandboxSpec;
  /** Что именно нашли и откуда — не часть спеки, для показа человеку перед сохранением. */
  evidence: string[];
}

export function detectSandboxSpec(projectRoot: string): DetectResult {
  const evidence: string[] = [];
  let jdkVersion: string | null = null;
  let nodeVersion: string | null = null;
  let needsDocker = false;

  walk(projectRoot, (path, name) => {
    if (name === 'pom.xml' && jdkVersion === null) {
      const v = jdkVersionFromPom(readFileSync(path, 'utf8'));
      if (v !== null) {
        jdkVersion = v;
        evidence.push(`JDK ${v} — из ${path}`);
      }
    } else if (name === 'package.json' && nodeVersion === null) {
      const v = nodeVersionFromPackageJson(readFileSync(path, 'utf8'));
      if (v !== null) {
        nodeVersion = v;
        evidence.push(`Node ${v} — из ${path} (engines.node)`);
      }
    } else if (name === 'Dockerfile' && nodeVersion === null) {
      const v = nodeVersionFromDockerfile(readFileSync(path, 'utf8'));
      if (v !== null) {
        nodeVersion = v;
        evidence.push(`Node ${v} — из ${path} (FROM node:…)`);
      }
    } else if (!needsDocker && (name.endsWith('.java') || name.endsWith('.ts') || name.endsWith('.js'))) {
      // Полное чтение каждого исходника было бы дорого — Testcontainers почти всегда
      // тянет за собой характерное имя файла или директорию `test`/`it`, и импорт ищется
      // только там, а не по всему дереву исходников.
      if (/test|\bit\b/i.test(path)) {
        try {
          if (/testcontainers/i.test(readFileSync(path, 'utf8'))) {
            needsDocker = true;
            evidence.push(`Testcontainers — из ${path}`);
          }
        } catch {
          // нечитаемый файл детекту не критичен
        }
      }
    }
  });

  const toolchains: SandboxSpec['toolchains'] = {};
  const probes: NonNullable<SandboxSpec['probes']> = [];
  if (jdkVersion !== null) {
    toolchains.jdk = { version: jdkVersion, dist: 'temurin' };
    probes.push({ cmd: 'java -version', expect: `"${jdkVersion}\\.` });
  }
  if (nodeVersion !== null) {
    toolchains.node = { version: nodeVersion };
    probes.push({ cmd: 'node -v', expect: `^v${nodeVersion}\\.` });
  }
  if (needsDocker) {
    probes.push({ cmd: 'docker info', expect: 'Server Version' });
  }

  const spec: SandboxSpec = {
    base: 'debian:12-slim',
    toolchains,
    ...(needsDocker ? { docker: 'socket' as const } : {}),
    ...(probes.length > 0 ? { probes } : {}),
  };

  if (existsSync(join(projectRoot, 'backend'))) {
    // Не догадка, а прямое следствие уже найденного: символ модуля с этим именем в CV, но
    // проверка НЕ завязана на имя проекта — сработает для любого моно-репо с таким модулем.
    evidence.push('layout моно-репо: backend/ рядом — прогрев/сеть не предполагаются автоматически, задай руками при необходимости');
  }

  return { spec, evidence };
}
