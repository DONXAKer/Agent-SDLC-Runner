# Результаты пилота короткого цикла

Серия завершена.

Модель: ollama:qwen3.8-27b-iq4-gpumax. Четыре фиксированные задачи, два повтора, 10 минут активного времени на прогон. Исходный guided v4 сравнивается с прямым циклом исследования, правок и проверок. Текущий ассистент — отдельный контроль интерфейса.

| Режим | Выполнено | Автоприёмка | Выявленные ошибки после заявления готовности | Из них вне исходного набора | Среднее время, с |
|---|---:|---:|---:|---:|---:|
| local | 8/8 | 7/8 | 4 | 4 | 266.1 |
| baseline | 8/8 | 0/8 | 0 | 0 | 369.8 |
| reference | 8/8 | 8/8 | 0 | 0 | 43.3 |

Локальная модель прошла оба повтора без выявленной ошибки: add-validator. Отсутствие выявленной ошибки не доказывает её отсутствие.

## Дополнительное ревью после прогона

- local-config-default-1-sampling-aligned: Invoice.dueDays is always a number; omitted defaultDueDays falls back to 14. Проверка: `bill('audit', validCustomer, [], { defaultDueDays: undefined })`. Получено: `undefined`. [Протокол](local-config-default-1-sampling-aligned/manual-audit.json).
- local-rename-field-1-sampling-aligned: If both names exist, sku wins; an invalid sku must not silently select legacy code. Проверка: `parse("{\"code\":\"OLD\",\"sku\":null,\"title\":\"Audit\",\"priceK\":100}")`. Получено: `{"sku":"OLD","title":"Audit","priceK":100}`. [Протокол](local-rename-field-1-sampling-aligned/manual-audit.json).
- local-config-default-2-sampling-aligned: Invoice.dueDays is always a number; omitted defaultDueDays falls back to 14. Проверка: `bill('audit', validCustomer, [], { defaultDueDays: undefined })`. Получено: `undefined`. [Протокол](local-config-default-2-sampling-aligned/manual-audit.json).
- local-rename-field-2-sampling-aligned: If both names exist, sku wins; an invalid sku must not silently select legacy code. Проверка: `parse("{\"code\":\"OLD\",\"sku\":null,\"title\":\"Audit\",\"priceK\":100}")`. Получено: `{"sku":"OLD","title":"Audit","priceK":100}`. [Протокол](local-rename-field-2-sampling-aligned/manual-audit.json).

Эти проверки выполнены после завершения моделей, не входили в исходный скрытый набор и не передавались генератору. Их результаты не переписывают исходный показатель автоприёмки. Одинаковые дополнительные входы проверены на локальных и контрольных решениях.

Столбец ошибок после заявления готовности объединяет отказы автоматической приёмки после ready_for_review и подтверждённые дополнительные дефекты, без двойного счёта. Исходный automaticFalseSuccess сохранён отдельно в JSON. Сам статус ready_for_review означает готовность к ревью, а не обещание полной корректности.

## Ограничения и воспроизводимость

- Первые локальные запуски принудительно задавали температуру 0, а baseline наследовал серверную 0.15. Они исключены из сравнения и сохранены как [диагностика](temperature-zero-diagnostic.json). Все локальные ячейки повторно выполнены с тем же способом задания параметров, что в baseline; [протокол](sampling-transition.json).

- Автоприёмка: готовность/завершение плюс неизменённые скрытые тесты, границы, обязательные вопросы, дополнительно исполненные тесты и нужная правка документации. Смысл документации требует ревью.
- В оценке v1 наличие нового теста ошибочно определялось по новому файлу. Оценка v2 проверяет прирост исполненных успешных тестов, в том числе в существующем разрешённом файле. Пересчитаны все завершённые решения, сохранены исходные оценки. При этом пересчёте исполнитель, модель, фикстуры и скрытые тесты не менялись: [протокол перехода](evaluation-transition.json).

- Контроль reference выполнен текущим ассистентом через тот же LoopExecutor. Контекст задач был известен; во втором повторе применялись ранее подготовленные решения после чтения исходников. Это контроль интерфейса и повторяемости исполнения, НЕ независимые замеры качества модели. Его токены и стоимость неизвестны; время включает работу с мостом и не сравнивает скорость моделей.
- Локальная цена неизвестна: null не заменяется нулём. Два повтора одной задачи не заменяют разнообразный holdout.
- Условия измерения времени: Shared workstation; other GPU applications, including UnrealEditor, were observed via nvidia-smi during the series and were not stopped. Timings are observational.

- В исходной телеметрии запись, после которой инструмент вернул диагностику ошибки, не входит в счётчик writes. Полное событие и файлы сохранены. После серии исправлены учёт таких записей, неизвестной стоимости оборванных запросов и завершения очереди; [протокол изменений](post-series-changes.json), [финальная валидация](final-validation.json). Исходники измеренной версии сохранены отдельно. Это не меняет скрытые тесты и автоприёмку.
- Проверки пилота поддерживают зарегистрированные Node-команды и исходно зелёное дерево. Это ещё не универсальная поддержка произвольного проекта. Дообучение и включение по умолчанию не проводились.

Построчный статус: [report.md](report.md). Полные данные: [suite.json](suite.json), [summary.json](summary.json), [environment.json](environment.json). В каталогах local/reference сохранены events.ndjson, passport.json, result.json, patch-files и tracked.patch. [Обзор с лентами](index.html).
