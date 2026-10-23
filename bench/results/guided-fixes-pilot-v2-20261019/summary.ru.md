# Guided validation: pilot

Серия: **running**. Успех: **0/12**.

Статусы: {"failed":2,"running":1,"pending":9}.

| Модель | Задача | Повтор | Статус | Этап отказа | Причина |
|---|---|---|---|---|---|
| ollama:mellum2-12b-instruct-q6 | config-default | 1 | failed | intent | Контракт Intent противоречив после трёх ремонтов: Конфликт приоритетов исчисления dueDays: возможна неоднозначность в значении поля dueDays при отсутствии явной опции и конфига.; Отсутствие явного уточнения поведения при отсутствии опции и конфига — возможно, dueDays будет установлен в 14, но не дошло до тех пор, пока не проверено.; Тест обновления формы счёта с пяти на шесть полей может быть недостаточно для проверки всех сценариев приоритета dueDays. |
| ollama:mellum2-12b-instruct-q6 | config-default | 2 | failed | intent | Контракт Intent противоречив после трёх ремонтов: Конфликт приоритетов инициализации dueDays: в сценарии указано, что источник значения по приоритету: явная опция → конфиг площадки → встроенные 14, но в реализации неясно, как это учитывается при отсутствии явной опции и конфига |
| ollama:mellum2-12b-instruct-q6 | rename-field | 1 | running | — |  |
| ollama:mellum2-12b-instruct-q6 | rename-field | 2 | pending | — |  |
| ollama:gpt-oss-20b-ctx32k | add-validator | 1 | pending | — |  |
| ollama:gpt-oss-20b-ctx32k | add-validator | 2 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | vat-rounding | 1 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | vat-rounding | 2 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | rename-field | 1 | pending | — |  |
| ollama:qwen3.8-27b-iq4-gpumax | rename-field | 2 | pending | — |  |
| ollama:ministral3-14b-instruct-ctx32k | config-default | 1 | pending | — |  |
| ollama:ministral3-14b-instruct-ctx32k | config-default | 2 | pending | — |  |
