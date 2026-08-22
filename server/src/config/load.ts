import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { ORDER } from '../gates/ecosystems/index.ts';
import { normalizeModuleDir } from '../gates/builtin/logic.ts';
import type { ModelsConfig, ProjectConfig, RunnerConfig } from './schema.ts';

/** Ключи вида `"// заметка"` в JSON — комментарии для человека; рантайм их игнорирует. */
function readJson<T>(file: string): T {
  if (!existsSync(file)) throw new Error(`конфиг не найден: ${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    throw new Error(`конфиг «${file}» не разобрался: ${(e as Error).message}`);
  }
}

export function configDir(): string {
  return process.env['SDLC_CONFIG_DIR'] ?? resolve(import.meta.dirname, '../../../config');
}

export interface LoadedConfig {
  dir: string;
  runner: RunnerConfig;
  models: ModelsConfig;
  projects: Map<string, ProjectConfig>;
}

/**
 * Умолчания лимитов.
 *
 * JSON читается как есть, без схемы, поэтому забытый ключ приходил бы в код как
 * `undefined` под типом `number` — и всплывал бы уже таймаутом в `NaN` мс посреди
 * сборки. Дешевле подставить умолчание здесь.
 */
const LIMIT_DEFAULTS = {
  maxToolResultBytes: 60_000,
  readRangeRequiredAboveBytes: 120_000,
  maxIterationsPerStage: 40,
  gateTimeoutMs: 900_000,
  progressClosenessWarn: 0.9,
  chatTimeoutMs: 600_000,
};

/**
 * `skillsDir`/`agentsDir`/`methodologyDir`/`port` в `runner.json` — реальные значения на
 * машине разработчика (сегодня пути — Windows), а не переносимый шаблон. На другой машине
 * их переопределяют этими переменными окружения, не трогая закоммиченный файл.
 */
/** Пустая или чисто пробельная строка — тоже «не задано», не только `undefined`. */
function nonBlank(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * `SDLC_PORT` в `docker-compose.yml` — это только внешний маппинг хост-порта, внутрь
 * контейнера он не пробрасывается (комментарий в `.env.example`: «Внутри контейнера
 * всегда 8030»), так что там это переопределение бездействует и ничего не ломает. При
 * прямом запуске раннера (без Docker) та же переменная даёт сменить слушающий порт, не
 * трогая закоммиченный `runner.json`.
 */
function portOverride(): number | undefined {
  const raw = nonBlank(process.env['SDLC_PORT']);
  if (raw === undefined) return undefined;
  // Строгий формат до `Number()`: голый парсер принимает hex (`0x1F` → 31) и экспоненту
  // (`1e4` → 10000) как валидные целые — опечатка в `.env` превращалась бы в другой порт
  // молча, а не в ошибку загрузки.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`SDLC_PORT «${raw}» — не похоже на номер порта`);
  }
  const port = Number(raw);
  if (port <= 0 || port > 65535) {
    throw new Error(`SDLC_PORT «${raw}» — не похоже на номер порта`);
  }
  return port;
}

function pathOverrides(): Partial<RunnerConfig> {
  const overrides: Partial<RunnerConfig> = {};
  // Пустая/пробельная строка — тоже «не задано»: `SDLC_SKILLS_DIR=""` (или `" "`) в
  // окружении иначе тихо затирает валидный путь из runner.json, и дальше `join('', ...)`
  // резолвится от cwd процесса — ошибка идёт с сообщением про runner.json, а причина в env.
  const skillsDir = nonBlank(process.env['SDLC_SKILLS_DIR']);
  const agentsDir = nonBlank(process.env['SDLC_AGENTS_DIR']);
  const methodologyDir = nonBlank(process.env['SDLC_METHODOLOGY_DIR']);
  if (skillsDir !== undefined) overrides.skillsDir = skillsDir;
  if (agentsDir !== undefined) overrides.agentsDir = agentsDir;
  if (methodologyDir !== undefined) overrides.methodologyDir = methodologyDir;
  const port = portOverride();
  if (port !== undefined) overrides.port = port;
  return overrides;
}

/**
 * Проверка описания модулей проекта.
 *
 * JSON читается без схемы, поэтому опечатка в имени экосистемы или путь к несуществующему
 * каталогу молча превратились бы в «детект не сработал» — то есть в гейт «Сборка»,
 * проверяющий не тот модуль или не проверяющий ничего. Ошибка загрузки честнее: виток не
 * стартует, и человек читает причину.
 */
function validateModules(p: ProjectConfig): void {
  if (p.modules === undefined) return;
  if (!Array.isArray(p.modules)) {
    throw new Error(`проект «${p.name}»: поле modules должно быть списком`);
  }

  const known = ORDER.map((e) => e.id);
  const seen = new Set<string>();

  for (const m of p.modules) {
    if (typeof m?.dir !== 'string' || m.dir.trim() === '') {
      throw new Error(`проект «${p.name}»: у модуля не задан dir`);
    }
    const dir = normalizeModuleDir(m.dir);
    if (seen.has(dir)) {
      throw new Error(`проект «${p.name}»: модуль ${dir} описан дважды`);
    }
    seen.add(dir);

    const full = dir === '.' ? p.projectRoot : join(p.projectRoot, dir);
    if (!existsSync(full)) {
      throw new Error(`проект «${p.name}»: каталог модуля ${dir} не существует (${full})`);
    }
    if (m.ecosystem !== undefined && !known.includes(m.ecosystem)) {
      throw new Error(
        `проект «${p.name}», модуль ${dir}: неизвестная экосистема «${m.ecosystem}». ` +
          `Известные: ${known.join(', ')}`,
      );
    }
    // Описание, которое не говорит НИЧЕГО, — это не описание: детект в таком случае и так
    // отработает, а строка в конфиге создаёт ложное впечатление настройки.
    if (m.ecosystem === undefined && m.build === undefined) {
      throw new Error(
        `проект «${p.name}», модуль ${dir}: нужно задать ecosystem или build — иначе ` +
          `описание ничего не добавляет к автодетекту`,
      );
    }
  }
}

export function loadConfig(dir: string = configDir()): LoadedConfig {
  const raw = readJson<RunnerConfig>(join(dir, 'runner.json'));
  const runner: RunnerConfig = {
    ...raw,
    ...pathOverrides(),
    limits: { ...LIMIT_DEFAULTS, ...raw.limits },
  };
  const models = readJson<ModelsConfig>(join(dir, 'models.json'));

  const projectsDir = join(dir, 'projects');
  const projects = new Map<string, ProjectConfig>();
  if (existsSync(projectsDir)) {
    for (const file of readdirSync(projectsDir)) {
      if (!file.endsWith('.json')) continue;
      const p = readJson<ProjectConfig>(join(projectsDir, file));
      if (typeof p.name !== 'string' || p.name === '') {
        throw new Error(`проект «${file}»: не задано поле name`);
      }
      if (typeof p.projectRoot !== 'string' || p.projectRoot === '') {
        throw new Error(`проект «${p.name}»: не задано поле projectRoot`);
      }
      validateModules(p);
      projects.set(p.name, p);
    }
  }

  if (projects.size === 0) {
    throw new Error(`в ${projectsDir} нет ни одного проекта — нечего запускать`);
  }

  return { dir, runner, models, projects };
}

export function requireProject(cfg: LoadedConfig, name: string): ProjectConfig {
  const p = cfg.projects.get(name);
  if (p === undefined) {
    throw new Error(
      `проект «${name}» не найден. Известные: ${[...cfg.projects.keys()].join(', ')}`,
    );
  }
  return p;
}
