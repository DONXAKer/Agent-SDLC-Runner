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

/** Только это значение поддерживается сегодня — раньше параметр `dist` принимался, но
 * молча игнорировался («temurin» всегда, независимо от того, что записано в спеке): тег
 * образа тихо расходился с тем, что человек видел в `sandbox.json`. Явный список одного
 * значения честнее мёртвой ветки — расширять его нужно вместе с реальным вторым слоем в
 * `jdkLayer`, не раньше. */
export const KNOWN_JDK_DIST = new Set(['temurin']);

function jdkLayer(version: string): string {
  // Temurin публикует `/opt/java/openjdk` как готовый JAVA_HOME внутри своего образа —
  // копируем директорию целиком, без апт-репозитория adoptium и его ключа.
  return [
    `COPY --from=eclipse-temurin:${version}-jdk /opt/java/openjdk /opt/java`,
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

/** Экранирование для двойных кавычек Dockerfile (та же семантика, что и у shell-строк в
 * двойных кавычках): обратный слэш, сама кавычка и `$` — единственные символы, ломающие
 * форму. `$` экранируется отдельно и ПОСЛЕДНИМ (после `\`/`"`, не раньше — иначе только что
 * добавленный экранирующий слэш сам попал бы под замену): без этого Dockerfile разворачивал
 * `${VAR}`/`$VAR` внутри `ENV "..."` по значениям, объявленным РАНЕЕ в этом же Dockerfile
 * (`JAVA_HOME`/`PATH` из `jdkLayer`/`nodeLayer`) — проверено реальной сборкой:
 * `env: {"X": "${JAVA_HOME}/evil"}` из sandbox.json давало в контейнере не буквальную
 * строку, а фактическое значение `JAVA_HOME`, молча разойдясь с тем, что оператор видел
 * в конфиге. Перевод строки экранировать нечем — Dockerfile-инструкция всегда одна строка,
 * поэтому такие значения отклоняются валидацией спеки (`spec.ts`) ДО того, как долетают
 * сюда. */
function dockerfileQuote(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$');
}

export function buildDockerfile(spec: SandboxSpec): string {
  const lines: string[] = [`FROM ${spec.base}`];

  // `spec.apt` — список ИМЁН ПАКЕТОВ, а не произвольного shell-текста: валидация в
  // `spec.ts` (`assertAptPackageName`) уже отклонила всё, что не похоже на имя пакета apt,
  // до того, как строка сюда попала — здесь достаточно склеить.
  const apt = ['curl', 'ca-certificates', 'unzip', ...(spec.apt ?? [])];
  lines.push(`RUN apt-get update && apt-get install -y --no-install-recommends ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*`);

  if (spec.toolchains.jdk) {
    lines.push(jdkLayer(spec.toolchains.jdk.version));
  }
  if (spec.toolchains.node) {
    lines.push(nodeLayer(spec.toolchains.node.version));
  }
  if (spec.docker === 'socket') {
    lines.push(dockerCliLayer());
  }
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    // Ключ уже проверен `spec.ts` как имя переменной окружения (`^[A-Za-z_][A-Za-z0-9_]*$`)
    // — в него нельзя вставить `=`/пробел/перевод строки, значит инструкция не разъедется
    // на две. Значение экранируется явно — раньше шло в шаблонную строку как есть, и `"`
    // или перевод строки внутри него закрывали кавычку раньше и добавляли произвольные
    // Dockerfile-инструкции.
    lines.push(`ENV ${k}="${dockerfileQuote(v)}"`);
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

/**
 * Строка, безопасная как компонент имени ресурса Docker (тег/имя контейнера/том):
 * `[a-z0-9_.-]`, нижний регистр. НЕ уникальна сама по себе — `safeName("Foo Bar")` и
 * `safeName("foo-bar")` дают одну и ту же строку.
 */
function safeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
}

/**
 * Идентификатор проекта в именах ресурсов Docker — `safeName` ПЛЮС короткий хэш от
 * исходного (не санитайзированного) имени.
 *
 * Один `safeName` был реальной коллизией, а не гипотетической: `config/load.ts` не
 * прогоняет ручные конфиги проектов через `badSlug`, а `badSlug` (путь через UI) допускает
 * заглавные буквы и сравнивает имена точным совпадением строк без нормализации — значит
 * `"Foo Bar"` и `"foo-bar"` регистрируются как два РАЗНЫХ проекта, но схлопываются в один
 * `safeName("foo-bar")`. Без хэша это давало один и тот же `containerName`/
 * `cacheVolumeName` для двух разных проектов: `ensureContainer` видел контейнер «уже
 * поднятым» и переиспользовал его — с чужим смонтированным `projectRoot` и чужими
 * кэш-томами `~/.m2`/`~/.npm`. Хэш от ИСХОДНОГО имени различает такие пары независимо от
 * того, что с ними делает `safeName`.
 */
export function projectSlug(projectName: string): string {
  const hash = createHash('sha256').update(projectName).digest('hex').slice(0, 8);
  return `${safeName(projectName)}-${hash}`;
}

export function imageTag(projectName: string, spec: SandboxSpec): string {
  return `sdlc-sandbox:${projectSlug(projectName)}-${specHash(spec)}`;
}
