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

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDockerfile, imageTag, projectSlug } from './dockerfile.ts';
import { cap } from './capture.ts';
import type {
  SandboxExec,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxProbeResult,
  SandboxSpec,
} from './types.ts';

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

/** `projectSlug`, не голый `safeName` — см. doc-комментарий `projectSlug` в `dockerfile.ts`
 * про реальную коллизию, которую голый `safeName` допускал между разными проектами. */
function containerName(projectName: string, hash: string): string {
  return `sdlc-sandbox-${projectSlug(projectName)}-${hash}`;
}

/** `~/.m2` → `/root/.m2` — базовые образы без своего `USER` работают под root'ом, `HOME`
 * которого `/root`; путь без `~` возвращается как есть (уже абсолютный). */
function expandHome(p: string): string {
  return p.startsWith('~/') ? `/root/${p.slice(2)}` : p === '~' ? '/root' : p;
}

/** Именованный том — на ПРОЕКТ, а не на хэш спеки: прогрев не должен повторяться из-за
 * правки версии тулчейна, которая на состав кэша обычно не влияет. */
function cacheVolumeName(projectName: string, cachePath: string): string {
  return `sdlc-sandbox-cache-${projectSlug(projectName)}-${expandHome(cachePath).toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`;
}

async function containerRunning(name: string): Promise<boolean> {
  const r = await runDockerCli(['inspect', '-f', '{{.State.Running}}', name], { timeoutMs: 10_000 });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/**
 * Санитайзер, которым имена Docker-ресурсов считались ДО введения `projectSlug`
 * (`dockerfile.ts`) — дословная копия старого `safeName`, живёт здесь ТОЛЬКО ради
 * одноразовой миграции кэш-томов/контейнеров на новую схему имён, см. `migrateLegacy*`
 * ниже. Не экспортируется и не используется больше нигде: сам факт того, что `projectSlug`
 * пришлось завести (реальная коллизия `"Foo Bar"`/`"foo-bar"` — см. её doc-комментарий),
 * означает, что голый `safeName` небезопасен для НОВЫХ имён ресурсов — миграция читает
 * старое имя, чтобы перенести данные, а не производит новые имена этой функцией.
 */
function legacySafeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

/** Экспортирована только для теста формулы дословным совпадением со старым кодом
 * (`git show 776a9bf~1:server/src/sandbox/dockerSandbox.ts`) — не для использования вне
 * миграции, см. doc-комментарий `legacySafeName`. */
export function legacyContainerName(projectName: string, hash: string): string {
  return `sdlc-sandbox-${legacySafeName(projectName)}-${hash}`;
}

export function legacyCacheVolumeName(projectName: string, cachePath: string): string {
  return `sdlc-sandbox-cache-${legacySafeName(projectName)}-${legacySafeName(expandHome(cachePath))}`;
}

async function volumeExists(name: string): Promise<boolean> {
  const r = await runDockerCli(['volume', 'inspect', name], { timeoutMs: 10_000 });
  return r.exitCode === 0;
}

/**
 * Одноразовая миграция данных кэш-тома со старого имени (голый `safeName`, до
 * `projectSlug`) на новое. Docker не умеет переименовывать тома — только копирование через
 * промежуточный контейнер. Лучшее усилие: неудача не должна ронять подготовку песочницы,
 * контейнер просто прогреется заново в пустой новый том — та же деградация, что была бы
 * без миграции вовсе, не хуже.
 *
 * Найдено и подтверждено на живой машине: переход `containerName`/`cacheVolumeName` на
 * `projectSlug` в этом же коммите меняет итоговое имя для КАЖДОГО проекта, не только для
 * коллизировавших — без миграции уже прогретый `~/.m2`/`~/.npm` осиротевал бы молча при
 * первом же запуске после обновления.
 */
export async function migrateLegacyCacheVolume(newName: string, legacyName: string): Promise<void> {
  if (newName === legacyName) return;
  if (await volumeExists(newName)) return; // уже мигрировано или заведено заново — не трогаем
  if (!(await volumeExists(legacyName))) return; // старого тома нет — переносить нечего

  const created = await runDockerCli(['volume', 'create', newName], { timeoutMs: 10_000 });
  if (created.exitCode !== 0) {
    console.error(`[sandbox] не удалось завести том ${newName} для миграции кэша: ${created.stderr || created.stdout}`);
    return;
  }
  // Старый том — только на чтение: миграция копирует, не перемещает, старый остаётся
  // нетронутым (удаление — на усмотрение оператора, `docker volume rm` вручную).
  const copy = await runDockerCli(
    [
      'run',
      '--rm',
      '-v',
      `${legacyName}:/from:ro`,
      '-v',
      `${newName}:/to`,
      'busybox:stable',
      'sh',
      '-c',
      'cp -a /from/. /to/',
    ],
    { timeoutMs: 5 * 60_000 },
  );
  if (copy.exitCode !== 0) {
    console.error(
      `[sandbox] перенос кэша ${legacyName} → ${newName} не удался (код ${copy.exitCode}): ${(copy.stderr || copy.stdout).slice(0, 2000)}`,
    );
  }
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
  // Тот же класс отказа, что уже пойман и закрыт в `DockerSandbox.exec` (см. комментарий
  // там): `runDockerCli`'s `timeoutMs` убивает только хостовый `docker exec`-клиент, а не
  // процесс ВНУТРИ контейнера — команда прогрева, зависшая на сети, продолжала бы жить
  // внутри контейнера после того, как хост решил, что она отменена. `timeout -k` внутри —
  // та же обёртка, что и у основного пути; хостовый `timeoutMs` даётся с запасом ПОВЕРХ
  // него — она подстраховка на случай, если сам демон docker не отвечает вообще, а не
  // основной механизм ограничения.
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  return runDockerCli(['exec', '-i', '-w', cwd, name, 'timeout', '-k', '2', `${secs}s`, 'sh'], {
    input: command + '\n',
    timeoutMs: timeoutMs + 30_000,
  });
}

async function ensureContainer(
  name: string,
  tag: string,
  projectRoot: string,
  projectName: string,
  spec: SandboxSpec,
  hash: string,
  onWarn?: (message: string) => void,
): Promise<void> {
  if (await containerRunning(name)) return;

  // Контейнер мог остаться от прошлого запуска Runner'а в остановленном состоянии — не
  // плодим тёзок.
  await runDockerCli(['rm', '-f', name], { timeoutMs: 10_000 });

  // Осиротевший контейнер под ИМЕНЕМ ДО перехода на `projectSlug` — данных в нём нет (сам
  // проект смонтирован bind-mount'ом, кэш живёт в volume'ах, которые мигрируются ниже
  // отдельно), поэтому для контейнера миграция — просто уборка, не перенос: оставлять его
  // висеть остановленным смысла нет.
  const legacyName = legacyContainerName(projectName, hash);
  if (legacyName !== name) {
    await runDockerCli(['rm', '-f', legacyName], { timeoutMs: 10_000 });
  }

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
  const cachePaths = spec.caches ?? [];
  // Параллельно, не по одному: миграции РАЗНЫХ путей кэша (например `~/.m2` и `~/.npm`)
  // независимы, а каждая — до нескольких `docker`-подпроцессов с таймаутом в минуты
  // (`migrateLegacyCacheVolume`). Последовательный await суммировал бы худший случай по
  // всем кэшам разом; здесь важно лишь то, что ВСЕ миграции завершатся ДО `docker run`
  // ниже (иначе он неявно заведёт пустой том раньше, чем миграция успеет его создать).
  await Promise.all(
    cachePaths.map((cachePath) =>
      migrateLegacyCacheVolume(
        cacheVolumeName(projectName, cachePath),
        legacyCacheVolumeName(projectName, cachePath),
      ),
    ),
  );
  for (const cachePath of cachePaths) {
    const volumeName = cacheVolumeName(projectName, cachePath);
    args.push('-v', `${volumeName}:${expandHome(cachePath)}`);
  }
  args.push(tag);

  const r = await runDockerCli(args, { timeoutMs: 30_000 });
  if (r.exitCode !== 0) {
    throw new Error(`не удалось поднять контейнер песочницы (${name}):\n${r.stderr || r.stdout}`);
  }

  // Прогрев — ТОЛЬКО на свежесозданном контейнере: `containerRunning` выше вернул бы
  // раньше на уже поднятом, повторный прогрев на каждый вызов был бы той же работой,
  // которую кэш-тома и существуют, чтобы не делать дважды.
  //
  // ОСОЗНАННЫЙ порядок: прогрев идёт ДО отключения сети ниже, даже если `spec.network ===
  // 'none'`. Иначе и быть не может — `mvn dependency:go-offline`/`npm ci` сами требуют
  // сети, и `network: none` относится к тому, что «изоляция сети покрывает гейты и команды
  // ПОСЛЕ прогрева», а не «прогрев тоже без сети» (последнее сделало бы прогрев тем же
  // недостижимым состоянием, ради обхода которого спека вообще заводится). Оператор,
  // указавший `network: none`, должен читать это именно так — при желании полной изоляции
  // прогрева `spec.warmup` в конфиге проекта просто не заполняется.
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
    // Контейнер создан командой выше без `--network`, значит сеть у него — дефолтный мост
    // `bridge`; кастомная сеть здесь не заводится, поэтому имя фиксировано. Это ЕДИНСТВЕННЫЙ
    // механизм, обеспечивающий `network: 'none'` — нигде в этом файле `docker run` не
    // получает `--network=none`. Неудача отключения (сеть уже не та, docker network plugin
    // и т.п.) не должна ронять подготовку песочницы целиком (оператор получил бы нерабочую
    // среду вместо просто менее изолированной), но обязана быть ГРОМКОЙ — иначе оператор,
    // объявивший `network: 'none'` ради изоляции гейтов от сети, не получает никакого
    // сигнала о том, что контейнер эту сеть на самом деле сохранил.
    const r = await runDockerCli(['network', 'disconnect', 'bridge', name], { timeoutMs: 10_000 });
    if (r.exitCode !== 0) {
      const message =
        `не удалось отключить сеть у ${name} (код ${r.exitCode}) — network: 'none' НЕ обеспечен, ` +
        `контейнер сохраняет доступ к сети: ${(r.stderr || r.stdout).slice(0, 500)}`;
      console.error(`[sandbox] ${message}`);
      // `console.error` одного мало: оператор следит за веб-интерфейсом, не за stderr
      // сервера, а `ensureContainer` вызывается из `runGates` до самого первого гейта —
      // без этого коллбэка обещание «обязана быть ГРОМКОЙ» из комментария выше не
      // выполнялось, сигнал терялся в логе, который никто не читает.
      onWarn?.(message);
    }
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
    // Маркер — путь ВНУТРИ контейнера, не на хосте: один долгоживущий контейнер обслуживает
    // много последовательных вызовов, и `randomUUID()` не даёт двум одновременным вызовам
    // (гейт + parallel-пробы) перезаписать чужой маркер.
    const marker = `/tmp/.sdlc-exec-${randomUUID()}.pid`;

    return new Promise<SandboxExecResult>((resolve) => {
      // `timeout` внутри контейнера, а не таймер снаружи: попытка убить `docker exec` с
      // хоста прибивает клиентский CLI-процесс, но НЕ сигналит процессу внутри контейнера
      // без `-t`/sig-proxy. GNU coreutils `timeout` есть в debian:12-slim из коробки и сам
      // заводит команде отдельную группу процессов и шлёт SIGKILL ЕЙ ЦЕЛИКОМ на истечении
      // срока. Тот же PGID читается ниже для ручной отмены (`onAbort`) — но НЕ через `$$`
      // (см. комментарий там про то, почему это не одно и то же).
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

      // Страховка на случай, если сам демон docker завис ДО того, как команда внутри
      // контейнера вообще стартовала (in-container `timeout` тогда ещё не запущен и
      // ничего не ограничивает) — без этого таймера `runShell`/гейт ждал бы такую команду
      // вечно, несмотря на переданный `opts.timeoutMs`. Запас поверх in-container таймаута
      // — она подстраховка, не основной механизм: обычный сценарий завершается раньше него.
      const hostTimer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs + 30_000);

      // Отмена этапа — SIGKILL ГРУППЕ ПРОЦЕССОВ этого конкретного вызова, а не всему
      // контейнеру. Раньше здесь стоял `kill -KILL -1` (сигнал ВСЕМ процессам в PID-
      // неймспейсе контейнера кроме PID 1) — экспериментально подтверждено, что это убивает
      // весь долгоживущий контейнер целиком (init-процесс `tini` умирает вслед за убитым
      // ребёнком `sleep infinity`), а не только отменяемую команду: следующий гейт того же
      // прогона попадал на контейнер, которого больше нет.
      //
      // PGID, записанный в маркер ниже, читается из `/proc/self/stat` (поле 5), а НЕ через
      // `$$` — это тоже проверено исполнением, не догадкой: `timeout` заводит для команды
      // новую группу процессов, но ЛИДЕРОМ этой группы становится сам `timeout` (его
      // собственный PID), а порождённый им `sh` лишь НАСЛЕДУЕТ эту группу — `$$` внутри `sh`
      // даёт PID самого `sh`, который НЕ равен PGID группы. `kill -KILL -$$` в такой схеме
      // не находит процесс с этим PID как группу («No such process») и не убивает вообще
      // ничего — воспроизведено вручную на `debian:12-slim` через `/proc`-дамп процессов.
      // Гонка, воспроизведённая исполнением: если `abort` приходит раньше, чем `docker exec`
      // внутри контейнера успел выполнить самую первую строку stdin (`awk ... > marker`),
      // `cat` маркера отдаёт пустоту, `kill -KILL -""` не находит процесс и тихо ничего не
      // убивает — команда доживает до штатного `timeout`, а не до отмены. Окно — обычно
      // десятки-сотни мс (время до старта `sh` внутри контейнера), поэтому вместо одного
      // мгновенного чтения — короткий опрос маркера (до 1 с суммарно, шагами по 50 мс) внутри
      // ОДНОГО вызова `docker exec`, а не повторные round-trip'ы с хоста.
      const onAbort = (): void => {
        void runDockerCli(
          [
            'exec',
            this.containerName,
            'sh',
            '-c',
            // `sleep 0.05 2>/dev/null` — на минимальном `sh`/busybox без поддержки дробных
            // секунд команда падает с ошибкой парсинга; без `set -e` это не рвёт цикл, а
            // просто убирает саму паузу (опрос идёт чаще, не медленнее) — `2>/dev/null`
            // только глушит шум в stderr результата, поведение не меняет.
            `i=0; pgid=''; while [ $i -lt 20 ]; do pgid=$(cat '${marker}' 2>/dev/null); ` +
              `[ -n "$pgid" ] && break; i=$((i+1)); sleep 0.05 2>/dev/null; done; ` +
              `[ -n "$pgid" ] && kill -KILL -"$pgid" 2>/dev/null; rm -f '${marker}'`,
          ],
          { timeoutMs: 5_000 },
        );
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
      child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));

      const finish = (exitCode: number | null, extraErr?: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hostTimer);
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

      // Поле 5 `/proc/self/stat` — `pgrp` (см. proc(5)) читается ДО запуска команды, чтобы
      // `onAbort` мог прочитать его в любой момент исполнения. НЕ `$$`: проверено вручную —
      // `timeout` заводит новую группу процессов, но её лидер — сам `timeout` (его
      // собственный PID), а порождённый им `sh` лишь наследует эту группу; `$$` внутри `sh`
      // даёт PID самого `sh`, который НЕ равен PGID группы, и `kill -KILL -$$` в такой схеме
      // не находит процесс с этим PID как группу («No such process») и не убивает вообще
      // ничего — воспроизведено на `debian:12-slim`: `/proc`-дамп показал `sh` с pgid,
      // равным PID `timeout`, а не своему собственному. `rm -f` в конце убирает маркер при
      // штатном завершении — при отмене он может остаться (гонка между `kill` и `rm`), это
      // безвредный осколок в `/tmp` долгоживущего контейнера, не накопление: следующий вызов
      // пишет свой маркер с новым именем и не читает чужие.
      child.stdin.write(`awk '{print $5}' /proc/self/stat > '${marker}'\n${command}\nrm -f '${marker}'\n`);
      child.stdin.end();
    });
  }
}

export async function createDockerSandbox(
  projectRoot: string,
  projectName: string,
  spec: SandboxSpec,
  onWarn?: (message: string) => void,
): Promise<SandboxHandle> {
  const tag = imageTag(projectName, spec);
  const hash = tag.split('-').pop() as string;
  const name = containerName(projectName, hash);

  if (!(await imageExists(tag))) {
    await buildImage(tag, buildDockerfile(spec), projectRoot);
  }
  await ensureContainer(name, tag, projectRoot, projectName, spec, hash, onWarn);

  const exec = new DockerSandbox(name);

  return {
    exec,
    specHash: hash,
    async runProbes(): Promise<SandboxProbeResult[]> {
      // Пробы независимы (`java -version`, `node -v`, `docker info` — только чтение) и не
      // делят состояние, поэтому гоняются параллельно: `docker exec` не сериализует вызовы
      // сам, и pre-flight не обязан ждать одну команду ради старта следующей.
      return Promise.all(
        (spec.probes ?? []).map(async (probe) => {
          const r = await exec.exec(probe.cmd, { cwd: projectRoot, timeoutMs: 15_000 });
          const output = `${r.stdout}\n${r.stderr}`;
          const ok = r.exitCode === 0 && new RegExp(probe.expect).test(output);
          return { cmd: probe.cmd, ok, output: output.trim() };
        }),
      );
    },
  };
}

/** Останавливает и удаляет контейнер проекта. Образ остаётся в кэше docker — пересборка
 * не нужна, пока не изменится спека. */
export async function stopDockerSandbox(projectName: string, specHash: string): Promise<void> {
  await runDockerCli(['rm', '-f', containerName(projectName, specHash)], { timeoutMs: 15_000 });
}
