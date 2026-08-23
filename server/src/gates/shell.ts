/**
 * Запуск команды гейта.
 *
 * Гейты — единственное место рантайма, где команда приходит из файла проекта, а не от
 * модели. Пол безопасности от этого не отключается: `.sdlc/gates.md` правит человек, но
 * правит его человек редко, а читается файл каждый виток — команда оттуда проходит
 * `DenyList` ровно так же, как команда агента.
 *
 * Вывод режется: гейт, уронивший сборку, печатает мегабайты, а вердикту нужна последняя
 * содержательная строка и хвост для диагноза.
 *
 * Исполнитель команды — `LocalSandbox` (спавн в процессе Runner'а, как всегда) или
 * `DockerSandbox` проекта, если для него подготовлена песочница (`sandbox/registry.ts`).
 * Выбор прозрачен для вызывающих: сигнатура и структура результата не меняются, а без
 * `.sdlc/sandbox.json` у проекта реестр пуст и путь ровно тот же, что был до песочницы.
 */

import { spawn } from 'node:child_process';

import { checkBash } from '../policy/denyList.ts';
import { findSandboxForCwd } from '../sandbox/registry.ts';

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Последняя непустая строка — то, что показывается в списке гейтов. */
  lastLine: string;
  durationMs: number;
  timedOut: boolean;
  /** Команда не запускалась: её отклонил пол безопасности. */
  denied: string | null;
}

const MAX_CAPTURE = 200_000;

export function lastMeaningfulLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (t !== '') return t;
  }
  return '';
}

function cap(chunks: string[]): string {
  const joined = chunks.join('');
  return joined.length <= MAX_CAPTURE
    ? joined
    : `${joined.slice(0, MAX_CAPTURE / 2)}\n…[обрезано рантаймом]…\n${joined.slice(-MAX_CAPTURE / 2)}`;
}

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export function runShell(command: string, opts: ShellOptions): Promise<ShellResult> {
  const started = Date.now();

  const guard = checkBash(command);
  if (!guard.ok) {
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      lastLine: `команда гейта отклонена полом безопасности: ${guard.reason}`,
      durationMs: 0,
      timedOut: false,
      denied: guard.reason,
    });
  }

  const sandbox = findSandboxForCwd(opts.cwd);
  if (sandbox !== null && sandbox.exec.kind === 'docker') {
    return sandbox.exec
      .exec(command, opts)
      .then((r) => ({
        exitCode: r.exitCode,
        stdout: r.stdout,
        stderr: r.stderr,
        lastLine: r.timedOut
          ? `команда не уложилась в ${opts.timeoutMs} мс`
          : lastMeaningfulLine(r.stdout) || lastMeaningfulLine(r.stderr),
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        denied: null,
      }));
  }

  return new Promise<ShellResult>((resolve) => {
    // shell: true — команды в наборе пишутся для платформы оператора («./gradlew test»,
    // «npm test»), и подменять её собственным интерпретатором значило бы ломать половину
    // из них. Это осознанно: источник команды — файл человека, не модель.
    // detached на POSIX заводит собственную группу процессов — иначе снять дерево одним
    // сигналом нельзя. На Windows группу заменяет `taskkill /T`.
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let settled = false;

    /**
     * Снимаем ДЕРЕВО процессов, а не только шелл.
     *
     * `shell: true` порождает `cmd.exe`/`sh`, а тест-раннер или сборщик живёт его
     * потомком. `child.kill()` убивал только обёртку: внуки продолжали держать
     * унаследованные stdout/stderr, событие `close` не приходило, и промис не резолвился
     * никогда — проверено, висел и через 15 секунд после таймаута. Прогон гейтов вставал
     * на этом месте бесконечно, и отмена не помогала, потому что делала тот же kill.
     */
    const killTree = (): void => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        // `taskkill /T` снимает всё поддерево по идентификатору родителя.
        // Слушатель `error` обязателен: у `ChildProcess` без него неудачный spawn
        // (taskkill не в PATH на урезанном образе, отказ в правах) поднимается
        // необработанным исключением на уровень процесса и роняет ВЕСЬ сервер — в
        // обработчике таймаута, то есть ровно тогда, когда всё уже идёт не так.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
        });
        killer.on('error', () => child.kill());
      } else {
        // Отрицательный pid — сигнал всей группе процессов.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      // Страховка: если дерево всё же удержало пайпы, завершаем ожидание сами.
      setTimeout(() => finish(null, '\n[рантайм] процесс снят принудительно'), 2_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);

    const onAbort = (): void => killTree();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    // Декодируем как UTF-8. Консоль Windows печатает в кодировке OEM, поэтому кириллица
    // в выводе команды приедет искажённой; угадывать кодировку по содержимому — хуже,
    // чем показать искажение: вывод сборщиков и тест-раннеров на латинице, а молчаливая
    // перекодировка ломала бы его.
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));

    const finish = (exitCode: number | null, extraErr?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (extraErr !== undefined) err.push(extraErr);
      const stdout = cap(out);
      const stderr = cap(err);
      resolve({
        exitCode,
        stdout,
        stderr,
        lastLine: lastMeaningfulLine(stdout) || lastMeaningfulLine(stderr),
        durationMs: Date.now() - started,
        timedOut,
        denied: null,
      });
    };

    // `error` без `close` бывает, когда исполняемого файла нет вовсе: без этой ветки
    // промис висел бы вечно и вместе с ним весь этап.
    child.on('error', (e) => finish(null, `\n[рантайм] команда не запустилась: ${e.message}`));
    child.on('close', (code) => finish(code));
  });
}
