# Короткий цикл: пилот

Статус: stopped. Завершено 8/48. Промежуточные выводы: [conclusions.ru.md](conclusions.ru.md).

| Режим | Задача | Повтор | Статус | Приёмка | Скрытые | Активных секунд |
|---|---|---:|---|---|---|---:|
| local | range-union | 1 | ready_for_review | true | 2/2 | 112.0 |
| evidence | range-union | 1 | ready_for_review | true | 2/2 | 91.6 |
| local | option-overlay | 1 | ready_for_review | false | 1/2 | 96.3 |
| evidence | option-overlay | 1 | ready_for_review | false | 1/2 | 105.4 |
| local | csv-cell | 1 | ready_for_review | true | 2/2 | 43.1 |
| evidence | csv-cell | 1 | ready_for_review | true | 2/2 | 89.4 |
| local | cent-split | 1 | ready_for_review | true | 2/2 | 78.2 |
| evidence | cent-split | 1 | ready_for_review | false | 0/0 | 333.9 |
| local | page-window | 1 | interrupted | — | — | — |
| evidence | page-window | 1 | pending | — | — | — |
| local | batch-outcomes | 1 | pending | — | — | — |
| evidence | batch-outcomes | 1 | pending | — | — | — |
| local | inventory-undo | 1 | pending | — | — | — |
| evidence | inventory-undo | 1 | pending | — | — | — |
| local | expiry-policy | 1 | pending | — | — | — |
| evidence | expiry-policy | 1 | pending | — | — | — |
| evidence | range-union | 2 | pending | — | — | — |
| local | range-union | 2 | pending | — | — | — |
| evidence | option-overlay | 2 | pending | — | — | — |
| local | option-overlay | 2 | pending | — | — | — |
| evidence | csv-cell | 2 | pending | — | — | — |
| local | csv-cell | 2 | pending | — | — | — |
| evidence | cent-split | 2 | pending | — | — | — |
| local | cent-split | 2 | pending | — | — | — |
| evidence | page-window | 2 | pending | — | — | — |
| local | page-window | 2 | pending | — | — | — |
| evidence | batch-outcomes | 2 | pending | — | — | — |
| local | batch-outcomes | 2 | pending | — | — | — |
| evidence | inventory-undo | 2 | pending | — | — | — |
| local | inventory-undo | 2 | pending | — | — | — |
| evidence | expiry-policy | 2 | pending | — | — | — |
| local | expiry-policy | 2 | pending | — | — | — |
| local | range-union | 3 | pending | — | — | — |
| evidence | range-union | 3 | pending | — | — | — |
| local | option-overlay | 3 | pending | — | — | — |
| evidence | option-overlay | 3 | pending | — | — | — |
| local | csv-cell | 3 | pending | — | — | — |
| evidence | csv-cell | 3 | pending | — | — | — |
| local | cent-split | 3 | pending | — | — | — |
| evidence | cent-split | 3 | pending | — | — | — |
| local | page-window | 3 | pending | — | — | — |
| evidence | page-window | 3 | pending | — | — | — |
| local | batch-outcomes | 3 | pending | — | — | — |
| evidence | batch-outcomes | 3 | pending | — | — | — |
| local | inventory-undo | 3 | pending | — | — | — |
| evidence | inventory-undo | 3 | pending | — | — | — |
| local | expiry-policy | 3 | pending | — | — | — |
| evidence | expiry-policy | 3 | pending | — | — | — |

- local/evidence share the model, checks and limits; evidence adds requirement-linked feedback only. Stagnation option is disabled in both.
- Hidden cases and file obligations are evidence, not proof of every requirement. No default rollout based on this pilot.
- Unknown token costs stay unknown. Reference latency includes manual bridge handling.
