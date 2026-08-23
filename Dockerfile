# Agent-SDLC Runner в контейнере.
#
# Две вещи, которые здесь важнее удобства:
#
# 1. **TypeScript исполняется напрямую.** Отдельной сборки сервера нет и заводить её
#    незачем: пакет `shared` экспортирует сырой `.ts`, то есть Node всё равно снимает типы
#    на лету. Второй рантайм (собранный `dist`) означал бы второе поведение, которое
#    расходится с dev'ом — ровно тот класс расхождений, от которого весь этот сервис и
#    защищает. Собирается только `web`: его статику раздаёт сам сервер.
#
# 2. **Целевой проект внутрь образа не кладётся.** Он монтируется томом. Класть чужой
#    репозиторий в слой образа значило бы, что артефакты витка исчезают вместе с
#    контейнером, — а состояние витка живёт на диске проекта, это инвариант методологии.

# ── сборка статики UI ──────────────────────────────────────────────────────
FROM node:22-slim AS web-build
WORKDIR /app

# Сначала манифесты: слой с зависимостями переживает правку исходников.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

COPY shared/ shared/
COPY web/ web/
RUN npm run build --workspace web

# ── рантайм ────────────────────────────────────────────────────────────────
FROM node:22-slim

# git нужен не для удобства: на нём держатся обязательные гейты — scope (сверка diff с
# `files_to_touch`), анти-обход тест-гейта и детект отсутствия прогресса. Без него они
# честно отвечают `⏭`, и зелёный вердикт становится недостижим.
#
# docker.io ставит клиент `docker` — не демон. Демон остаётся на хосте: `docker-compose.yml`
# монтирует его сокет (`/var/run/docker.sock`) сюда же. Это даёт `server/src/sandbox/` собирать
# и исполнять команды в песочнице ПРОЕКТА (`.sdlc/sandbox.json`) — своя JDK/Node/итд под
# каждый проект, а не то, что случайно оказалось в этом образе. Осознанная уступка: доступ
# к сокету хоста — это root-эквивалентный доступ к хосту для того, кто пролез в контейнер
# Runner'а. Подтверждено оператором явно (не тихий выбор дефолта), см. `.sdlc/sandbox.json`
# CV и `server/src/sandbox/dockerSandbox.ts`.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates docker.io \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
# `web` в рантайме не нужен как пакет — только его собранная статика.
RUN npm ci --omit=dev --workspace server --workspace shared --include-workspace-root

COPY shared/ shared/
COPY server/src/ server/src/
COPY --from=web-build /app/web/dist/ web/dist/

# Внутри контейнера петля видна только изнутри — слушаем все интерфейсы. Границей служит
# публикация порта на хосте (`127.0.0.1:8030:8030`), а не адрес здесь.
ENV SDLC_HOST=0.0.0.0
EXPOSE 8030

# Целевой проект, конфиг и эталон методологии приходят томами — см. compose.
ENV SDLC_CONFIG_DIR=/config

# Healthcheck смотрит на ручку, которая читает конфиг с диска: контейнер, поднявшийся с
# битым `config/`, не должен числиться здоровым.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8030/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]

WORKDIR /app/server
CMD ["node", "src/index.ts"]
