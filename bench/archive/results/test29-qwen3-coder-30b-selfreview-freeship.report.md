# Отчёт бенчмарка: test29-qwen3-coder-30b-selfreview-freeship
Модель под измерением: `lmstudio:qwen3-coder-30b-stepfill-axisfill` · режим: `{"kind":"all"}` · профиль: контроль на подписке Claude (правка оператора, не сохранена)
Задача: `freeship` · фикстура: `fixture`
Начало: 2026-09-23T10:31:09.202Z · конец: 2026-09-23T10:47:25.620Z
Лимит ходов: 40 на этап (штатный из конфига) · поэтапно: verify 60

**ИЗМЕРЕНИЕ НЕ СОСТОЯЛОСЬ — отказ среды**: lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"}

Про модель этот прогон не говорит ничего; перегони его.
## Этапы
| этап | статус | модель | ходов | вызовов | артефакт | токены | цена | время | трение |
|---|---|---|---|---|---|---|---|---|---|
| intent | ok | lmstudio:qwen3-coder-30b-stepfill-axisfill | 47 запр. | 3 | ✅ | 363 617 | не изм. | 12 мин 19 с | 0 |
| explore | red | lmstudio:qwen3-coder-30b-stepfill-axisfill | — | 26 | — | 547 245 | не изм. | 3 мин 57 с | 2 |
| ask | — | lmstudio:qwen3-coder-30b-stepfill-axisfill | — | не изм. | — | — | — | — | не изм. |
| plan | — | lmstudio:qwen3-coder-30b-stepfill-axisfill | — | не изм. | — | — | — | — | не изм. |
| chunk | — | lmstudio:qwen3-coder-30b-stepfill-axisfill | — | не изм. | — | — | — | — | не изм. |
| verify | — | lmstudio:qwen3-coder-30b-stepfill-selfreview | — | не изм. | — | — | — | — | не изм. |
| handoff | — | lmstudio:qwen3-coder-30b-stepfill-axisfill | — | не изм. | — | — | — | — | не изм. |
## Причины остановки
- **explore** (chunk 1, попытка 1): провал — lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"} · отказ среды: lmstudio: HTTP 400 от http://localhost:1434/v1 — {"error":"Engine protocol predict request failed: fetch failed"}
## Отказы вызовов
- отклонённых вызовов не было
## Промпты и вопросы
| этап | system, симв. | user, симв. | правил оператор |
|---|---|---|---|
| intent | 10 227 | 5 340 | нет |
| explore | 10 647 | 14 635 | нет |
| explore | 10 338 | 14 635 | нет |
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
Автоответчик решил 18 одобрений и 0 вопросов за этот виток — зелёный, полученный чужим «да», не читается как принятый живым оператором.
## Остановка
`stage-env-repeat`, вердикт: —
