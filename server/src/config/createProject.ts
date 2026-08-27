/**
 * Добавление проекта из интерфейса поверх выбора каталога в `/api/browse`.
 *
 * Пишет `config/projects/<name>.local.json` в том же каноническом формате, что и
 * ручные конфиги — `config/projects/*.local.json` в `.gitignore` намеренно, чтобы
 * добавленный через UI проект не утекал в коммит по умолчанию.
 *
 * `browseRoot` обязателен: без него нет дерева, к которому можно было бы сузить
 * `projectRoot`, а ручка обязана либо сужать, либо не работать вовсе — как и её пара
 * `GET /api/browse`. Решение об этом принимается один раз в `index.ts`, до вызова
 * `createProject`, а не здесь через необязательную проверку.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProjectConfig } from './schema.ts';
import type { LoadedConfig } from './load.ts';
import { isWithinAny } from '../policy/paths.ts';
import { realpathPosix } from '../fs/realpath.ts';
import { badSlug } from '../validation.ts';

/**
 * Один профиль на все стадии, во флоу `sdk` (Max-подписка) — тот же выбор моделей, что
 * у ручного `example.json`. Правило рецензента (verify строго сильнее chunk) здесь
 * соблюдено: `opus` (90) > `sonnet` (70).
 */
const DEFAULT_PROFILE = {
  claude: {
    label: 'Claude (Max-подписка)',
    stages: {
      intent: 'claude-sdk:haiku',
      explore: 'claude-sdk:sonnet',
      ask: 'claude-sdk:haiku',
      plan: 'claude-sdk:sonnet',
      chunk: 'claude-sdk:sonnet',
      verify: 'claude-sdk:opus',
      handoff: 'claude-sdk:haiku',
    },
  },
} as const;

export interface CreateProjectInput {
  name: string;
  projectRoot: string;
  browseRoot: string;
}

export function createProject(config: LoadedConfig, input: CreateProjectInput): ProjectConfig {
  const nameProblem = badSlug(input.name);
  if (nameProblem !== null) throw new Error(`имя проекта: ${nameProblem}`);
  if (config.projects.has(input.name)) {
    throw new Error(`проект «${input.name}» уже существует`);
  }

  // Лексическая проверка раньше существования и до канонизации: путь, очевидно лежащий
  // вне дерева, обязан получить «вне разрешённого дерева», а не «не найден» только
  // потому, что заодно не существует. Сравнение — сырые строки против сырых: если тут
  // сравнить с уже канонизированным `realBrowseRoot`, а `projectRoot` ещё не
  // канонизирован, любой symlink в общем предке обеих (например, macOS `/tmp` →
  // `/private/tmp`) даёт ложное «вне дерева» для пути, который на самом деле внутри —
  // окончательный вердикт всё равно ниже, уже по realpath обеих сторон.
  if (!isWithinAny([input.browseRoot], input.projectRoot)) {
    throw new Error(`каталог вне разрешённого дерева SDLC_BROWSE_ROOT: ${input.projectRoot}`);
  }

  const realBrowseRoot = realpathPosix(input.browseRoot, `SDLC_BROWSE_ROOT не найден: ${input.browseRoot}`);

  const realRoot = realpathPosix(input.projectRoot, `каталог не найден: ${input.projectRoot}`);
  if (!statSync(realRoot).isDirectory()) {
    throw new Error(`не каталог: ${input.projectRoot}`);
  }
  // Повторная проверка уже по realpath: лексическая выше не ловит символьную ссылку,
  // ведущую мимо browseRoot при формально «внутреннем» пути.
  if (!isWithinAny([realBrowseRoot], realRoot)) {
    throw new Error(`каталог вне разрешённого дерева SDLC_BROWSE_ROOT: ${input.projectRoot}`);
  }

  const project: ProjectConfig = {
    name: input.name,
    projectRoot: realRoot,
    activeProfile: 'claude',
    maxBudgetUsd: 5.0,
    profiles: DEFAULT_PROFILE,
  };

  const projectsDir = join(config.dir, 'projects');
  mkdirSync(projectsDir, { recursive: true });
  const file = join(projectsDir, `${input.name}.local.json`);
  if (existsSync(file)) throw new Error(`файл уже существует: ${file}`);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`);

  config.projects.set(project.name, project);
  return project;
}
