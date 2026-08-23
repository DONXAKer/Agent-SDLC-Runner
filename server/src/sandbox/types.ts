/**
 * Общие типы песочницы.
 *
 * Исполнитель команды («где спавнится процесс») отделён от политики («можно ли эту команду
 * вообще запускать») — вторая не переезжает: `checkBash` остаётся в `gates/shell.ts` и
 * работает одинаково для `LocalSandbox` и `DockerSandbox`. Песочница отвечает только на
 * вопрос «в каком окружении», не «разрешено ли».
 */

export interface SandboxExecOptions {
  /** Абсолютный путь на хосте — тот же, что видит и `LocalSandbox`, и смонтированный проект. */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Единая точка запуска команды — локально или внутри контейнера проекта.
 *
 * `exec` получает УЖЕ проверенную политикой команду: `SandboxExec` не знает про
 * `DenyList`/`PlanScope` и не обязан о них знать.
 */
export interface SandboxExec {
  readonly kind: 'local' | 'docker';
  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult>;
}

export interface ProbeSpec {
  cmd: string;
  /** Регэксп, которому обязан соответствовать stdout+stderr пробы. */
  expect: string;
}

export interface ToolchainSpec {
  version: string;
  dist?: string;
}

/**
 * `.sdlc/sandbox.json` — декларация среды проекта, соседняя с `gates.md`.
 *
 * Формат JSON, а не YAML: в рантайме нет YAML-парсера и заводить его ради одного файла —
 * лишняя зависимость и лишний класс ошибок разбора. `config/projects/*.json` рядом уже
 * задают прецедент: конфиг проекта — JSON, объяснение вокруг него — соседний `.md`.
 */
export interface SandboxSpec {
  /** Базовый образ для генерируемого Dockerfile. */
  base: string;
  toolchains: {
    jdk?: ToolchainSpec;
    node?: ToolchainSpec;
  };
  /** `socket` монтирует `/var/run/docker.sock` — нужно для Testcontainers. */
  docker?: 'none' | 'socket';
  apt?: string[];
  env?: Record<string, string>;
  probes?: ProbeSpec[];
}

export interface SandboxProbeResult {
  cmd: string;
  ok: boolean;
  output: string;
}

/** Ручка на подготовленную (собранную и живую) песочницу проекта. */
export interface SandboxHandle {
  readonly exec: SandboxExec;
  /** Хэш спеки, по которому собран образ — для журнала и вкладки «Среда» в UI. */
  readonly specHash: string;
  runProbes(): Promise<SandboxProbeResult[]>;
}
