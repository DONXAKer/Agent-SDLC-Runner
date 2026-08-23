/**
 * Исполнение команд внутри контейнера, собранного из `.sdlc/sandbox.json` проекта.
 *
 * Контейнер один и живёт долго — по одному на проект, не на команду. Пересоздание
 * контейнера под каждый вызов означало бы разогревать `~/.m2`/`~/.npm` заново на каждой
 * команде гейта; долгоживущий том с зависимостями теряет смысл, если сам контейнер
 * одноразовый.
 *
 * `docker exec` вместо `docker run` на каждый вызов — то же самое соображение и плюс
 * скорость: `docker run` тянет за собой создание слоя контейнера и его удаление, `docker
 * exec` — нет.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDockerfile, imageTag } from './dockerfile.ts';
import type {
  SandboxExec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxProbeResult,
  SandboxSpec,
} from './types.ts';

const MAX_CAPTURE = 200_000;

function cap(chunks: string[]): string {
  const joined = chunks.join('');
  return joined.length <= MAX_CAPTURE
    ? joined
    : `${joined.slice(0, MAX_CAPTURE / 2)}\n…[обрезано рантаймом]…\n${joined.slice(-MAX_CAPTURE / 2)}`;
}

/** Обёртка над `spawn` для управляющих команд docker (build/run/inspect) — не для команд
 * ПРОЕКТА: у тех свой путь с таймаутом-внутри-контейнера, см. `DockerSandbox.exec`. */
function runDockerCli(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { windowsHide: true });
    const out: string[] = [];
    const err: string[] = [];
    let settled = false;
    const timer =
      opts.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            child.kill('SIGKILL');
          }, opts.timeoutMs);

    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: null, stdout: cap(out), stderr: `команда docker не запустилась: ${e.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout: cap(out), stderr: cap(err) });
    });

    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/**
 * Путь монтирования, реальный для демона Docker, а не для этого процесса.
 *
 * Когда Runner сам работает в контейнере и говорит с хостовым демоном через сокет
 * (docker-outside-of-docker), `-v <projectRoot>:...`, отправленный демону, ищет
 * `<projectRoot>` НА ХОСТЕ — демон ничего не знает о точках монтирования внутри Runner'а.
 * Без перевода демон молча создаёт пустой каталог на месте несуществующего пути: песочница
 * поднимается, выглядит рабочей, а `cd backend` внутри неё падает — баг застаётся не при
 * сборке образа, а на первой настоящей команде.
 *
 * `SDLC_HOST_PROJECTS_DIR` — хостовый путь, отвечающий `/projects` внутри Runner'а
 * (`docker-compose.yml`, тот же `.env`, что монтирует сам том). Не задано — трансляция не
 * нужна: процесс уже говорит с демоном на его языке путей (локальный запуск на хосте, как
 * при разработке и в этом тестовом наборе).
 */
export function hostMountSource(projectRoot: string): string {
  const hostRoot = process.env.SDLC_HOST_PROJECTS_DIR;
  const containerRoot = '/projects';
  if (hostRoot === undefined || hostRoot === '') return projectRoot;
  if (projectRoot !== containerRoot && !projectRoot.startsWith(containerRoot + '/')) return projectRoot;
  return hostRoot + projectRoot.slice(containerRoot.length);
}

function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

function containerName(projectName: string, hash: string): string {
  return `sdlc-sandbox-${safeName(projectName)}-${hash}`;
}

/** `~/.m2` → `/root/.m2` — базовые образы без своего `USER` работают под root'ом, `HOME`
 * которого `/root`; путь без `~` возвращается как есть (уже абсолютный). */
function expandHome(p: string): string {
  return p.startsWith('~/') ? `/root/${p.slice(2)}` : p === '~' ? '/root' : p;
}

/** Именованный том — на ПРОЕКТ, а не на хэш спеки: прогрев не должен повторяться из-за
 * правки версии тулчейна, которая на состав кэша обычно не влияет. */
function cacheVolumeName(projectName: string, cachePath: string): string {
  return `sdlc-sandbox-cache-${safeName(projectName)}-${safeName(expandHome(cachePath))}`;
}

async function containerRunning(name: string): Promise<boolean> {
  const r = await runDockerCli(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

async function imageExists(tag: string): Promise<boolean> {
  const r = await runDockerCli(['image', 'inspect', tag], { timeoutMs: 10_000 });
  return r.exitCode === 0;
}

async function buildImage(tag: string, dockerfile: string, projectRoot: string): Promise<void> {
  // Контекст сборки не нужен — все слои тянутся из готовых образов через `COPY --from`,
  // проект в образ не копируется (он монтируется томом при старте контейнера). Пустой
  // контекст держит сборку быстрой и не тащит `node_modules`/`target` в слои образа.
  const tmp = mkdtempSync(join(tmpdir(), 'sdlc-sandbox-'));
  try {
    const r = await runDockerCli(['build', '-t', tag, '-f', '-', tmp], {
      input: dockerfile,
      timeoutMs: 10 * 60_000,
    });
    if (r.exitCode !== 0) {
      throw new Error(`сборка образа песочницы упала (${projectRoot}):\n${r.stderr || r.stdout}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Одна команда прогрева/обслуживания через `docker exec` — не метод `DockerSandbox`
 * (тот ещё не существует на этой стадии подготовки: класс собирается ПОСЛЕ, из готового
 * имени контейнера), тот же паттерн передачи команды через stdin, что и у него. */
function execInContainer(
  name: string,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return runDockerCli(['exec', '-i', '-w', cwd, name, 'sh'], { input: command + '\n', timeoutMs });
}

async function ensureContainer(
  name: string,
  tag: string,
  projectRoot: string,
  projectName: string,
  spec: SandboxSpec,
): Promise<void> {
  if (await containerRunning(name)) return;

  // Контейнер мог остаться от прошлого запуска Runner'а в остановленном состоянии — не
  // плодим тёзок.
  await runDockerCli(['rm', '-f', name], { timeoutMs: 10_000 });

  const args = [
    'run',
    '-d',
    '--name',
    name,
    // ЦЕЛЬ монтирования — тот же путь, что видят гейты и модель («cd backend && ./mvnw
    // ...» пишется под этот путь, переписывать его под другой `cwd` было бы отдельным
    // классом рассинхрона). ИСТОЧНИК — путь, реальный для демона: см. `hostMountSource`.
    '-v',
    `${hostMountSource(projectRoot)}:${projectRoot}`,
    '-w',
    projectRoot,
  ];
  if (spec.docker === 'socket') {
    args.push('-v', '/var/run/docker.sock:/var/run/docker.sock');
  }
  for (const cachePath of spec.caches ?? []) {
    args.push('-v', `${cacheVolumeName(projectName, cachePath)}:${expandHome(cachePath)}`);
  }
  args.push(tag);

  const r = await runDockerCli(args, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    throw new Error(`не удалось поднять контейнер песочницы (${name}):\n${r.stderr || r.stdout}`);
  }

  // Прогрев — ТОЛЬКО на свежесозданном контейнере: `containerRunning` выше вернул бы
  // раньше на уже поднятом, повторный прогрев на каждый вызов был бы той же работой,
  // которую кэш-тома и существуют, чтобы не делать дважды.
  for (const cmd of spec.warmup ?? []) {
    const wr = await execInContainer(name, cmd, projectRoot, 10 * 60_000);
    if (wr.exitCode !== 0) {
      // Прогрев не блокирует появление песочницы — без прогретого кэша гейты просто
      // увидят обычную холодную установку зависимостей при первом реальном прогоне,
      // ту же деградацию, что была бы вовсе без `warmup`.
      console.error(
        `[sandbox] прогрев «${cmd}» в ${name} упал (код ${wr.exitCode}):\n${(wr.stderr || wr.stdout).slice(0, 2000)}`,
      );
    }
  }

  if (spec.network === 'none') {
    // Лучшее усилие: контейнер создан командой выше без `--network`, значит сеть у него —
    // дефолтный мост `bridge`. Кастомная сеть здесь не заводится, поэтому имя фиксировано;
    // неудача отключения (сеть уже не та, docker network plugin и т.п.) не должна ронять
    // подготовку песочницы целиком — это защита в глубину, а не единственная граница.
    await runDockerCli(['network', 'disconnect', 'bridge', name], { timeoutMs: 10_000 });
  }
}

export class DockerSandbox implements SandboxExec {
  readonly kind = 'docker' as const;
  private readonly containerName: string;

  constructor(containerName: string) {
    this.containerName = containerName;
  }

  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const started = Date.now();
    const secs = Math.max(1, Math.ceil(opts.timeoutMs / 1000));

    return new Promise<SandboxExecResult>((resolve) => {
      // `timeout` внутри контейнера, а не таймер снаружи: попытка убить `docker exec` с
      // хоста прибивает клиентский CLI-процесс, но НЕ сигналит процессу внутри контейнера
      // без `-t`/sig-proxy. GNU coreutils `timeout` есть в debian:12-slim из коробки и сам
      // шлёт SIGKILL нужному дереву — снаружи убивать нечего.
      const args = [
        'exec',
        '-i',
        '-w',
        opts.cwd,
        this.containerName,
        'timeout',
        '-k',
        '2',
        `${secs}s`,
        'sh',
      ];
      const child = spawn('docker', args, { windowsHide: true });

      const out: string[] = [];
      const err: string[] = [];
      let timedOut = false;
      let settled = false;

      // Отмена этапа — best-effort SIGKILL всему, что живёт в контейнере. Песочница
      // выделена под гейты и Bash-вызовы одного витка, не под фоновые сервисы: снести всё
      // её дерево процессов по отмене — то же намерение, что `killTree` у локального
      // исполнителя, перенесённое через границу контейнера.
      const onAbort = (): void => {
        void runDockerCli(['exec', this.containerName, 'sh', '-c', 'kill -KILL -1 2>/dev/null || true'], {
          timeoutMs: 5_000,
        });
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));

      const finish = (exitCode: number | null, extraErr?: string): void => {
        if (settled) return;
        settled = true;
        opts.signal?.removeEventListener('abort', onAbort);
        if (extraErr !== undefined) err.push(extraErr);
        // `timeout` возвращает 124 на истечении срока — переводим в тот же семантический
        // `timedOut: true`, что и у локального исполнителя, а не в «упало с кодом 124».
        if (exitCode === 124) timedOut = true;
        resolve({
          exitCode: timedOut ? null : exitCode,
          stdout: cap(out),
          stderr: cap(err),
          durationMs: Date.now() - started,
          timedOut,
        });
      };

      child.on('error', (e) =>
        finish(null, `\n[песочница] docker exec не запустился: ${e.message}`),
      );
      child.on('close', (code) => finish(code));

      child.stdin.write(command + '\n');
      child.stdin.end();
    });
  }
}

export async function createDockerSandbox(
  projectRoot: string,
  projectName: string,
  spec: SandboxSpec,
): Promise<SandboxHandle> {
  const tag = imageTag(projectName, spec);
  const hash = tag.split('-').pop() as string;
  const name = containerName(projectName, hash);

  if (!(await imageExists(tag))) {
    await buildImage(tag, buildDockerfile(spec), projectRoot);
  }
  await ensureContainer(name, tag, projectRoot, projectName, spec);

  const exec = new DockerSandbox(name);

  return {
    exec,
    specHash: hash,
    async runProbes(): Promise<SandboxProbeResult[]> {
      const results: SandboxProbeResult[] = [];
      for (const probe of spec.probes ?? []) {
        const r = await exec.exec(probe.cmd, { cwd: projectRoot, timeoutMs: 15_000 });
        const output = `${r.stdout}\n${r.stderr}`;
        const ok = r.exitCode === 0 && new RegExp(probe.expect).test(output);
        results.push({ cmd: probe.cmd, ok, output: output.trim() });
      }
      return results;
    },
  };
}

/** Останавливает и удаляет контейнер проекта. Образ остаётся в кэше docker — пересборка
 * не нужна, пока не изменится спека. */
export async function stopDockerSandbox(projectName: string, specHash: string): Promise<void> {
  await runDockerCli(['rm', '-f', containerName(projectName, specHash)], { timeoutMs: 15_000 });
}
