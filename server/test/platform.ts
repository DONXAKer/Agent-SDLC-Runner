/**
 * Возможности платформы, от которых зависят отдельные тесты.
 *
 * Тест, который не может выполниться на этой машине, обязан сказать это словами и
 * пропуститься, а не падать: красный по причине среды — ровно то, что методология зовёт
 * `blocked_env`, и в наборе тестов он вреден так же, как в наборе гейтов. Пока три таких
 * теста падали, «7 красных» приходилось объяснять устно в каждом отчёте, а любой НОВЫЙ
 * красный в этой куче терялся.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** `null` — символические ссылки создавать можно; строка — почему нельзя. */
export const symlinkSkip: string | null = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-cap-link-'));
  try {
    writeFileSync(join(dir, 'target'), 'x');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'неизвестно';
    return (
      `создание символических ссылок недоступно (${code}). На Windows нужен режим ` +
      'разработчика либо запуск от администратора.'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

/** `null` — `chmod 000` действительно закрывает чтение; строка — почему проверка не идёт. */
export const chmodSkip: string | null = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'sdlc-cap-chmod-'));
  const file = join(dir, 'f.txt');
  try {
    writeFileSync(file, 'x');
    chmodSync(file, 0o000);
    readFileSync(file, 'utf8');
    return 'chmod 000 не закрывает чтение на этой платформе (Windows игнорирует POSIX-режимы)';
  } catch {
    return null;
  } finally {
    try {
      chmodSync(file, 0o644);
    } catch {
      /* уже недоступен — каталог всё равно удаляется целиком */
    }
    rmSync(dir, { recursive: true, force: true });
  }
})();
