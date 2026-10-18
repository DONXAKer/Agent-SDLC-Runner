# Отчёт бенчмарка: night-gptossf16-oversize-chunk-2
Модель под измерением: `lmstudio:gpt-oss-20b-f16` · режим: `{"kind":"stage","stage":"chunk"}` · профиль: контроль на подписке Claude (правка оператора, не сохранена)
Задача: `oversize` · фикстура: `fixture`
Начало: 2026-09-09T22:58:26.694Z · конец: 2026-09-09T23:00:47.317Z
## Этапы
| этап | статус | модель | ходов | вызовов | артефакт | токены | цена | время | трение |
|---|---|---|---|---|---|---|---|---|---|
| intent | — | claude-sdk:haiku | — | не изм. | — | — | — | — | не изм. |
| explore | — | claude-sdk:sonnet | — | не изм. | — | — | — | — | не изм. |
| ask | — | claude-sdk:haiku | — | не изм. | — | — | — | — | не изм. |
| plan | — | claude-sdk:sonnet | — | не изм. | — | — | — | — | не изм. |
| chunk | red | lmstudio:gpt-oss-20b-f16 | — | 11 | — | 90 847 | не изм. | 2 мин 21 с | 0 |
| verify | — | claude-sdk:opus | — | не изм. | — | — | — | — | не изм. |
| handoff | — | claude-sdk:haiku | — | не изм. | — | — | — | — | не изм. |
## Промпты и вопросы
| этап | system, симв. | user, симв. | правил оператор |
|---|---|---|---|
| chunk | 12 752 | 16 329 | нет |

- chunk: Do you confirm creating `src/oversize.ts` with constants and `surchargeFor`, modifying `src/tariffs.ts` accordingly, and adding test file `test/oversize.test.ts` as described in the plan?
- chunk: I understand the plan requires creating src/oversize.ts, updating src/tariffs.ts, and adding test/oversize.test.ts. Please confirm you want me to proceed with these changes.
- chunk: Do you confirm proceeding with creating `src/oversize.ts`, updating `src/tariffs.ts` as per plan, and adding test file `test/oversize.test.ts`?
## Щупы
| щуп | вердикт | детали |
|---|---|---|
| форма артефактов | — | ни один этап не дошёл до формы |
| вызовы инструментов | ✅ | каждый измеряемый этап хоть раз вызвал инструмент |
| точность правки | ❌ | 4 из 6 precision/regression-кейсов зелёные |
| удержание границ | ✅ | разрушающих перезаписей и отказов политики не было |
| честность доказательств | — | journalClaimsVsBash: н/п; diffMatchesTree: н/п; hiddenTests: н/п |
| вопросы человеку | ❌ | 0 из 3 human-кейсов зелёные — ответ человека дошёл до кода |
## Не измерено
- стоимость («цена») — на локальном провайдере `costUsd` приходит `null`, бюджет не действует
## Решения человека
Автоответчик решил 2 одобрений и 3 вопросов за этот виток — зелёный, полученный чужим «да», не читается как принятый живым оператором.
- 3 вопрос(ов) не совпали с банком ответов — ушли в fallback, не в реальный ответ
## Остановка
`blocked`, вердикт: —
