# Короткий цикл: пилот

Статус: complete. Завершено 24/24.

| Режим | Задача | Повтор | Статус | Приёмка | Скрытые | Активных секунд |
|---|---|---:|---|---|---|---:|
| local | add-validator | 1 | ready_for_review | true | 8/8 | 406.9 |
| baseline | add-validator | 1 | blocked | false | 2/8 | 244.1 |
| reference | add-validator | 1 | ready_for_review | true | 8/8 | 64.8 |
| local | config-default | 1 | ready_for_review | true | 6/6 | 470.4 |
| baseline | config-default | 1 | blocked | false | 2/6 | 506.0 |
| reference | config-default | 1 | ready_for_review | true | 6/6 | 74.1 |
| local | rename-field | 1 | ready_for_review | true | 6/6 | 237.0 |
| baseline | rename-field | 1 | run-timeout | false | 2/6 | 600.6 |
| reference | rename-field | 1 | ready_for_review | true | 6/6 | 52.8 |
| local | impossible-without-data | 1 | needs_input | false | 2/5 | 179.4 |
| baseline | impossible-without-data | 1 | blocked | false | 2/5 | 420.1 |
| reference | impossible-without-data | 1 | ready_for_review | true | 5/5 | 54.3 |
| local | add-validator | 2 | ready_for_review | true | 8/8 | 314.2 |
| baseline | add-validator | 2 | blocked | false | 2/8 | 334.9 |
| reference | add-validator | 2 | ready_for_review | true | 8/8 | 26.3 |
| local | config-default | 2 | ready_for_review | true | 6/6 | 168.3 |
| baseline | config-default | 2 | blocked | false | 2/6 | 215.6 |
| reference | config-default | 2 | ready_for_review | true | 6/6 | 27.6 |
| local | rename-field | 2 | ready_for_review | true | 6/6 | 207.8 |
| baseline | rename-field | 2 | blocked | false | 2/6 | 206.8 |
| reference | rename-field | 2 | ready_for_review | true | 6/6 | 26.1 |
| local | impossible-without-data | 2 | ready_for_review | true | 5/5 | 144.5 |
| baseline | impossible-without-data | 2 | blocked | false | 2/5 | 430.1 |
| reference | impossible-without-data | 2 | ready_for_review | true | 5/5 | 20.2 |

- Assistant-session reference is not blind; repetitions are not independent statistical samples.
- Same tool loop for local/reference; baseline keeps its original guided orchestration.
- Hidden cases and file obligations are evidence, not proof of every requirement. No default rollout based on this pilot.
- Unknown token costs stay unknown. Reference latency includes manual bridge handling.
- Initial local temperature=0 runs were excluded and preserved as diagnostics. Aligned local runs inherit the same sampling parameters as guided baseline; see sampling-transition.json.
