# Полный guided-цикл с независимой приёмкой

Статус: **stopped**. Завершено: 0/30. Успех: 0.

| Модель | Задача | Статус | Успех | Причина |
|---|---|---|---|---|
| ollama:comparison-qwen-off-q8 | add-validator | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | config-default | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | rename-field | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:comparison-qwen-off-q8 | vat-rounding | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | add-validator | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | config-default | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | rename-field | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:mellum2-12b-instruct-q6 | vat-rounding | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:gpt-oss-20b-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:ministral3-14b-instruct-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | add-validator | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | config-default | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | rename-field | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:devstral-small-2 | vat-rounding | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | add-validator | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | config-default | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | rename-field | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | vat-rounding | pending | неизвестно | неизвестно |

Приёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.

Ошибка: Error: Qualification failed: full matrix withheld; inspect qualifications

## Профили

- ollama:comparison-qwen-off-q8: gpu-only, context=32768
- ollama:mellum2-12b-instruct-q6: gpu-only, context=32768
- ollama:gpt-oss-20b-ctx32k: gpu-only, context=32768
- ollama:ministral3-14b-instruct-ctx32k: gpu-only, context=32768
- ollama:devstral-small-2: hybrid, context=16384
- ollama:comparison-neohorse: gpu-only, context=32768

Время hybrid нельзя напрямую сравнивать с gpu-only.

## Квалификация протокола

- ollama:comparison-qwen-off-q8: PASS, 8/8; 
- ollama:mellum2-12b-instruct-q6: PASS, 8/8; 
- ollama:gpt-oss-20b-ctx32k: FAIL, 7/8; Error: protocol or semantics mismatch
- ollama:ministral3-14b-instruct-ctx32k: PASS, 8/8; 
- ollama:devstral-small-2: PASS, 8/8; 
- ollama:comparison-neohorse: FAIL, 6/8; Error: protocol or semantics mismatch; Error: protocol or semantics mismatch
