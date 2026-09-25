/**
 * Константы методологии — из `sdlc-constants.json` эталона (`CLAUDE.md` методологии:
 * «единственный источник констант; инструменты читают файл, не хардкод»).
 *
 * Источник, по убыванию приоритета: `SDLC_CONSTANTS_PATH`; `SDLC_METHODOLOGY_DIR`;
 * `methodologyDir` из `config/runner.local.json`/`runner.json`; установочная копия рядом
 * (`sdlc-constants.json` в этом каталоге — снята с эталона, сверяется тестом
 * `constants.test.ts`). Ни одного источника нет — исключение при загрузке модуля: раннер
 * без констант методологии не стартует, а не работает на угаданных списках.
 *
 * Списки, которые рантайм держит типизированными кортежами (`MINIMUM`, `AXES`, `ACTIONS`,
 * метки решений), сверяются с файлом при загрузке своих модулей (`assertSameList`):
 * расхождение — ошибка старта, а не молчаливый дрейф двух копий.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface SdlcConstants {
  version: number;
  placeholder: string;
  not_applicable: string;
  claim_id_pattern: string;
  artifacts_dir: string;
  attempt_default_budget: number;
  chunk_size_guideline: { changed_lines: number; files: number };
  mandatory_gates: string[];
  gates: { name: string; stage: string; switchable: boolean }[];
  axes: string[];
  axis_outcomes: string[];
  gate_statuses: string[];
  claim_statuses: string[];
  actions: string[];
  human_decision_labels: string[];
  defect_actions: string[];
  verdict_table: [string, string][];
  overwrite_threshold_percent: number;
  model_order: string[];
  defect_classes: string[];
}

const REQUIRED: (keyof SdlcConstants)[] = [
  'mandatory_gates',
  'gates',
  'axes',
  'actions',
  'human_decision_labels',
  'attempt_default_budget',
  'overwrite_threshold_percent',
  'model_order',
  'defect_classes',
];

/** Тот же разворот, что у `config/load.ts::expandUserPath`: ведущая `~` и `${VAR}`. */
function expandHome(p: string): string {
  const vars = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
  return vars === '~' || vars.startsWith('~/') || vars.startsWith('~\\') ? join(homedir(), vars.slice(1)) : vars;
}

function methodologyDirFromConfig(): string | null {
  const fromEnv = process.env['SDLC_CONFIG_DIR'];
  const configDir = fromEnv !== undefined && fromEnv !== '' ? resolve(fromEnv) : resolve(import.meta.dirname, '..', '..', '..', 'config');
  for (const name of ['runner.local.json', 'runner.json']) {
    const p = join(configDir, name);
    if (!existsSync(p)) continue;
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as { methodologyDir?: unknown };
      if (typeof parsed.methodologyDir === 'string' && parsed.methodologyDir !== '') return expandHome(parsed.methodologyDir);
    } catch {
      /* битый конфиг назовёт loadConfig */
    }
  }
  return null;
}

/** Кандидаты в порядке приоритета; первый существующий — источник. */
export function constantsCandidates(): string[] {
  const out: string[] = [];
  const explicit = process.env['SDLC_CONSTANTS_PATH'];
  if (explicit !== undefined && explicit !== '') out.push(isAbsolute(explicit) ? explicit : resolve(explicit));
  const envDir = process.env['SDLC_METHODOLOGY_DIR'];
  if (envDir !== undefined && envDir !== '') out.push(join(expandHome(envDir), 'sdlc-constants.json'));
  const cfgDir = methodologyDirFromConfig();
  if (cfgDir !== null) out.push(join(cfgDir, 'sdlc-constants.json'));
  out.push(join(import.meta.dirname, 'sdlc-constants.json'));
  return out;
}

function load(): { constants: SdlcConstants; source: string } {
  for (const path of constantsCandidates()) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SdlcConstants>;
    const missing = REQUIRED.filter((k) => parsed[k] === undefined);
    if (missing.length > 0) throw new Error(`${path}: в константах методологии нет ключей ${missing.join(', ')}`);
    return { constants: parsed as SdlcConstants, source: path };
  }
  throw new Error(
    'константы методологии (sdlc-constants.json) не найдены: задай SDLC_METHODOLOGY_DIR или methodologyDir в config/runner.local.json',
  );
}

const loaded = load();
export const SDLC_CONSTANTS: SdlcConstants = loaded.constants;
export const SDLC_CONSTANTS_SOURCE: string = loaded.source;

/** Списки равны по порядку и содержимому; иначе — ошибка старта с обеими копиями в тексте. */
export function assertSameList(what: string, ours: readonly string[], theirs: readonly string[]): void {
  const same = ours.length === theirs.length && ours.every((v, i) => v === theirs[i]);
  if (!same) {
    throw new Error(
      `${what}: список рантайма ${JSON.stringify(ours)} разошёлся с sdlc-constants.json ` +
        `(${SDLC_CONSTANTS_SOURCE}) ${JSON.stringify(theirs)} — правится файл методологии, затем рантайм`,
    );
  }
}
