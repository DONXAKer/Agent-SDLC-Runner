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
/**
 * Отдельный, куда более щедрый бюджет ТОЛЬКО на число каталогов, поставленных в очередь —
 * не смешан с `MAX_FILES_SCANNED`. Смешанный счётчик (пробовался раньше) бил по
 * собственной цели BFS-фикса: в моно-репо с большим числом легитимных модулей-каталогов на
 * верхних уровнях бюджет исчерпывался на подсчёте самих каталогов раньше, чем обход
 * добирался до файлов-манифестов у их корня. Здесь же цель — не бюджет глубины поиска, а
 * защита от неограниченного роста `queue` на патологических деревьях (тысячи пустых
 * подкаталогов) — для неё щедрого потолка достаточно.
 */
const MAX_DIRS_QUEUED = 20_000;

/**
 * Обход в ограниченную глубину: сотни тысяч файлов `node_modules` в детекте видеть незачем
 * — манифесты (`pom.xml`, `package.json`, `Dockerfile`) живут у корня модуля, не глубоко.
 *
 * BFS (очередь, `shift()`), не DFS через стек: манифесты у корня КАЖДОГО модуля обязаны
 * попасть в поле зрения раньше, чем бюджет `MAX_FILES_SCANNED` исчерпается — c DFS порядок
 * обхода зависел от того, в каком порядке `readdirSync` вернул каталоги ВЕРХНЕГО уровня.
 * В моно-репо с `backend/`+`frontend/`, если `frontend` оказывался в стеке позже `backend`
 * (значит, popится РАНЬШЕ — LIFO), он разбирался целиком первым; при большом числе файлов
 * в его подкаталогах (`public/`, `assets/`) бюджет мог исчерпаться внутри `frontend`, не
 * дойдя до `backend/pom.xml` вовсе. BFS обходит каждый уровень вложенности целиком, прежде
 * чем уйти глубже — предсказуемо доходит до корня каждого модуля верхнего уровня первым.
 */
function walk(root: string, onFile: (path: string, name: string) => void): void {
  let scanned = 0;
  const queue: string[] = [root];
  let head = 0;
  while (head < queue.length && scanned < MAX_FILES_SCANNED) {
    const dir = queue[head] as string;
    head += 1;
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
        // Свой, отдельный от `scanned` потолок — см. `MAX_DIRS_QUEUED` выше: защита от
        // раздувания `queue`, не от глубины поиска манифестов.
        if (queue.length >= MAX_DIRS_QUEUED) continue;
        queue.push(join(dir, e.name));
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

/**
 * Форма, в которой `java -version` реально печатает номер версии.
 *
 * JDK 8 и старше используют дореформенную схему (JEP 223 сменила её только с 9): вывод
 * начинается с `"1.8.0_XXX`, не `"8...` — проверено исполнением: `eclipse-temurin:8-jdk`
 * даёт `openjdk version "1.8.0_502"`, `eclipse-temurin:21-jdk` — `"21.0.11"`. Проба,
 * построенная без этой поправки, ложно проваливается на верно установленной JDK 8 —
 * pre-flight блокирует этап, хотя тулчейн на месте.
 */
function javaVersionProbeExpect(version: string): string {
  const major = Number.parseInt(version, 10);
  return Number.isFinite(major) && major <= 8 ? `"1\\.${version}\\.` : `"${version}\\.`;
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

/** Файл без прав на чтение, битый symlink или удалённый между `readdirSync` и
 * `readFileSync` (реальная гонка — сам `walk` уже ловит такую же для каталогов, строки
 * 30-34) — `null`, не исключение. Весь модуль — best-effort детект: один нечитаемый файл
 * не должен ронять черновик спеки целиком, только эту одну находку. Раньше `readFileSync`
 * трёх мест ниже был не обёрнут — исключение долетало необработанным до
 * `GET /api/projects/:name/sandbox/detect`, где try/catch маршрута ловил его как 404
 * «проект не найден», хотя `requireProject` уже успешно нашёл проект. */
function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

export function detectSandboxSpec(projectRoot: string): DetectResult {
  const evidence: string[] = [];
  let jdkVersion: string | null = null;
  let nodeVersion: string | null = null;
  let needsDocker = false;

  walk(projectRoot, (path, name) => {
    if (name === 'pom.xml' && jdkVersion === null) {
      const content = tryReadFile(path);
      const v = content === null ? null : jdkVersionFromPom(content);
      if (v !== null) {
        jdkVersion = v;
        evidence.push(`JDK ${v} — из ${path}`);
      }
    } else if (name === 'package.json' && nodeVersion === null) {
      const content = tryReadFile(path);
      const v = content === null ? null : nodeVersionFromPackageJson(content);
      if (v !== null) {
        nodeVersion = v;
        evidence.push(`Node ${v} — из ${path} (engines.node)`);
      }
    } else if (name === 'Dockerfile' && nodeVersion === null) {
      const content = tryReadFile(path);
      const v = content === null ? null : nodeVersionFromDockerfile(content);
      if (v !== null) {
        nodeVersion = v;
        evidence.push(`Node ${v} — из ${path} (FROM node:…)`);
      }
    } else if (!needsDocker && (name.endsWith('.java') || name.endsWith('.ts') || name.endsWith('.js'))) {
      // Полное чтение каждого исходника было бы дорого — Testcontainers почти всегда
      // тянет за собой характерное имя файла или директорию `test`/`it`, и импорт ищется
      // только там, а не по всему дереву исходников.
      if (/test|\bit\b/i.test(path)) {
        const content = tryReadFile(path);
        if (content !== null && /testcontainers/i.test(content)) {
          needsDocker = true;
          evidence.push(`Testcontainers — из ${path}`);
        }
      }
    }
  });

  const toolchains: SandboxSpec['toolchains'] = {};
  const probes: NonNullable<SandboxSpec['probes']> = [];
  if (jdkVersion !== null) {
    toolchains.jdk = { version: jdkVersion, dist: 'temurin' };
    probes.push({ cmd: 'java -version', expect: javaVersionProbeExpect(jdkVersion) });
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
