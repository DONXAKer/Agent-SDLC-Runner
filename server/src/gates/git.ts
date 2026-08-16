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

/** Потолок на одну git-команду. Локальные и read-only, но дерево бывает огромным. */
const GIT_TIMEOUT_MS = 120_000;
/** Потолок на захват вывода: `git diff` по грязному дереву с CRLF-шумом уезжал в память целиком. */
const GIT_MAX_OUTPUT = 8 * 1024 * 1024;

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
    let size = 0;
    let settled = false;
    let timedOut = false;

    // Свой таймаут: у встроенных гейтов его не было вовсе (`runOne` передаёт timeoutMs
    // только в `runShell`), и git, вставший на `index.lock` или на огромном дереве,
    // держал этап 6 без всякого предела.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, GIT_TIMEOUT_MS);

    let truncated = false;
    const collect = (bucket: string[], d: Buffer): void => {
      if (size >= GIT_MAX_OUTPUT) {
        truncated = true;
        return;
      }
      const chunk = d.toString('utf8');
      size += chunk.length;
      bucket.push(chunk);
    };
    child.stdout.on('data', (d: Buffer) => collect(out, d));
    child.stderr.on('data', (d: Buffer) => collect(err, d));

    const done = (code: number | null, extra?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const note = timedOut ? `\n[рантайм] git не уложился в ${GIT_TIMEOUT_MS} мс` : '';
      // Обрезка обязана быть сказана вслух: гейты «Анти-обход» и «Секреты» ищут по тексту
      // diff'а, и молча урезанный вывод даёт им «чисто» ровно там, где смотреть было
      // нечего. Отсутствие доказательства не есть доказательство отсутствия.
      const cut = truncated
        ? `\n[рантайм] вывод git обрезан на ${GIT_MAX_OUTPUT} символах — проверено НЕ ВСЁ`
        : '';
      resolve({ code, stdout: out.join(''), stderr: err.join('') + (extra ?? '') + note + cut });
    };
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
  // Обе команды ограничены текущим каталогом (`-- .`) и печатают пути ОТНОСИТЕЛЬНО него.
  // Без этого базы разъезжались: `git diff --name-only` печатает от корня репозитория,
  // `ls-files --others` — от cwd, и в монорепо, где projectRoot это подкаталог, один и
  // тот же файл приезжал как `server/src/a.ts` и как `src/a.ts`. Следствия были два:
  // ложные «файлы вне плана» в scope-гейте и неработающее вычитание baseline, потому что
  // `join(projectRoot, f)` давал несуществующий путь.
  const base = (await hasCommits(cwd))
    ? ['diff', '--ignore-cr-at-eol', '--name-only', '--relative', 'HEAD', '--', '.']
    : [];
  const tracked = base.length > 0 ? await git(base, cwd, signal) : { code: 0, stdout: '', stderr: '' };
  const untracked = await git(['ls-files', '--others', '--exclude-standard', '--', '.'], cwd, signal);
  return [...new Set([...lines(tracked.stdout), ...lines(untracked.stdout)])].sort();
}

/**
 * Текст diff'а рабочего дерева — вход анти-обходного гейта и гейта секретов.
 *
 * Неотслеживаемые файлы включаются в него отдельным проходом. `git diff HEAD` их не
 * видит, и оба гейта были слепы ровно к тому случаю, который для них опаснее всего:
 * новый файл `src/__tests__/skip.test.ts` с `describe.skip(` или новый `config/local.ts`
 * с захардкоженным ключом давали «✅ чисто». Scope-гейт такой файл замечал (он смотрит
 * `changedPaths`), а анти-обход и секреты — нет.
 */
/**
 * Артефакты витка из diff'а исключены: они его сопровождение, а не предмет.
 *
 * Без этого гейт секретов краснел от собственного отчёта рецензента (тот цитирует найденные
 * строки), а анти-обход — от плана, где перечислены имена отключаемых тестов. Scope-гейт
 * исключает `.sdlc/**` у себя по той же причине, и форма отчёта прямо это оговаривает.
 */
const SDLC_EXCLUDE = ':(exclude).sdlc';

/** Сколько неотслеживаемых файлов разбираем поштучно. Каждый — отдельный процесс git. */
const MAX_UNTRACKED_DIFFS = 200;

export async function workingDiff(
  cwd: string,
  args: string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  const head = (await hasCommits(cwd)) ? ['HEAD'] : [];
  const tracked = await git(
    ['diff', '--ignore-cr-at-eol', '-U0', ...head, '--', '.', SDLC_EXCLUDE, ...args],
    cwd,
    signal,
  );

  const untracked = await git(
    ['ls-files', '--others', '--exclude-standard', '--', '.', SDLC_EXCLUDE],
    cwd,
    signal,
  );
  const parts = [tracked.stdout];
  const newFiles = lines(untracked.stdout);
  for (const file of newFiles.slice(0, MAX_UNTRACKED_DIFFS)) {
    if (signal?.aborted === true) break;
    // `--no-index` против пустоты даёт для нового файла обычный unified diff, который
    // разбирается тем же кодом, что и остальное.
    const d = await git(
      ['diff', '--no-index', '-U0', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file],
      cwd,
      signal,
    );
    if (d.stdout.trim() !== '') parts.push(d.stdout);
  }
  if (newFiles.length > MAX_UNTRACKED_DIFFS) {
    // Молчаливая усечённость здесь — то же «чисто» на непроверенном: гейт обязан увидеть
    // текст и покраснеть сам, а не считать неразобранное отсутствующим.
    parts.push(
      `\n[рантайм] неотслеживаемых файлов ${newFiles.length}, разобрано ` +
        `${MAX_UNTRACKED_DIFFS} — остальные в diff НЕ вошли и НЕ проверены`,
    );
  }
  return parts.join('\n');
}

export async function deletedPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
  if (!(await hasCommits(cwd))) return [];
  // `--relative -- .`, как в `changedPaths`: без этого в монорепо, где projectRoot —
  // подкаталог, приходили удаления из ЧУЖИХ подпроектов и путь печатался от корня
  // репозитория. Анти-обходный гейт краснел от удалённого теста, которого исполнитель
  // не касался, и сверить путь с планом было нельзя — базы разные.
  const r = await git(
    ['diff', '--diff-filter=D', '--name-only', '--relative', 'HEAD', '--', '.', SDLC_EXCLUDE],
    cwd,
    signal,
  );
  return lines(r.stdout);
}

export async function currentBranch(cwd: string): Promise<string> {
  const r = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return r.stdout.trim();
}
