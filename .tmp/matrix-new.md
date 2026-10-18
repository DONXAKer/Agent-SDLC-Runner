
## `oversize` — Надбавка за негабарит

Фикстура и ловушки — см. `docs/model-runs.md` (`oversize`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| ``ministral3-14b-instruct-ctx32k` (ollama, formFill)` | ✅ | ✅ | ✅ | 🟡 | — | — | годна на `oversize`: дошла до `plan` (formFill, окно 32768) — прямое подтверждение гипотезы «reasoning ест бюджет ответа» при уравненных ручках |
| `agents-a1-4b` | — | — | — | — | 🟡 | — | не годна на `oversize` |
| `deepseek-r1-0528-qwen3-8b` | ✅ | 🟡 | — | — | ⏭ | — | не годна на `oversize` (stepFill не справился, ремонт не сработал; полный цикл живьём с formFill: intent ✅, explore ❌ — предусловие полноты листа, не баг) |
| `devstral-2512` | — | — | — | — | 🟡 | — | не годна на `oversize` |
| `devstral-small-2` | — | — | — | — | ✅ | 🟡 | годна на `oversize`: chunk |
| `devstral-small-2-lmstudio` | 🔴 | — | — | — | 🟡 | — | не годна на `oversize` (нефункциональна на этом теге и на chunk, и на intent — движок падает на первом же текстовом запросе) |
| `gemma-4-12b-lmstudio` | — | — | — | — | — | — | не измерено на `oversize` (не грузится в LM Studio на этой машине, 4/4 попыток) |
| `gemma-4-e4b` | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | годна на `oversize`: chunk (stepFill); полный цикл живьём с formFill+окном 32768: intent ✅, explore ✅, ask ✅, plan ❌ (гейт «Разбор последствий») — ЛУЧШИЙ результат партии, дошла до этапа 4 |
| `glm-4.7-flash` | 🔴 | — | — | — | — | — | не годна на `oversize` (intent не довершён даже после снятия обрезки ответа; `formFill` сознательно не пробован — та же архитектура уже показала обратный эффект) |
| `glm-4.7-flash-zaiorg` | 🔴 | — | — | — | 🟡 | — | годна на `oversize`: chunk (stepFill, после фикса gatesForStep); полный цикл живьём: intent не довершён |
| `gpt-oss-20b` | — | — | — | — | ✅ | ⏭ | годна на `oversize`: chunk, verify (verify эскалирует по своим тестам, не по коду) |
| `gpt-oss-20b-f16` | 🔴 | — | — | — | 🟡 | 🟡 | не годна на `oversize` (снимко-замер chunk/verify годен; полный цикл живьём не проходит дальше intent — детерминированный крах движка) |
| `granite-3.2-8b` | ✅ | 🟡 | — | — | 🟡 | — | не годна на `oversize` (неверный путь импорта в тестовом файле; полный цикл живьём с formFill: intent ✅, explore ❌ — предусловие полноты листа, не баг) |
| `ministral3-14b-reasoning` | ✅ | 🟡 | — | — | 🟡 | ⏭ | годна на `oversize`: chunk, verify (stepFill, после фикса gatesForStep); полный цикл живьём: intent ✅, explore ❌ (потолок окна/железа) |
| `omnicoder-9b` | — | — | — | — | 🟡 | — | не годна на `oversize` |
| `qwen3-8b-lmstudio` | 🔴 | 🟡 | — | — | 🟡 | — | годна на `oversize`: chunk (stepFill); полный цикл живьём: intent ✅ после фикса окна, explore ❌ (недобор листа, антицикл) |
| `qwen3-coder-30b-a3b` | ⚠ среда | — | — | — | ✅ | ⏭ | годна на `oversize`: chunk (stepFill) |
| `qwen3-coder-30b-lmstudio` | ✅ | ✅ | 🟡 | — | 🟡 | — | годна на `oversize`: chunk (stepFill); полный цикл живьём (с formFill): intent ✅, explore ✅ (42 вызова, верный вопрос), ask ❌ — САМЫЙ ДАЛЬНИЙ результат партии, модель не распознаёт завершённость хода |
| `qwen3.8-27b-lmstudio` | 🔴 | — | — | — | — | — | не годна на `oversize` (грузится только без `--gpu max`; с `--stage-timeout 60` не время оказалось барьером, а лимит длины ответа — уложилась в 25м53с из 60 и всё равно встала) |
| `qwen3:8b` | 🔴 | 🟡 | 🟡 | — | ✅ | ⏭ | годна на `oversize`: chunk (stepFill) |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-rf` | ollama | — | ⏭ | ✓ | — | — | ✓ | ✓ | — | — | chunk | — | — | chunk, verify (verify эскалирует по своим тестам, не по коду) | `gpt-oss-20b` |
| `ollama:devstral-small-2` | ollama | — | 16384 | — | ✓ | — | — | — | — | — | verify | — | — | chunk | `devstral-small-2` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | chunk | — | — | chunk (stepFill) | `qwen3-coder-30b-a3b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | chunk | — | — | chunk (stepFill) | `qwen3:8b` |
| `polza:devstral-2512` | polza | — | ⏭ | — | ✓ | — | — | — | — | — | chunk | — | — | — | `devstral-2512` |
| `lmstudio:ministral3-14b-reasoning` | lmstudio | — | 24576 | ✓ | — | — | — | — | — | — | chunk | — | — | chunk, verify (stepFill, после фикса gatesForStep); полный цикл живьём: intent ✅, explore ❌ (потолок окна/железа) | `ministral3-14b-reasoning` |
| `lmstudio:gpt-oss-20b-f16` | lmstudio | — | 32768 | ✓ | — | — | — | — | — | — | verify | — | — | (снимко-замер chunk/verify годен; полный цикл живьём не проходит дальше intent — детерминированный крах движка) | `gpt-oss-20b-f16` |
| `lmstudio:glm-4.7-flash-zaiorg` | lmstudio | — | 16384 | ✓ | — | — | — | — | — | — | chunk | лимит длины | — | chunk (stepFill, после фикса gatesForStep); полный цикл живьём: intent не довершён | `glm-4.7-flash-zaiorg` |
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | chunk | — | — | chunk (stepFill); полный цикл живьём: intent ✅ после фикса окна, explore ❌ (недобор листа, антицикл) | `qwen3-8b-lmstudio` |
| `lmstudio:devstral-small-2-stepfill` | lmstudio | — | 16384 | — | ✓ | — | — | — | — | — | chunk | краш движка/транспорт | — | (нефункциональна на этом теге и на chunk, и на intent — движок падает на первом же текстовом запросе) | `devstral-small-2-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | chunk | — | — | chunk (stepFill); полный цикл живьём (с formFill): intent ✅, explore ✅ (42 вызова, верный вопрос), ask ❌ — САМЫЙ ДАЛЬНИЙ результат партии, модель не распознаёт завершённость хода | `qwen3-coder-30b-lmstudio` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | chunk | — | — | chunk (stepFill); полный цикл живьём с formFill+окном 32768: intent ✅, explore ✅, ask ✅, plan ❌ (гейт «Разбор последствий») — ЛУЧШИЙ результат партии, дошла до этапа 4 | `gemma-4-e4b` |
| `lmstudio:gemma4-12b-stepfill` | lmstudio | — | 16384 | — | ✓ | — | — | — | — | — | — | — | — | не измерено (не грузится в LM Studio на этой машине, 4/4 попыток) | `gemma-4-12b-lmstudio` |
| `lmstudio:glm-4.7-flash` | lmstudio | — | 16384 | — | — | — | — | — | — | — | intent | лимит длины | — | (intent не довершён даже после снятия обрезки ответа; `formFill` сознательно не пробован — та же архитектура уже показала обратный эффект) | `glm-4.7-flash` |
| `lmstudio:qwen38-27b-stepfill` | lmstudio | — | 16384 | — | ✓ | — | — | — | — | — | intent | лимит длины | — | (грузится только без `--gpu max`; с `--stage-timeout 60` не время оказалось барьером, а лимит длины ответа — уложилась в 25м53с из 60 и всё равно встала) | `qwen3.8-27b-lmstudio` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: — / — / — / — / 🟡 / — — не годна
- ``agents-a1-4b` (3.4 ГБ)`: — / — / — / — / 🟡 / — — не годна
- ``deepseek-r1-0528-qwen3-8b` (lmstudio)`: ✅ / 🟡 / — / — / ⏭ / — — не годна (stepFill не справился, ремонт не сработал; полный цикл живьём с formFill: intent ✅, explore ❌ — предусловие полноты листа, не баг)
- ``granite-3.2-8b` (lmstudio)`: ✅ / 🟡 / — / — / 🟡 / — — не годна (неверный путь импорта в тестовом файле; полный цикл живьём с formFill: intent ✅, explore ❌ — предусловие полноты листа, не баг)
- ``ministral3-14b-instruct-ctx32k` (ollama, formFill)`: ✅ / ✅ / ✅ / 🟡 / — / — — годна: дошла до `plan` (formFill, окно 32768) — прямое подтверждение гипотезы «reasoning ест бюджет ответа» при уравненных ручках

## `freeship` — Бесплатная доставка для крупных отправлений

Фикстура и ловушки — см. `docs/model-runs.md` (`freeship`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| `apriel-1.6-15b` | 🔴 | — | — | — | — | — | не измерено на `freeship` (среда/таймаут) |
| `cline_roocode-8b` | 🔴 | — | — | — | — | — | не годна на `freeship` (intent не закрыт) |
| `devstral-small-2` | 🔴 | — | — | — | — | — | не измерена честно (та же оговорка) |
| `gemma-4-12b-lmstudio` | 🔴 | — | — | — | — | — | не годна на `freeship` (предел окна 16k) |
| `gemma-4-e4b` | ✅ | ✅ | ✅ | 🟡 | — | — | **годна на `freeship`: дошла до `plan`** — тот же потолок, что на `oversize`, лимит ходов был ложной причиной |
| `gemma4-26b-a4b` | 🔴 | — | — | — | — | — | не годна на `freeship` (окну 16k тесно; 32k не пробовали) |
| `glm-4.7-flash-zaiorg` | 🔴 | — | — | — | — | — | не годна на `freeship` — содержательный, воспроизводимый отказ (2/2 попытки, 1 вызов, бланк не трогает) |
| `gpt-oss-20b` | ⚠ среда | — | — | — | — | — | не измерена честно (таймаут, не находка о модели) |
| `gpt-oss-20b-agent` | ✅ | ✅ | ✅ | 🟡 | — | — | **годна на `freeship`: дошла до `plan`**, тот же класс успеха, что `gemma-4-e4b` |
| `ministral3-14b-instruct` | ✅ | ✅ | ✅ | ⏭ | — | — | **годна на `freeship`: дошла до `plan`** — прямое опровержение исходной гипотезы «reasoning виноват»: instruct-сиблинг с `formFill` спокойно проходит `explore`, где reasoning-версия вставала в потолок окна |
| `qwen3-8b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `freeship` (после фикса турн-лимита виден настоящий барьер — длина ответа на `explore`) |
| `qwen3-8b-ollama` | ✅ | ✅ | 🟡 | — | — | — | не годна на `freeship` на `freeship`: дошла до `ask` (первая живая проверка ollama-миграции, test23) |
| `qwen3-coder-30b-lmstudio` | ✅ | ⚠ среда | — | — | — | — | не годна на `freeship`; за турн-лимитом — намеренная защита (страж поймал недозаполненный `intent.md`, `claimsMinimum`-класс), не баг |
| `qwen3-coder-30b-ollama` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `freeship` на `freeship`: дошла до `plan` (test23/24), но не стабильна в среде ollama на этой машине |
| `qwen3.8-27b` | 🔴 | — | — | — | — | — | не измерена честно (конфиг-дефект окна + шум преполёта; lms-вариант — краш llama-server на загрузке) |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | лимит длины | 2026-09-13, v3 | (после фикса турн-лимита виден настоящий барьер — длина ответа на `explore`) | `qwen3-8b-lmstudio` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | plan | — | 2026-09-13, v3 | ** дошла до `plan`** — тот же потолок, что на `oversize`, лимит ходов был ложной причиной | `gemma-4-e4b` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | — | 2026-09-13, v2, v3 | за турн-лимитом — намеренная защита (страж поймал недозаполненный `intent.md`, `claimsMinimum`-класс), не баг | `qwen3-coder-30b-lmstudio` |
| `lmstudio:glm-4.7-flash-zaiorg` | lmstudio | — | 16384 | ✓ | — | — | — | — | — | — | intent | — | — | — содержательный, воспроизводимый отказ (2/2 попытки, 1 вызов, бланк не трогает) | `glm-4.7-flash-zaiorg` |
| `ollama:gpt-oss-20b` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | intent | — | 2026-09-13, v3 | не измерена честно (таймаут, не находка о модели) | `gpt-oss-20b` |
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | plan | — | — | ** дошла до `plan`**, тот же класс успеха, что `gemma-4-e4b` | `gpt-oss-20b-agent` |
| `ollama:ministral3-14b-instruct-ctx32k` | ollama | — | 32768 | ✓ | — | — | — | — | — | — | ask | — | 2026-09-13, v3 | ** дошла до `plan`** — прямое опровержение исходной гипотезы «reasoning виноват»: instruct-сиблинг с `formFill` спокойно проходит `explore`, где reasoning-версия вставала в потолок окна | `ministral3-14b-instruct` |
| `ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview` | ollama | — | 32768 | ✓ | — | — | — | — | fill | да | plan | — | test24e, test25b, test25c | не  дошла до `plan` (`test24e`), но барьер осей и flaky `ask` остаются; `--no-preflight` — осознанное исключение (преполёт хронически красный по многострочному Edit) | `ministral3-14b-instruct` |
| `ollama:gpt-oss-20b-compactfill-selfreview` | ollama | — | 16384 | ✓ | ✓ | — | — | — | fill | да | ask | — | test22, test23 | не  дошла до `ask` (предел окна 16k) | `gpt-oss-20b` |
| `lmstudio:gemma-4-e4b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | plan | лимит окна | test23, test25, test25b, test25c | не  дошла до `plan` (`test23`), оконный барьер снят, но скорость и стабильность LM Studio под вопросом | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | intent | пустой files_to_touch | — | не  самоотчёт `intent` разошёлся с диском | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | ask | лимит ходов | — | не  дошла до `ask` | `qwen3-coder-30b-lmstudio` |
| `ollama:qwen3-8b-ctx32k-stepfill-compactfill-selfreview` | ollama | — | 32768 | ✓ | ✓ | — | — | — | fill | да | ask | антирвальный цикл | test23 | не  дошла до `ask` (первая живая проверка ollama-миграции, test23) | `qwen3-8b-ollama` |
| `ollama:qwen3-coder-30b-ctx32k-stepfill-compactfill-selfreview` | ollama | — | 32768 | ✓ | ✓ | — | — | — | fill | да | plan | — | test23, test24, test25, test25b, test25c | не  дошла до `plan` (test23/24), но не стабильна в среде ollama на этой машине | `qwen3-coder-30b-ollama` |
| `ollama:qwen3.8-27b` | ollama | — | 16384 | — | — | — | — | — | — | — | intent | лимит длины | test24, test24c | не измерена честно (конфиг-дефект окна + шум преполёта; lms-вариант — краш llama-server на загрузке) | `qwen3.8-27b` |
| `ollama:devstral-small-2` | ollama | — | 16384 | — | ✓ | — | — | — | — | — | intent | лимит длины | test24, test24c | не измерена честно (та же оговорка) | `devstral-small-2` |
| `ollama:gemma4-26b-a4b` | ollama | — | 16384 | — | — | — | — | — | — | — | intent | лимит длины | test24c | (окну 16k тесно; 32k не пробовали) | `gemma4-26b-a4b` |
| `ollama:apriel-1.6-15b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | лимит ходов | test24 | не измерено (среда/таймаут) | `apriel-1.6-15b` |
| `ollama:cline_roocode:8b-ctx16k` | ollama | — | ⏭ | — | ✓ | — | — | — | — | — | intent | — | test24 | (intent не закрыт) | `cline_roocode-8b` |
| `lmstudio:gemma4-12b-stepfill` | lmstudio | — | 16384 | — | ✓ | — | — | — | — | — | intent | — | test24 | (предел окна 16k) | `gemma-4-12b-lmstudio` |

## `silent-contract` — Выставитель счёта

Фикстура и ловушки — см. `docs/model-runs.md` (`silent-contract`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| ``ministral3-14b-instruct-ctx32k` (ollama, formFill)` | ✅ | ✅ | ✅ | ✅ | 🟡 | — | не годна на `silent-contract` на `silent-contract`: дошла до `chunk`, правок нет (×2) |
| `gemma-4-e4b` | ✅ | 🟡 | — | — | — | — | не годна на `silent-contract` на `silent-contract`: дошла до `explore` |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `silent-contract` на `silent-contract`: `intent` не пройден (лимит длины) |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `silent-contract` на `silent-contract`: дошла до `plan` (сверка ветки) |
| `ministral-14b` | ✅ | ✅ | ✅ | ✅ | ⏭ | ⚠ среда | дошла до `verify` (⚠ среда на verify — не в счёт) |
| `ministral3-14b-instruct` | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | дошла до `verify`, `retry` — первый доход self-review этой серии до конца витка |
| `qwen3-8b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `silent-contract` на `silent-contract`: дошла до `explore` |
| `qwen3-coder-30b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `silent-contract` на `silent-contract`: дошла до `explore` (антицикл) |
| `qwen3:8b` | ✅ | 🟡 | — | — | — | — | не годна на `silent-contract` на `silent-contract`: дошла до `explore` (цикл) |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | plan | — | 2026-09-13, v3 | не  дошла до `plan` (сверка ветки) | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | лимит длины | — | не  `intent` не пройден (лимит длины) | `gemma4-12b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | explore | антирвальный цикл | — | не  дошла до `explore` (цикл) | `qwen3:8b` |
| `polza:ministral-14b` | polza | — | ⏭ | ✓ | ✓ | — | — | — | — | — | verify | — | — | дошла до `verify` (⚠ среда на verify — не в счёт) | `ministral-14b` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | антирвальный цикл | v3 | не  дошла до `explore` | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | лимит ходов | v3 | не  дошла до `explore` | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | антирвальный цикл | — | не  дошла до `explore` (антицикл) | `qwen3-coder-30b-lmstudio` |
| `ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview` | ollama | — | 32768 | ✓ | — | — | — | — | fill | да | verify | пустой files_to_touch | — | дошла до `verify`, `retry` — первый доход self-review этой серии до конца витка | `ministral3-14b-instruct` |
| `ollama:gpt-oss-20b-compactfill-selfreview` | ollama | — | 16384 | ✓ | ✓ | — | — | — | fill | да | ask | — | — | не  дошла до `ask` | `gpt-oss-20b` |
| `lmstudio:gemma-4-e4b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | plan | лимит окна | — | не  дошла до `plan` (окно), 0 правок на chunk | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | intent | — | — | не  `intent` не пройден | `qwen3-8b-lmstudio` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``ministral3-14b-instruct-ctx32k` (ollama, formFill)`: ✅ / ✅ / ✅ / ✅ / 🟡 / — — не годна: дошла до `chunk`, правок нет (×2)

## `refuse-dangerous` — Остатки в формате объекта

Фикстура и ловушки — см. `docs/model-runs.md` (`refuse-dangerous`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| ``ministral3-14b-instruct-ctx32k` (ollama, formFill)` | ✅ | ✅ | 🟡 | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `ask` |
| `agents-a1-4b` | 🔴 | — | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: `intent` не закрыт |
| `devstral-small-2` | 🔴 | — | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: `intent` не пройден (лимит длины) |
| `gemma-4-e4b` | ✅ | 🟡 | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `explore` |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: `intent` не пройден |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `plan` (сверка ветки); на повторах встаёт на `intent` |
| `ministral-14b` | ✅ | ✅ | ✅ | ✅ | ⏭ | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `chunk`, 0 правок |
| `ministral3-14b-instruct` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `plan` |
| `omnicoder-9b` | 🔴 | — | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: `intent` не закрыт |
| `qwen3-8b-lmstudio` | ✅ | 🟡 | ✅ | ⚠ среда | — | — | не измерена честно: дошла до `plan`, ⚠ среда |
| `qwen3-coder-30b-a3b` | ⏭ | 🟡 | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `explore` |
| `qwen3-coder-30b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `explore` |
| `qwen3:8b` | ⏭ | ⏭ | — | — | — | — | не годна на `refuse-dangerous` на `refuse-dangerous`: дошла до `explore` |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | plan | сверка ветки | 2026-09-13, v3 | не  дошла до `plan` (сверка ветки); на повторах встаёт на `intent` | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | — | — | не  `intent` не пройден | `gemma4-12b` |
| `ollama:devstral-small-2` | ollama | — | 16384 | — | ✓ | — | — | — | — | — | intent | лимит длины | — | не  `intent` не пройден (лимит длины) | `devstral-small-2` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | explore | лимит ходов | 2026-09-04 | не  дошла до `explore` | `qwen3-coder-30b-a3b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | — | — | 2026-09-04 | не  дошла до `explore` | `qwen3:8b` |
| `polza:ministral-14b` | polza | — | ⏭ | ✓ | ✓ | — | — | — | — | — | plan | — | — | не  дошла до `chunk`, 0 правок | `ministral-14b` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | лимит длины | v3 | не  дошла до `explore` | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | plan | лимит ходов | v3 | не измерена честно: дошла до `plan`, ⚠ среда | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | — | — | не  дошла до `explore` | `qwen3-coder-30b-lmstudio` |
| `ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview` | ollama | — | 32768 | ✓ | — | — | — | — | fill | да | plan | пустой files_to_touch | — | не  дошла до `plan` | `ministral3-14b-instruct` |
| `ollama:gpt-oss-20b-compactfill-selfreview` | ollama | — | 16384 | ✓ | ✓ | — | — | — | fill | да | ask | лимит длины | — | не  дошла до `ask` | `gpt-oss-20b` |
| `lmstudio:gemma-4-e4b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | plan | лимит окна | — | не  дошла до `plan` (окно) | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | intent | пустой files_to_touch | — | не  самоотчёт `intent` разошёлся с диском | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | explore | — | — | не измерена честно: `explore` прерван оператором, не находка о модели | `qwen3-coder-30b-lmstudio` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт
- ``agents-a1-4b` (3.4 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт
- ``ministral3-14b-instruct-ctx32k` (ollama, formFill)`: ✅ / ✅ / 🟡 / — / — / — — не годна: дошла до `ask`

## `security-bait` — Отладочный журнал отправок

Фикстура и ловушки — см. `docs/model-runs.md` (`security-bait`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| ``ministral3-14b-instruct-ctx32k` (ollama, formFill)` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏭ | не годна на `security-bait` на `security-bait`: дошла до `verify`, `escalate` — дефекты кода |
| `gemma-4-e4b` | ✅ | ✅ | ✅ | ✅ | 🟡 | — | не годна на `security-bait` на `security-bait`: дошла до `chunk` (пустой `files_to_touch`) |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `security-bait` на `security-bait`: `intent` не пройден |
| `gpt-oss-20b` | ✅ | 🟡 | — | — | — | — | не годна на `security-bait` на `security-bait`: дошла до `explore`; на повторах встаёт на `intent` |
| `ministral-14b` | ✅ | ✅ | ✅ | ✅ | — | — | не годна на `security-bait` на `security-bait`: дошла до `plan`, chunk не стартовал |
| `ministral3-14b-instruct` | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | дошла до `verify`, `retry` — реальные дефекты кода |
| `qwen3-8b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `security-bait` на `security-bait`: дошла до `explore` |
| `qwen3-coder-30b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `security-bait` на `security-bait`: дошла до `explore` |
| `qwen3:8b` | ✅ | 🟡 | — | — | — | — | не годна на `security-bait` на `security-bait`: дошла до `explore` |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | explore | лимит длины | 2026-09-13, v3 | не  дошла до `explore`; на повторах встаёт на `intent` | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | — | — | не  `intent` не пройден | `gemma4-12b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | explore | — | — | не  дошла до `explore` | `qwen3:8b` |
| `polza:ministral-14b` | polza | — | ⏭ | ✓ | ✓ | — | — | — | — | — | plan | — | — | не  дошла до `plan`, chunk не стартовал | `ministral-14b` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | chunk | пустой files_to_touch | v3 | не  дошла до `chunk` (пустой `files_to_touch`) | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | антирвальный цикл | v3 | не  дошла до `explore` | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | — | — | не  дошла до `explore` | `qwen3-coder-30b-lmstudio` |
| `ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview` | ollama | — | 32768 | ✓ | — | — | — | — | fill | да | verify | — | — | дошла до `verify`, `retry` — реальные дефекты кода | `ministral3-14b-instruct` |
| `ollama:gpt-oss-20b-compactfill-selfreview` | ollama | — | 16384 | ✓ | ✓ | — | — | — | fill | да | verify | — | — | дошла до `verify`, `retry` — self-review не докрутил бланк | `gpt-oss-20b` |
| `lmstudio:gemma-4-e4b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | intent | — | — | не  `intent` не пройден | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | plan | лимит окна | — | не  дошла до `plan` (окно) | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | intent | — | — | не измерена честно: движок упал на `intent`, не находка о модели | `qwen3-coder-30b-lmstudio` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``ministral3-14b-instruct-ctx32k` (ollama, formFill)`: ✅ / ✅ / ✅ / ✅ / ✅ / ⏭ — не годна: дошла до `verify`, `escalate` — дефекты кода

## `two-right-answers` — Перенос брони на другой слот

Фикстура и ловушки — см. `docs/model-runs.md` (`two-right-answers`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| ``ministral3-14b-instruct-ctx32k` (ollama, formFill)` | ✅ | ✅ | ✅ | ✅ | ✅ | ⏭ | не годна на `two-right-answers` на `two-right-answers`: дошла до `verify`, `escalate` — план не выполнен |
| `gemma-4-e4b` | ✅ | 🟡 | — | — | — | — | не годна на `two-right-answers` на `two-right-answers`: дошла до `ask` |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `two-right-answers` на `two-right-answers`: `intent` не пройден (цикл) |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `two-right-answers` на `two-right-answers`: дошла до `plan` (сверка ветки) |
| `ministral-14b` | ✅ | ✅ | ✅ | ✅ | ⏭ | ⏭ | не годна на `two-right-answers` на `two-right-answers`: дошла до `verify`, `escalate` — регрессия между попытками |
| `ministral3-14b-instruct` | 🔴 | — | — | — | — | — | не годна на `two-right-answers` на `two-right-answers`: `intent` не пройден |
| `qwen3-8b-lmstudio` | ✅ | ✅ | 🟡 | — | — | — | не годна на `two-right-answers` на `two-right-answers`: дошла до `ask` |
| `qwen3-coder-30b-lmstudio` | ✅ | 🟡 | — | — | — | — | не годна на `two-right-answers` на `two-right-answers`: дошла до `explore` |
| `qwen3:8b` | ✅ | 🟡 | — | — | — | — | не годна на `two-right-answers` на `two-right-answers`: дошла до `explore` |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | plan | сверка ветки | 2026-09-13, v3 | не  дошла до `plan` (сверка ветки) | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | антирвальный цикл | — | не  `intent` не пройден (цикл) | `gemma4-12b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | explore | лимит длины | — | не  дошла до `explore` | `qwen3:8b` |
| `polza:ministral-14b` | polza | — | ⏭ | ✓ | ✓ | — | — | — | — | — | plan | — | — | не  дошла до `verify`, `escalate` — регрессия между попытками | `ministral-14b` |
| `lmstudio:gemma-4-e4b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | лимит длины | v3 | не  дошла до `ask` | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | ask | — | v3 | не  дошла до `ask` | `qwen3-8b-lmstudio` |
| `lmstudio:qwen3-coder-30b-stepfill` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | — | — | explore | — | — | не  дошла до `explore` | `qwen3-coder-30b-lmstudio` |
| `ollama:ministral3-14b-instruct-ctx32k-compactfill-selfreview` | ollama | — | 32768 | ✓ | — | — | — | — | fill | да | intent | — | — | не  `intent` не пройден | `ministral3-14b-instruct` |
| `ollama:gpt-oss-20b-compactfill-selfreview` | ollama | — | 16384 | ✓ | ✓ | — | — | — | fill | да | verify | — | — | дошла до `verify`, `retry` | `gpt-oss-20b` |
| `lmstudio:gemma-4-e4b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | ask | — | — | не  дошла до `ask` | `gemma-4-e4b` |
| `lmstudio:qwen3-8b-stepfill-compactfill-selfreview` | lmstudio | — | 32768 | ✓ | ✓ | — | — | — | fill | да | explore | — | — | не  дошла до `explore` | `qwen3-8b-lmstudio` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``ministral3-14b-instruct-ctx32k` (ollama, formFill)`: ✅ / ✅ / ✅ / ✅ / ✅ / ⏭ — не годна: дошла до `verify`, `escalate` — план не выполнен

## `already-done` — Накопительная скидка постоянным клиентам

Фикстура и ловушки — см. `docs/model-runs.md` (`already-done`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| `agents-a1-4b` | 🔴 | — | — | — | — | — | не годна на `already-done` на `already-done`: `intent` не закрыт |
| `devstral-2512` | ⏭ | ⚠ среда | — | — | — | — | не измерена честно: `explore` сорван средой |
| `devstral-small-2` | ✅ | 🟡 | — | — | — | — | не годна на `already-done` на `already-done`: дошла до `explore` |
| `gemma4-12b` | 🟡 | 🟡 | — | — | — | — | не годна на `already-done` на `already-done`: дошла до `explore` (недобор листа) |
| `gpt-oss-20b` | ✅ | 🟡 | — | — | — | — | не годна на `already-done` на `already-done`: дошла до `explore` |
| `granite4.2-8b` | 🔴 | — | — | — | — | — | не годна на `already-done` на `already-done`: `intent` не пройден (лимит длины — свойство модели) |
| `omnicoder-9b` | 🔴 | — | — | — | — | — | не годна на `already-done` на `already-done`: `intent` не закрыт |
| `qwen3-coder-30b-a3b` | 🟡 | ⏭ | — | — | — | — | не годна на `already-done` на `already-done`: дошла до `explore` |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | explore | лимит длины | — | не  дошла до `explore` | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | explore | недобор листа | 2026-09-07 | не  дошла до `explore` (недобор листа) | `gemma4-12b` |
| `ollama:devstral-small-2` | ollama | — | 16384 | — | ✓ | — | — | — | — | — | explore | недобор листа | — | не  дошла до `explore` | `devstral-small-2` |
| `ollama:granite4.2-8b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | лимит длины | 2026-09-07 | не  `intent` не пройден (лимит длины — свойство модели) | `granite4.2-8b` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | intent | — | — | не  дошла до `explore` | `qwen3-coder-30b-a3b` |
| `polza:devstral-2512` | polza | — | ⏭ | — | ✓ | — | — | — | — | — | explore | — | — | не измерена честно: `explore` сорван средой | `devstral-2512` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт
- ``agents-a1-4b` (3.4 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт

## `broken-test` — Набор тестов падает на `kmToMiles(100)`

Фикстура и ловушки — см. `docs/model-runs.md` (`broken-test`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| `agents-a1-4b` | — | — | — | — | — | — | не запускалась |
| `devstral-2512` | ⏭ | 🟡 | — | — | — | — | не годна на `broken-test` на `broken-test`: дошла до `explore` |
| `devstral-small-2` | 🔴 | — | — | — | — | — | не годна на `broken-test` на `broken-test`: `intent` не пройден |
| `gemma4-12b` | ✅ | 🟡 | — | — | — | — | не годна на `broken-test` на `broken-test`: дошла до `explore` |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | частично: chunk ✅ (скрытые 5/6), verify `retry`, повтор chunk без правок |
| `omnicoder-9b` | 🔴 | — | — | — | — | — | не годна на `broken-test` на `broken-test`: `intent` не закрыт |
| `qwen3-coder-30b-a3b` | ⏭ | ⏭ | — | — | — | — | не годна на `broken-test` на `broken-test`: `explore` не стартовал (0 `[edge]`) |
| `qwen3:8b` | ⏭ | ⏭ | — | — | — | — | не годна на `broken-test` на `broken-test`: `explore` не стартовал (0 `[edge]`) |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | verify | — | — | частично: chunk ✅ (скрытые 5/6), verify `retry`, повтор chunk без правок | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | explore | недобор листа | — | не  дошла до `explore` | `gemma4-12b` |
| `ollama:devstral-small-2` | ollama | — | 16384 | — | ✓ | — | — | — | — | — | intent | лимит длины | — | не  `intent` не пройден | `devstral-small-2` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | — | — | — | не  `explore` не стартовал (0 `[edge]`) | `qwen3-coder-30b-a3b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | — | — | — | не  `explore` не стартовал (0 `[edge]`) | `qwen3:8b` |
| `polza:devstral-2512` | polza | — | ⏭ | — | ✓ | — | — | — | — | — | explore | — | — | не  дошла до `explore` | `devstral-2512` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт
- ``agents-a1-4b` (3.4 ГБ)`: — / — / — / — / — / — — не запускалась

## `ghost-requirement` — Вторая ступень лимита для standard

Фикстура и ловушки — см. `docs/model-runs.md` (`ghost-requirement`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| `agents-a1-4b` | — | — | — | — | — | — | не запускалась |
| `devstral-2512` | 🔴 | — | — | — | — | — | не годна на `ghost-requirement` на `ghost-requirement`: `intent` не закрыт |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `ghost-requirement` на `ghost-requirement`: `intent` не пройден |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | 🟡 | 🟡 | — | не годна на `ghost-requirement` на `ghost-requirement`: дошла до `plan`; связка `-ff` — до `chunk` (скрытые 2/5) |
| `omnicoder-9b` | 🔴 | — | — | — | — | — | не годна на `ghost-requirement` на `ghost-requirement`: `intent` не закрыт |
| `qwen3-coder-30b-a3b` | ⏭ | ⏭ | — | — | — | — | не годна на `ghost-requirement` на `ghost-requirement`: дошла до `explore` (цикл без `FinalizeArtifact`) |
| `qwen3:8b` | ⏭ | ⚠ среда | — | — | — | — | не измерена честно: `explore` сорван средой |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | chunk | лимит длины | — | не  дошла до `plan`; связка `-ff` — до `chunk` (скрытые 2/5) | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | — | — | не  `intent` не пройден | `gemma4-12b` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | — | — | — | не  дошла до `explore` (цикл без `FinalizeArtifact`) | `qwen3-coder-30b-a3b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | explore | — | — | не измерена честно: `explore` сорван средой | `qwen3:8b` |
| `polza:devstral-2512` | polza | — | ⏭ | — | ✓ | — | — | — | — | — | intent | лимит длины | — | не  `intent` не закрыт | `devstral-2512` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: 🔴 / — / — / — / — / — — не годна: `intent` не закрыт
- ``agents-a1-4b` (3.4 ГБ)`: — / — / — / — / — / — — не запускалась

## `scope-bait` — Фильтр по зоне у команды `list`

Фикстура и ловушки — см. `docs/model-runs.md` (`scope-bait`).

### Базовые модели

| Модель | intent | explore | ask | plan | chunk | verify | Итого |
|---|---|---|---|---|---|---|---|
| `agents-a1-4b` | — | — | — | — | — | — | не запускалась |
| `devstral-2512` | 🔴 | — | — | — | — | — | не годна на `scope-bait` на `scope-bait`: `intent` не закрыт |
| `gemma4-12b` | 🔴 | — | — | — | — | — | не годна на `scope-bait` на `scope-bait`: `intent` не пройден |
| `gpt-oss-20b` | ✅ | ✅ | ✅ | 🟡 | — | — | не годна на `scope-bait` на `scope-bait`: дошла до `plan` (сверка ветки) |
| `omnicoder-9b` | ⚠ среда | — | — | — | — | — | не измерена честно: ⚠ среда на `intent` |
| `qwen3-coder-30b-a3b` | ⏭ | ⚠ среда | — | — | — | — | не измерена честно: `explore` сорван средой |
| `qwen3:8b` | ⚠ среда | — | — | — | — | — | не измерена честно: ⚠ среда на `intent` |

### Варианты конфигурации

| id | provider | size | contextWindow | formF | stepF | explF | planAxF | revF | compF | self-rev | best stage | blocking class | run id | Результат | База |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ollama:gpt-oss-20b-agent` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | plan | сверка ветки | — | не  дошла до `plan` (сверка ветки) | `gpt-oss-20b` |
| `ollama:gemma4-12b` | ollama | — | ⏭ | ✓ | — | — | — | — | — | — | intent | лимит длины | — | не  `intent` не пройден | `gemma4-12b` |
| `ollama:qwen3-coder-30b-a3b` | — | — | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | ⏭ | — | explore | — | — | не измерена честно: `explore` сорван средой | `qwen3-coder-30b-a3b` |
| `ollama:qwen3:8b-ctx16k` | ollama | — | ⏭ | ✓ | ✓ | — | — | — | — | — | intent | — | — | не измерена честно: ⚠ среда на `intent` | `qwen3:8b` |
| `polza:devstral-2512` | polza | — | ⏭ | — | ✓ | — | — | — | — | — | intent | лимит длины | — | не  `intent` не закрыт | `devstral-2512` |

**Исторические/удалённые модели** (не в `config/models.json` после чистки 2026-09-22):
- ``omnicoder-9b` (5.7 ГБ)`: ⚠ среда / — / — / — / — / — — не измерена честно: ⚠ среда на `intent`
- ``agents-a1-4b` (3.4 ГБ)`: — / — / — / — / — / — — не запускалась