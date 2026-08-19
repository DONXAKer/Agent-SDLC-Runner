import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
  chatTimeoutMs: 600_000,
};

/**
 * `skillsDir`/`agentsDir`/`methodologyDir` в `runner.json` — реальные пути на машине
 * разработчика (сегодня это Windows), а не переносимый шаблон. На другой машине их
 * переопределяют этими переменными окружения, не трогая закоммиченный файл.
 */
/** Пустая или чисто пробельная строка — тоже «не задано», не только `undefined`. */
function nonBlank(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed === '' ? undefined : trimmed;
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
  return overrides;
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
