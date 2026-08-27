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
  /**
   * Команды прогрева, разово на КАЖДОЕ создание контейнера (не на каждый вызов) — типично
   * `./mvnw -q dependency:go-offline`, `npm ci`. Идут с сетью, до того, как её отбирают
   * (см. `network`); результат оседает в `caches`, доступных следующим `docker exec`.
   */
  warmup?: string[];
  /**
   * Именованные volume-кэши зависимостей (`~/.m2`, `~/.npm`) — переживают пересоздание
   * контейнера при неизменной спеке, поэтому прогрев не повторяется на каждый виток.
   */
  caches?: string[];
  /**
   * `none` — после прогрева сеть у контейнера отбирается (`docker network disconnect`):
   * гейты и Bash-вызовы модели физически не могут скачать зависимость в обход
   * `dependency:go-offline`/`npm ci`, зафиксированных прогревом — усиление гейта
   * «Анти-обход тест-гейта» на уровне сети, а не только на уровне diff'а. Доступ к
   * `docker.sock` (Testcontainers) не сеть, а смонтированный файл — им это не задевает.
   * Не задано — сеть остаётся как у только что созданного контейнера (мостовая).
   */
  network?: 'none';
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
