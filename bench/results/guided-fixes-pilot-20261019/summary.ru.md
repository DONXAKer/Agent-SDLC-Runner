# Guided validation: pilot

Серия: **source-changed**. Успех: **0/12**.

Статусы: {"failed":2,"pending":10}.

| Модель | Задача | Повтор | Статус | Этап отказа | Причина |
|---|---|---|---|---|---|
| ollama:mellum2-12b-instruct-q6 | config-default | 1 | failed | intent | Контракт Intent противоречив после трёх ремонтов: Конфликт в определении срока оплаты: в разделе «Чего не делаем» указано, что срок оплаты по умолчанию НЕ должен быть установлен через BillingConfig, а в разделе «Что делаем» — он ДОЛЖЕН быть установлен. |
| ollama:mellum2-12b-instruct-q6 | config-default | 2 | failed | intent | Контракт Intent противоречив после трёх ремонтов: Конфликт в поведении Invoice: требуется поле `dueDays` всегда, но в текущем сценарии (request-1:L13-L14) значение `opts.dueDays?` не обязателен, что может привести to отсутствием поля при вызове без `opts`; Противоречие в приоритете значений `dueDays`: согласно request-1:L11-L12 приоритет — `opts.dueDays` → `resolveConfig(config)?.defaultDueDays` → `14`, но в текущем тестировании (request-1:L20-L21) уже используется `opts.dueDays` без проверки на `undefined`, что нарушает логику приоритета; Несоответствие между требованием обязательного поля `dueDays` в Invoice (request-1:L8-L9) и возможностью его отсутствия при вызове без `opts.dueDays` (request-1:L13-L14), что нарушает согласованность Intents |
| ollama:mellum2-12b-instruct-q6 | rename-field | 1 | pending | — |  |
| ollama:mellum2-12b-instruct-q6 | rename-field | 2 | pending | — |  |
| ollama:gpt-oss-20b-ctx32k | add-validator | 1 | pending | — |  |
| ollama:gpt-oss-20b-ctx32k | add-validator | 2 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | vat-rounding | 1 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | vat-rounding | 2 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | rename-field | 1 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | rename-field | 2 | pending | — |  |
| ollama:ministral3-14b-instruct-ctx32k | config-default | 1 | pending | — |  |
| ollama:ministral3-14b-instruct-ctx32k | config-default | 2 | pending | — |  |
