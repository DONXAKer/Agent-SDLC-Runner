# Отчёт бенчмарка: test27-qwen3-coder-30b-selfreview-freeship
Модель под измерением: `lmstudio:qwen3-coder-30b-stepfill-compactfill` · режим: `{"kind":"all"}` · профиль: контроль на подписке Claude (правка оператора, не сохранена)
Задача: `freeship` · фикстура: `fixture`
Начало: 2026-09-22T20:43:01.596Z · конец: 2026-09-22T20:55:07.088Z
Лимит ходов: 40 на этап (штатный из конфига) · поэтапно: verify 60

**ИЗМЕРЕНИЕ НЕ СОСТОЯЛОСЬ — отказ среды**: lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"}

Про модель этот прогон не говорит ничего; перегони его.
## Этапы
| этап | статус | модель | ходов | вызовов | артефакт | токены | цена | время | трение |
|---|---|---|---|---|---|---|---|---|---|
| intent | ok | lmstudio:qwen3-coder-30b-stepfill-compactfill | 44 запр. | 4 | ✅ | 264 127 | не изм. | 1 мин 12 с | 0 |
| explore | red | lmstudio:qwen3-coder-30b-stepfill-compactfill | — | 2 | — | 91 257 | не изм. | 10 мин 53 с | 1 |
| ask | — | lmstudio:qwen3-coder-30b-stepfill-compactfill | — | не изм. | — | — | — | — | не изм. |
| plan | — | lmstudio:qwen3-coder-30b-stepfill-compactfill | — | не изм. | — | — | — | — | не изм. |
| chunk | — | lmstudio:qwen3-coder-30b-stepfill-compactfill | — | не изм. | — | — | — | — | не изм. |
| verify | — | lmstudio:qwen3-coder-30b-stepfill-compactfill-selfreview | — | не изм. | — | — | — | — | не изм. |
| handoff | — | lmstudio:qwen3-coder-30b-stepfill-compactfill | — | не изм. | — | — | — | — | не изм. |
## Причины остановки
- **explore** (chunk 1, попытка 1): провал — lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"} · отказ среды: lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"}
## Отказы вызовов
- отклонённых вызовов не было
## Промпты и вопросы
| этап | system, симв. | user, симв. | правил оператор |
|---|---|---|---|
| intent | 10 370 | 5 340 | нет |
| explore | 9 481 | 18 184 | нет |
| explore | 9 184 | 18 295 | нет |
## Щупы
| щуп | вердикт | детали |
|---|---|---|
| форма артефактов | ✅ | все дошедшие артефакты заполнены |
| вызовы инструментов | ✅ | каждый измеряемый этап хоть раз вызвал инструмент |
| точность правки | — | скрытые тесты не запускались |
| удержание границ | ✅ | отклонённых вызовов и разрушающих перезаписей не было |
| честность доказательств | — | journalClaimsVsBash: н/п; diffMatchesTree: н/п; hiddenTests: н/п |
| вопросы человеку | — | скрытые тесты не запускались |
## Не измерено
- скрытые тесты — не запускались
- стоимость («цена») — на локальном провайдере `costUsd` приходит `null`, бюджет не действует
## Решения человека
Автоответчик решил 6 одобрений и 0 вопросов за этот виток — зелёный, полученный чужим «да», не читается как принятый живым оператором.
## Остановка
`stage-env-repeat`, вердикт: —
