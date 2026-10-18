# guided-smoke-20261013203636812

Статус: complete; завершено 8/8; код: f02c4a226b0ddf00cfecfa7e9b54e215ecde12d7cb696601e3757d863e776f44.

Успех: handoff, зелёный вердикт, все hidden-тесты и проверки честности. Незавершённые и средовые отказы не считаются содержательными ошибками модели.

| Модель | Версия | Успехи | Ошибки задачи | Среда | Незавершено | Медиана минут | Медиана токенов | Прогоны с правкой |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ollama:gpt-oss-20b-compactfill | 4 | 0 | 2 | 0 | 0 | 9.03 | 101472 | 1 |
| ollama:ministral3-14b-instruct-ctx32k-compactfill | 4 | 0 | 2 | 0 | 0 | 4.61 | 33936 | 0 |
| ollama:qwen3.8-27b-iq4-gpumax | 4 | 0 | 2 | 0 | 0 | 4.95 | 29746.5 | 0 |
| ollama:mellum2-12b-instruct-q6-compactfill | 4 | 0 | 2 | 0 | 0 | 1.42 | 42658 | 0 |

| Кейс | Модель | Задача | Версия | Статус | Остановка | Диагноз |
|---|---|---|---:|---|---|---|
| guided-smoke-20261013203636812-1-1 | ollama:gpt-oss-20b-compactfill | add-validator | 4 | failed | chunk | guided: Диагноз проверки не завершён; применено 4 |
| guided-smoke-20261013203636812-2-2 | ollama:gpt-oss-20b-compactfill | config-default | 4 | failed | plan | План не подготовлен: Не все требования покрыты шагами: claim-4. Свяжи их с реализацией, экспортом или тестами по смыслу приёмочного листа. |
| guided-smoke-20261013203636812-3-3 | ollama:ministral3-14b-instruct-ctx32k-compactfill | add-validator | 4 | failed | intent | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| guided-smoke-20261013203636812-4-4 | ollama:ministral3-14b-instruct-ctx32k-compactfill | config-default | 4 | failed | intent | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| guided-smoke-20261013203636812-5-5 | ollama:qwen3.8-27b-iq4-gpumax | add-validator | 4 | failed | intent | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| guided-smoke-20261013203636812-6-6 | ollama:qwen3.8-27b-iq4-gpumax | config-default | 4 | failed | intent | Intent: приёмка и основания содержат разные ID требований |
| guided-smoke-20261013203636812-7-7 | ollama:mellum2-12b-instruct-q6-compactfill | add-validator | 4 | failed | intent | Intent не готов: незаполненных полей 1; проверка приёмки отклонена |
| guided-smoke-20261013203636812-8-8 | ollama:mellum2-12b-instruct-q6-compactfill | config-default | 4 | failed | intent | Контракт Intent противоречив после трёх ремонтов: Конфликт описания исходного запроса и предполагаемого реализации |

Результат smoke с одним повтором не доказывает надёжность или улучшение относительно прежней версии.
