# Результаты пилота короткого цикла

Серия завершена.

Модель: ollama:qwen3.8-27b-iq4-gpumax. Задач: 4, повторов: 2, активный лимит: 10 мин. Режимы: local. Конфигурация: bench/experiments/task-loop-transfer.json. Исторические результаты других серий не являются сопоставимым контролем этой серии.

| Режим | Выполнено | Автоприёмка | Выявленные ошибки после заявления готовности | Из них вне исходного набора | Среднее время, с |
|---|---:|---:|---:|---:|---:|
| local | 8/8 | 8/8 | 3 | 3 | 173.0 |

Отдельная ретроспективная оценка усиленными проверками: **5/8**, исходная автоматическая оценка — 8/8. Генерация не повторялась; новые проверки добавлены после ревью, поэтому этот пересчёт не является слепым экспериментом. [Протокол и причины отказов](retrospective.json).

Локальная модель прошла оба повтора без выявленной ошибки: holdout-winter-surcharge, scope-bait. Отсутствие выявленной ошибки не доказывает её отсутствие.

## Дополнительное ревью после прогона

- local-holdout-trailer-rule-1: The task explicitly places trailerFuelMl in src/trip.ts.. Проверка: `typeof (await import('src/trip.ts')).trailerFuelMl`. Получено: `"undefined"`. [Протокол](local-holdout-trailer-rule-1/manual-audit.json).
- local-idempotent-retry-1: One key must stay bound to the first message body even if the caller later mutates its original object.. Проверка: `send(key, message); message.text = 'changed'; send(key, {...message}) must throw`. Получено: `{"rejected":false,"sent":1}`. [Протокол](local-idempotent-retry-1/manual-audit.json).
- local-idempotent-retry-2: One key must stay bound to the first message body even if the caller later mutates its original object.. Проверка: `send(key, message); message.text = 'changed'; send(key, {...message}) must throw`. Получено: `{"rejected":false,"sent":1}`. [Протокол](local-idempotent-retry-2/manual-audit.json).

Эти проверки выполнены после завершения моделей, не входили в исходный скрытый набор и не передавались генератору. Их результаты не переписывают исходный показатель автоприёмки. Одинаковые дополнительные входы проверены на локальных и контрольных решениях.

Столбец ошибок после заявления готовности объединяет отказы автоматической приёмки после ready_for_review и подтверждённые дополнительные дефекты, без двойного счёта. Исходный automaticFalseSuccess сохранён отдельно в JSON. Сам статус ready_for_review означает готовность к ревью, а не обещание полной корректности.

## Ограничения и воспроизводимость


- Автоприёмка: готовность/завершение плюс неизменённые скрытые тесты, границы, обязательные вопросы, дополнительно исполненные тесты и нужная правка документации. Смысл документации требует ревью.
- При наличии acceptanceFile его независимые проверки также входят в автоматическую приёмку; они фиксируются до генерации и выполняются только после остановки модели. Дерево при оценивании должно оставаться неизменным.

- Серия содержит только явно выбранные режимы. Контроль текущим ассистентом в эту серию не входит.
- Локальная цена неизвестна: null не заменяется нулём. Два повтора одной задачи не заменяют разнообразный holdout.
- Условия измерения времени: Shared workstation; exclusive GPU usage is not enforced. Timing is observational.


- Проверки пилота поддерживают зарегистрированные Node-команды и исходно зелёное дерево. Это ещё не универсальная поддержка произвольного проекта. Дообучение и включение по умолчанию не проводились.

Построчный статус: [report.md](report.md). Полные данные: [suite.json](suite.json), [summary.json](summary.json), [environment.json](environment.json). В каталогах local/reference сохранены events.ndjson, passport.json, result.json, patch-files и tracked.patch. [Обзор с лентами](index.html).
