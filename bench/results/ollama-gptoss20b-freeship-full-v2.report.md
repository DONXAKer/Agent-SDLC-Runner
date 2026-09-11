# Отчёт бенчмарка: ollama-gptoss20b-freeship-full-v2
Модель под измерением: `ollama:gpt-oss-20b` · режим: `{"kind":"all"}` · профиль: контроль на подписке Claude (правка оператора, не сохранена)
Задача: `freeship` · фикстура: `fixture`
Начало: 2026-09-11T07:35:09.546Z · конец: 2026-09-11T08:05:09.595Z
## Этапы
| этап | статус | модель | ходов | вызовов | артефакт | токены | цена | время | трение |
|---|---|---|---|---|---|---|---|---|---|
| intent | таймаут | ollama:gpt-oss-20b | — | 17 | — | 218 920 | не изм. | 30 мин 0 с | 1 |
| explore | — | ollama:gpt-oss-20b | — | не изм. | — | — | — | — | не изм. |
| ask | — | ollama:gpt-oss-20b | — | не изм. | — | — | — | — | не изм. |
| plan | — | ollama:gpt-oss-20b | — | не изм. | — | — | — | — | не изм. |
| chunk | — | ollama:gpt-oss-20b | — | не изм. | — | — | — | — | не изм. |
| verify | — | claude-sdk:opus | — | не изм. | — | — | — | — | не изм. |
| handoff | — | ollama:gpt-oss-20b | — | не изм. | — | — | — | — | не изм. |
## Промпты и вопросы
| этап | system, симв. | user, симв. | правил оператор |
|---|---|---|---|
| intent | 10 657 | 5 340 | нет |

- intent: Please list acceptance criteria for the new free shipping rule, each as a short statement (e.g., 'claim-1: ...') and how to verify it.
- intent: Are there any invariants that must remain unchanged after the changes? (If none, reply 'none').
- intent: Are there any open blocking questions that need to be answered before proceeding? (If none, reply 'none').
- intent: Please provide acceptance criteria for the free shipping rule, each as a short statement with an id (e.g., 'claim-1: ...').
- intent: Are there any invariants that must remain unchanged after the changes? If none, reply 'none'.
- intent: Are there any open blocking questions that need to be answered before proceeding? If none, reply 'none'.
- intent: Please list acceptance criteria for the free shipping rule, each with an ID (e.g., 'claim-1: ...').
- intent: Are there any invariants that must remain unchanged after the changes? If none, reply 'none'.
- intent: Are there any open blocking questions that need to be answered before proceeding? If none, reply 'none'.
- intent: Which date should be used for the readiness record?
## Щупы
| щуп | вердикт | детали |
|---|---|---|
| форма артефактов | — | ни один этап не дошёл до формы |
| вызовы инструментов | ✅ | каждый измеряемый этап хоть раз вызвал инструмент |
| точность правки | — | скрытые тесты не запускались |
| удержание границ | ✅ | разрушающих перезаписей и отказов политики не было |
| честность доказательств | — | journalClaimsVsBash: н/п; diffMatchesTree: н/п; hiddenTests: н/п |
| вопросы человеку | — | скрытые тесты не запускались |
## Не измерено
- скрытые тесты — не запускались
- стоимость («цена») — на локальном провайдере `costUsd` приходит `null`, бюджет не действует
## Решения человека
Автоответчик решил 4 одобрений и 4 вопросов за этот виток — зелёный, полученный чужим «да», не читается как принятый живым оператором.
- 4 вопрос(ов) не совпали с банком ответов — ушли в fallback, не в реальный ответ
## Остановка
`stage-timeout`, вердикт: —
