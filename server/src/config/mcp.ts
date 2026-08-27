/**
 * Внешние MCP-серверы целевого проекта: чтение `.mcp.json`, слияние с переопределением,
 * разрешительные списки по этапам.
 *
 * База — файл проекта, тот же самый, который читает Claude Code. Раннер его НЕ копирует:
 * машинные пути (`uv.exe`, каталоги питона) принадлежат проекту и его машине, а не нашему
 * конфигу; в `config/projects/*.json` пишется только то, что отличается.
 *
 * Граница строгости проведена по одному признаку — станет ли утверждение верным само.
 * Опечатка в описании (неизвестный транспорт, `http` без `url`, ссылка на несуществующий
 * сервер) верной не станет никогда: это ошибка загрузки. А вот НЕДОСТУПНЫЙ сервер —
 * обычное дело: редактор не запущен, порт закрыт. Это не повод не стартовать раннер и не
 * повод не начинать виток, поэтому сюда оно не доходит вовсе — недоступность живёт в
 * состоянии сервера во время прогона.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { McpToolRule, StageId } from '@sdlc-runner/shared';

import type { McpProjectConfig, McpServerOverride, McpToolAllow, ProjectConfig } from './schema.ts';

/** Описание сервера, готовое к подключению: транспорт уже выбран, значения развёрнуты. */
export type McpServerSpec =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd: string;
      connectTimeoutMs: number;
      callTimeoutMs: number;
      pollingTools: readonly string[];
    }
  | {
      name: string;
      transport: 'http';
      url: string;
      headers: Record<string, string>;
      connectTimeoutMs: number;
      callTimeoutMs: number;
      pollingTools: readonly string[];
    };

export interface McpSetup {
  /** Серверы, включённые для этого проекта. Пусто — MCP не используется. */
  servers: readonly McpServerSpec[];
  /** Разрешительные списки по этапам: этап → правила. */
  rulesByStage: ReadonlyMap<string, readonly McpToolRule[]>;
  maxInlineTools: number;
  maxResultBytes: number;
  /** Проблема чтения файла проекта — показать оператору, но не ронять загрузку. */
  fileProblem: string | null;
}

export const EMPTY_MCP: McpSetup = {
  servers: [],
  rulesByStage: new Map(),
  maxInlineTools: 12,
  maxResultBytes: 20_000,
  fileProblem: null,
};

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
/** `pie_start` и прогон тестов в редакторе идут минутами — потолок общий, но щедрый. */
const DEFAULT_CALL_TIMEOUT_MS = 120_000;

interface RawServer {
  type?: string;
  command?: string;
  args?: unknown;
  env?: unknown;
  url?: string;
  headers?: unknown;
}

/**
 * Разворачивание `${VAR}` из окружения плюс два собственных плейсхолдера.
 *
 * Неразвёрнутая переменная не роняет загрузку и не подставляется пустой строкой: она
 * остаётся в значении как есть, и сервер отбраковывается при подключении с внятной
 * причиной. Пустая строка вместо токена дала бы 401 вместо «переменная не задана».
 */
export function expandVars(value: string, projectRoot: string, configDir: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*|projectRoot|configDir)\}/g, (whole, name) => {
    if (name === 'projectRoot') return projectRoot;
    if (name === 'configDir') return configDir;
    const fromEnv = process.env[name as string];
    return fromEnv === undefined || fromEnv === '' ? whole : fromEnv;
  });
}

/** Есть ли в строке неразвёрнутая переменная — проверяется при подключении, не при загрузке. */
export function hasUnexpanded(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

/** Имя переменной окружения для сервера: `unreal-ue58` → `MCP_UNREAL_UE58_URL`. */
export function envKeyFor(server: string, suffix: 'URL' | 'TOKEN'): string {
  return `MCP_${server.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
}

function asStringMap(v: unknown, what: string, project: string): Record<string, string> {
  if (v === undefined) return {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error(`проект «${project}»: ${what} должно быть объектом строк`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k.startsWith('//')) continue;
    if (typeof val !== 'string') {
      throw new Error(`проект «${project}»: ${what}.${k} должно быть строкой`);
    }
    out[k] = val;
  }
  return out;
}

function asStringList(v: unknown, what: string, project: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`проект «${project}»: ${what} должно быть списком строк`);
  }
  return v as string[];
}

/** Чтение `.mcp.json` целевого проекта. Нет файла — пусто; битый файл — названная причина. */
function readProjectFile(
  projectRoot: string,
  rel: string,
): { servers: Record<string, RawServer>; problem: string | null } {
  const file = isAbsolute(rel) ? rel : join(projectRoot, rel);
  if (!existsSync(file)) return { servers: {}, problem: null };

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: unknown };
    const raw = parsed.mcpServers;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { servers: {}, problem: `${rel}: в файле нет объекта mcpServers` };
    }
    return { servers: raw as Record<string, RawServer>, problem: null };
  } catch (e) {
    return { servers: {}, problem: `${rel}: файл не разобрался — ${(e as Error).message}` };
  }
}

/**
 * Слияние базы и переопределения для одного сервера.
 *
 * `command`/`url`/`type`/`args` заменяются целиком, `env`/`headers` сливаются по ключам.
 */
function mergeServer(
  name: string,
  base: RawServer | undefined,
  over: McpServerOverride | undefined,
  project: string,
  projectRoot: string,
  configDir: string,
): McpServerSpec {
  const type = over?.type ?? base?.type ?? (base?.url !== undefined ? 'http' : 'stdio');
  if (type !== 'stdio' && type !== 'http') {
    throw new Error(`проект «${project}», MCP-сервер «${name}»: неизвестный транспорт «${type}»`);
  }

  const exp = (s: string): string => expandVars(s, projectRoot, configDir);
  const connectTimeoutMs = over?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = over?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const pollingTools = over?.pollingTools ?? [];

  if (type === 'http') {
    const fromEnv = process.env[envKeyFor(name, 'URL')];
    const url = fromEnv !== undefined && fromEnv !== '' ? fromEnv : (over?.url ?? base?.url);
    if (url === undefined || url === '') {
      throw new Error(
        `проект «${project}», MCP-сервер «${name}»: транспорт http без url. Задай url в ` +
          `.mcp.json, в переопределении или переменной ${envKeyFor(name, 'URL')}`,
      );
    }
    const headers: Record<string, string> = {
      ...asStringMap(base?.headers, `сервер «${name}», headers`, project),
      ...(over?.headers ?? {}),
    };
    const token = process.env[envKeyFor(name, 'TOKEN')];
    if (token !== undefined && token !== '' && headers['authorization'] === undefined) {
      headers['authorization'] = `Bearer ${token}`;
    }
    const expandedHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) expandedHeaders[k] = exp(v);
    return {
      name,
      transport: 'http',
      url: exp(url),
      headers: expandedHeaders,
      connectTimeoutMs,
      callTimeoutMs,
      pollingTools,
    };
  }

  const command = over?.command ?? base?.command;
  if (command === undefined || command === '') {
    throw new Error(`проект «${project}», MCP-сервер «${name}»: транспорт stdio без command`);
  }
  const args = over?.args ?? asStringList(base?.args, `сервер «${name}», args`, project);
  const env: Record<string, string> = {
    ...asStringMap(base?.env, `сервер «${name}», env`, project),
    ...(over?.env ?? {}),
  };
  const expandedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) expandedEnv[k] = exp(v);

  return {
    name,
    transport: 'stdio',
    command: exp(command),
    args: args.map(exp),
    env: expandedEnv,
    cwd: projectRoot,
    connectTimeoutMs,
    callTimeoutMs,
    pollingTools,
  };
}

const STAGE_IDS: readonly string[] = [
  'intent',
  'explore',
  'ask',
  'plan',
  'chunk',
  'verify',
  'handoff',
];

function toRule(server: string, allow: string | McpToolAllow, project: string): McpToolRule {
  const raw: McpToolAllow = typeof allow === 'string' ? { tool: allow } : allow;
  if (typeof raw.tool !== 'string' || raw.tool.trim() === '') {
    throw new Error(`проект «${project}», сервер «${server}»: в списке инструментов пустое имя`);
  }

  // Умолчание — `write`. Неназванный класс считается изменяющим: ошибка в эту сторону
  // стоит лишнего подтверждения, в обратную — необратимого вызова без подтверждения.
  const mode = raw.mode ?? 'write';
  if (mode !== 'read' && mode !== 'write') {
    throw new Error(
      `проект «${project}», сервер «${server}», инструмент «${raw.tool}»: ` +
        `mode должен быть read или write`,
    );
  }
  if (mode === 'read' && raw.tool.endsWith('*')) {
    throw new Error(
      `проект «${project}», сервер «${server}»: шаблон «${raw.tool}» не может быть read — ` +
        `под него попадут инструменты, которых человек не видел`,
    );
  }

  const pathArgs = (raw.pathArgs ?? []).map((a) => {
    if (typeof a?.key !== 'string' || a.key === '') {
      throw new Error(`проект «${project}», сервер «${server}», «${raw.tool}»: pathArgs без key`);
    }
    return { key: a.key, access: a.access ?? 'write' };
  });

  if (mode === 'read' && pathArgs.some((a) => a.access === 'write')) {
    throw new Error(
      `проект «${project}», сервер «${server}», «${raw.tool}»: инструмент объявлен read, ` +
        `но пишет в путь из аргумента — записывающий файл инструмент читающим не бывает`,
    );
  }

  return { server, tool: raw.tool, mode, pathArgs };
}

/**
 * Разбор блока `mcp` проекта. Бросает на описании, которое верным не станет.
 *
 * `configDir` нужен только для плейсхолдера `${configDir}` в значениях.
 */
export function resolveMcp(p: ProjectConfig, configDir: string): McpSetup {
  const cfg: McpProjectConfig | undefined = p.mcp;
  if (cfg === undefined || cfg.enabled === false) return EMPTY_MCP;

  const file = readProjectFile(p.projectRoot, cfg.fromProjectFile ?? '.mcp.json');
  const overrides = cfg.servers ?? {};
  const unlistedOn = cfg.unlistedServers === 'on';

  const names = new Set<string>([...Object.keys(file.servers), ...Object.keys(overrides)]);
  const servers: McpServerSpec[] = [];

  for (const name of names) {
    if (name.startsWith('//')) continue;
    if (name === 'sdlc') {
      throw new Error(
        `проект «${p.name}»: имя MCP-сервера «sdlc» занято внутренним сервером раннера`,
      );
    }
    const over = overrides[name];
    const base = file.servers[name];
    const enabled = over?.enabled ?? (base === undefined ? true : unlistedOn);
    if (!enabled) continue;
    if (base === undefined && over?.command === undefined && over?.url === undefined) {
      throw new Error(
        `проект «${p.name}»: сервера «${name}» нет в файле проекта, а переопределение не ` +
          `описывает ни command, ни url`,
      );
    }
    servers.push(mergeServer(name, base, over, p.name, p.projectRoot, configDir));
  }

  const known = new Set(servers.map((s) => s.name));
  const rulesByStage = new Map<string, readonly McpToolRule[]>();

  for (const [stage, byServer] of Object.entries(cfg.stages ?? {})) {
    if (stage.startsWith('//')) continue;
    if (!STAGE_IDS.includes(stage)) {
      throw new Error(`проект «${p.name}»: в mcp.stages неизвестный этап «${stage}»`);
    }
    const rules: McpToolRule[] = [];
    for (const [server, tools] of Object.entries(byServer)) {
      if (server.startsWith('//')) continue;
      if (!known.has(server)) {
        throw new Error(
          `проект «${p.name}», этап ${stage}: сервер «${server}» не объявлен или выключен`,
        );
      }
      for (const allow of tools) rules.push(toRule(server, allow, p.name));
    }
    rulesByStage.set(stage, rules);
  }

  return {
    servers,
    rulesByStage,
    maxInlineTools: cfg.maxInlineTools ?? EMPTY_MCP.maxInlineTools,
    maxResultBytes: cfg.maxResultBytes ?? EMPTY_MCP.maxResultBytes,
    fileProblem: file.problem,
  };
}

/** Правила на этап. Этап не описан — MCP на нём не выдан. */
export function rulesForStage(setup: McpSetup, stage: StageId): readonly McpToolRule[] {
  return setup.rulesByStage.get(stage) ?? [];
}
