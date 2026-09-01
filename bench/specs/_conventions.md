# Общие конвенции для всех семейств фикстур bench

Репозиторий: `D:\Проекты\Agent-SDLC-Runner`. `bench/` — бенчмарк моделей: фикстурная задача
прогоняется через виток методологии, итог сверяется скрытыми тестами с эталоном. Устройство —
`bench/README.md`.

## Эталонные файлы — прочитать перед работой

- `bench/fixture/task.md` и `bench/fixture/task-freeship.md` — образец текста задачи
  (структура: «Что должно получиться», политика/правила, «Рамки» с веткой `sdlc/<slug>`).
- `bench/fixture/human.json` — формат банка ответов автоответчика: `answers.rules[]`
  (tag / match-регулярка по тексту вопроса / answer[]), `answers.noise[]`,
  `answers.fallback`, `approvals` (destructiveOverwrite, denyWritesTo, denyScopeExtensionFor,
  denyReason, default), `decisions`.
- `bench/expected/oversize.json` — формат эталона: `cases[]` с `id`, `category`
  (`regression` | `precision` | `human`), `description`, вход (`call`/`order` или свой),
  `expect`.
- `bench/checks/hidden/oversize.hidden.mjs` — образец скрытого теста: читает
  `bench/expected/<slug>.json`, цель — `BENCH_TARGET_DIR`, умолчание — каталог пристинной
  фикстуры; импортирует ТОЛЬКО публичный `src/index.ts` цели (имя нового модуля модели
  угадывать нельзя).
- `bench/fixture/.sdlc/gates.md` — набор гейтов; копируется в семейство с заменой названия
  проекта. Кавычки в колонке «Чем реализован» — только у «Сборки» и «Тестов».
- `bench/fixture/package.json`, `bench/fixture/scripts/build-check.mjs`,
  `bench/fixture/README.md`, `bench/fixture/src/money.ts` — стиль и приёмы.
- `bench/src/hiddenTests.ts` — как спавнить дочерний `node --test` (обязательно вычищать
  `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` из env дочернего процесса — иначе дочерний
  молча пропускает файлы). Нужно тем скрытым тестам, которые сами гоняют набор тестов.

## Стиль кода и текстов

- Всё по-русски: комментарии, docstrings, тексты задач, ответы human-банка.
- Node ≥ 23.6, TypeScript исполняется напрямую (type stripping), ESM, импорты с `.ts`.
- Зависимостей НЕТ (npm install в рабочей копии не выполняется никогда).
- Деньги — копейки, целое число. Процент — половина вверх (`Math.floor(x*pct/100 + 0.5)`).
- Docstrings объясняют «почему», а не «что». Каждая строка таблицы-константы — с комментарием
  причины.
- Текст задачи обязан содержать ровно один маркер ветки вида `` `sdlc/<slug>` `` (первый
  такой в тексте парсится драйвером) и фразу «Ветка витка заведена» в разделе «Рамки».
- Ничего не редактировать вне своих каталогов: `bench/fixtures/<family>/`,
  `bench/expected/<slug>.json`, `bench/checks/hidden/<slug>.hidden.mjs`, и (если сказано в
  спеке) указанные там файлы.

## Что создаётся на семейство

1. `bench/fixtures/<family>/` — мини-проект: `package.json` (по образцу fixture: name,
   private, type module, engines node>=23.6, scripts build/test), `README.md`,
   `.sdlc/gates.md` (копия fixture'ового, название проекта заменить),
   `scripts/build-check.mjs` (verbatim-копия), `src/*.ts`, `test/*.test.ts`.
2. На каждую задачу `<slug>` семейства:
   - `bench/fixtures/<family>/task-<slug>.md`
   - `bench/fixtures/<family>/human-<slug>.json`
   - `bench/expected/<slug>.json`
   - `bench/checks/hidden/<slug>.hidden.mjs` — умолчание цели:
     `resolve(HERE, '..', '..', 'fixtures', '<family>')`.
3. Запись задачи в реестре `bench/src/tasks.ts` (`familyTask('<slug>', '<family>')`) —
   без неё `--task <slug>` задачу не увидит. Для 31 задачи роадмапа записи уже есть;
   `bench/test/tasks.test.ts` проверяет, что у каждой задачи с каталогом на диске лежат все
   четыре файла.
4. Общее для семейства (интерпретатор эталона, помощники) — в `bench/checks/hidden/lib/`,
   без суффикса `.hidden.mjs`: файл с этим суффиксом читается как тест задачи. Образец —
   `lib/billing-runner.mjs` и трёхстрочные обёртки `vat-rounding.hidden.mjs` и соседи.

## Инварианты проверки (прогнать и доложить вывод)

По умолчанию, если спека задачи не оговаривает иное:

- `cd bench/fixtures/<family> && node scripts/build-check.mjs` — зелёный.
- `node --test "test/**/*.test.ts"` в каталоге семейства — зелёный.
- На НЕТРОНУТОЙ фикстуре: `node --test bench/checks/hidden/<slug>.hidden.mjs` — кейсы
  `regression` ЗЕЛЁНЫЕ, кейсы `precision` и `human` КРАСНЫЕ (иначе они меряли бы то, что и
  так было готово).
- Контроль эталона на решении: скопировать семейство во временный каталог
  `bench/.tmp/<family>-<slug>/` (каталог в `.gitignore`; НЕ внутрь `fixtures/<family>/` —
  `prepareWorkspace` копирует каталог семейства целиком, и решение уехало бы в рабочую копию
  модели), решить задачу там самому как идеальный исполнитель (включая использование секрета
  из human-банка), прогнать
  `BENCH_TARGET_DIR=<абс. путь к tmp-копии> node --test bench/checks/hidden/<slug>.hidden.mjs`
  — ВСЕ кейсы зелёные. Затем удалить tmp-каталог. Красный на решении скрытый тест — брак
  эталона или скрытого теста, чинить до зелёного.
- Эталонные значения считать ВРУЧНУЮ из констант фикстуры и пересчитать дважды; не списывать
  из вывода кода.

## Доклад по завершении

Компактно: созданные файлы, вывод каждой проверки (зелёный/красный и счёт кейсов), дословные
строки-якоря, если спека их требует, отклонения от спеки.
