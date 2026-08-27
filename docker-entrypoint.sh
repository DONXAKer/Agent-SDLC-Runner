#!/bin/sh
# Настройка git identity контейнера ДО старта сервера — не удобство, а необходимость:
# первый же `git commit` этапа 7 без `user.name`/`user.email` падает («Please tell me
# who you are»), и виток AUTH-104 упёрся ровно в это. `--global`, потому что все
# репозитории проектов монтируются одним и тем же контейнером и живут вне его слоя —
# ставить identity на каждый смысла нет, идентичность оператора одна на инсталляцию.
set -eu

OPERATOR=$(node -e "
try {
  const c = require(process.env.SDLC_CONFIG_DIR + '/runner.json');
  process.stdout.write(typeof c.operator === 'string' ? c.operator : '');
} catch {}
" 2>/dev/null || true)

git config --global user.name "${OPERATOR:-sdlc-runner}"
# Адрес не участвует ни в одной проверке гейтов — только заполняет обязательное поле
# коммита; настоящий адрес оператора при желании переопределяется вручную в контейнере.
git config --global user.email "sdlc-runner@localhost"

# Проекты монтируются томом с хоста — владелец файлов почти всегда не совпадает с
# пользователем внутри контейнера, и без этого git отказывает командой `dubious
# ownership` на КАЖДОЙ git-операции, не только на коммите. `*`, а не конкретный путь:
# монтируемых проектов много и меняются они конфигом, а не пересборкой образа.
git config --global --add safe.directory '*'

exec "$@"
