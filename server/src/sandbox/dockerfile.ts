/**
 * Компоновка Dockerfile из спеки проекта.
 *
 * Слои — воспроизводимые `COPY --from=<официальный образ тулчейна>`, а не `apt-get install`
 * из системного репозитория. Тот путь, которым JDK 17 попал в живой контейнер Runner'а на
 * AUTH-104 (apt-install руками поверх `node:22-slim`), не оставляет следа в образе — этот
 * оставляет: тулчейн виден в `docker history`, а пересборка детерминирована версией базового
 * образа, а не тем, что лежало в apt-кэше в момент сборки.
 */

import { createHash } from 'node:crypto';

import type { SandboxSpec } from './types.ts';

function jdkLayer(version: string, dist: string): string {
  // Temurin публикует `/opt/java/openjdk` как готовый JAVA_HOME внутри своего образа —
  // копируем директорию целиком, без апт-репозитория adoptium и его ключа.
  const tag = dist === 'temurin' ? `eclipse-temurin:${version}-jdk` : `eclipse-temurin:${version}-jdk`;
  return [
    `COPY --from=${tag} /opt/java/openjdk /opt/java`,
    'ENV JAVA_HOME=/opt/java',
    'ENV PATH="/opt/java/bin:${PATH}"',
  ].join('\n');
}

function nodeLayer(version: string): string {
  const major = version.split('.')[0];
  // ОДНИМ слоем, не по файлам: `/usr/local/bin/npm` в официальном образе — символическая
  // ссылка на `../lib/node_modules/npm/bin/npm-cli.js`, и `npm-cli.js` сам требует модули
  // ОТНОСИТЕЛЬНО СВОЕГО расположения внутри `node_modules/npm/`. Копирование `bin/npm` и
  // `lib/node_modules` отдельными `COPY` (было раньше) на некоторых версиях Docker
  // разыменовывает символическую ссылку в обычный файл ПО СТАРОМУ пути — относительные
  // require ломаются («Cannot find module '../lib/cli.js'»), и это не гипотеза: `npm ci`
  // валился этой ошибкой на живом контейнере CV. Копирование `/usr/local` целиком копирует
  // директории как есть, включая внутреннюю структуру symlink'ов, и работает.
  return `COPY --from=node:${major}-slim /usr/local /usr/local`;
}

/** `docker exec`-исполнителю самой песочницы CLI не нужен — она изнутри Runner'а ходит по
 * сокету напрямую. Слой добавляется только тестируемому ПРОЕКТУ, если его тестам самим
 * нужно поднимать контейнеры (Testcontainers) — тогда `docker` в PATH внутри песочницы
 * обязан быть, а сокет хоста монтируется отдельно при старте контейнера. */
function dockerCliLayer(): string {
  return [
    'COPY --from=docker:cli /usr/local/bin/docker /usr/local/bin/docker',
  ].join('\n');
}

export function buildDockerfile(spec: SandboxSpec): string {
  const lines: string[] = [`FROM ${spec.base}`];

  const apt = ['curl', 'ca-certificates', 'unzip', ...(spec.apt ?? [])];
  lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*`);

  if (spec.toolchains.jdk) {
    lines.push(jdkLayer(spec.toolchains.jdk.version, spec.toolchains.jdk.dist ?? 'temurin'));
  }
  if (spec.toolchains.node) {
    lines.push(nodeLayer(spec.toolchains.node.version));
  }
  if (spec.docker === 'socket') {
    lines.push(dockerCliLayer());
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    lines.push(`ENV ${k}="${v}"`);
  }
  // Держит контейнер живым между `docker exec`; PID 1 без `tini` не пожинает зомби-процессы
  // от `mvnw`/`npm`, оставленных прерванными командами — на живущий часами контейнер это
  // накопится, а тонкий `tini` в базовых Debian-образах ставится одной строкой.
  lines.push('RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*');
  lines.push('ENTRYPOINT ["/usr/bin/tini", "--"]');
  lines.push('CMD ["sleep", "infinity"]');

  return lines.join('\n') + '\n';
}

/**
 * Стабильная сериализация: ключи сортируются на КАЖДОМ уровне вложенности отдельно.
 *
 * `JSON.stringify(v, Object.keys(v).sort())` — частая ловушка: replacer-массив — это ОДИН
 * список имён, применяемый рекурсивно на всех уровнях, а не только на верхнем. Спека,
 * пропущенная через него, тихо теряла `toolchains.jdk.version` и `dist` — их не было в
 * списке ключей верхнего уровня, — и смена версии JDK не меняла хэш вовсе.
 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const body = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`);
  return `{${body.join(',')}}`;
}

/** Стабильный хэш спеки — тег образа и триггер пересборки. */
export function specHash(spec: SandboxSpec): string {
  return createHash('sha256').update(stableStringify(spec)).digest('hex').slice(0, 12);
}

export function imageTag(projectName: string, spec: SandboxSpec): string {
  const safe = projectName.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  return `sdlc-sandbox:${safe}-${specHash(spec)}`;
}
