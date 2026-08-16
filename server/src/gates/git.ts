/**
 * Обёртка над git для гейтов.
 *
 * Без шелла: аргументы уходят массивом, поэтому имя файла с пробелом, кавычкой или
 * кириллицей не разваливает команду. Гейт scope сравнивает пути дословно, и любая
 * потеря символа в имени превращается в ложное «файл вне плана».
 */

import { spawn } from 'node:child_process';

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function git(args: string[], cwd: string, signal?: AbortSignal): Promise<GitResult> {
  return new Promise((resolve) => {
    // core.quotePath=false — иначе не-ASCII имена приходят экранированными в кавычках
    // (`"\320\244..."`), и сверка с планом не находит ни одного файла.
    const child = spawn('git', ['-c', 'core.quotePath=false', ...args], {
      cwd,
      windowsHide: true,
      signal,
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => err.push(d.toString('utf8')));
    const done = (code: number | null, extra?: string): void =>
      resolve({ code, stdout: out.join(''), stderr: err.join('') + (extra ?? '') });
    child.on('error', (e) => done(null, e.message));
    child.on('close', (code) => done(code));
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return r.code === 0 && r.stdout.trim() === 'true';
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const r = await git(['rev-parse', '--verify', 'HEAD'], cwd);
  return r.code === 0;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * Изменённые пути: отслеживаемые правки плюс неотслеживаемые файлы.
 *
 * `git diff --ignore-cr-at-eol`, а не `git status`: на репозитории с CRLF в рабочей
 * копии и LF в индексе git считает изменённой каждую строку каждого файла — в
 * AI-Workflow это дало 71 файл и 13706 правок при нулевых реальных изменениях, и
 * scope-гейт был вечно красным. У `git status` флага игнорирования CR нет, поэтому
 * команды две.
 */
export async function changedPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const base = (await hasCommits(cwd)) ? ['diff', '--ignore-cr-at-eol', '--name-only', 'HEAD'] : [];
  const tracked = base.length > 0 ? await git(base, cwd, signal) : { code: 0, stdout: '', stderr: '' };
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], cwd, signal);
  return [...new Set([...lines(tracked.stdout), ...lines(untracked.stdout)])].sort();
}

/** Текст diff'а рабочего дерева — вход анти-обходного гейта и гейта секретов. */
export async function workingDiff(
  cwd: string,
  args: string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  const head = (await hasCommits(cwd)) ? ['HEAD'] : [];
  const r = await git(['diff', '--ignore-cr-at-eol', '-U0', ...head, ...args], cwd, signal);
  return r.stdout;
}

export async function deletedPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (!(await hasCommits(cwd))) return [];
  const r = await git(['diff', '--diff-filter=D', '--name-only', 'HEAD'], cwd, signal);
  return lines(r.stdout);
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.stdout.trim();
}
