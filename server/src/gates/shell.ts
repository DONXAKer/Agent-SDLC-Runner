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
 */

import { spawn } from 'node:child_process';

import { checkBash } from '../policy/denyList.ts';

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

  return new Promise<ShellResult>((resolve) => {
    // shell: true — команды в наборе пишутся для платформы оператора («./gradlew test»,
    // «npm test»), и подменять её собственным интерпретатором значило бы ломать половину
    // из них. Это осознанно: источник команды — файл человека, не модель.
    const child = spawn(command, { cwd: opts.cwd, shell: true, windowsHide: true });

    const out: string[] = [];
    const err: string[] = [];
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      child.kill();
    };
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
