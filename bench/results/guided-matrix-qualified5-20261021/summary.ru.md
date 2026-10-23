# Полный guided-цикл с независимой приёмкой

Статус: **stopped**. Завершено: 0/25. Успех: 0.

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
| ollama:granite4.2-8b-ctx32k | add-validator | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | config-default | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | rename-field | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:granite4.2-8b-ctx32k | vat-rounding | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | add-validator | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | config-default | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | rename-field | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | idempotent-retry | pending | неизвестно | неизвестно |
| ollama:comparison-neohorse | vat-rounding | pending | неизвестно | неизвестно |

Приёмочные тесты подготовлены до реализации и выполняются в Docker без сети. Скрытый оценщик выполняется отдельно. Решения оператора автоматизированы стендом. Один повтор; окна и параметры моделей сохранены в манифесте, различия конфигураций ограничивают сравнение. Остановка до Verify не считается проверкой Verify.

Ошибка: Error: Qualification failed: full matrix withheld; inspect qualifications Cleanup: Error: Command failed: taskkill /PID 63696 /T /F

## Профили

- ollama:comparison-qwen-off-q8: gpu-only, context=32768
- ollama:mellum2-12b-instruct-q6: gpu-only, context=32768
- ollama:gpt-oss-20b-ctx32k: gpu-only, context=32768
- ollama:granite4.2-8b-ctx32k: gpu-only, context=32768
- ollama:comparison-neohorse: gpu-only, context=32768

Время hybrid нельзя напрямую сравнивать с gpu-only.

## Квалификация протокола

- ollama:comparison-qwen-off-q8: PASS, 8/8; 
- ollama:mellum2-12b-instruct-q6: PASS, 8/8; 
- ollama:gpt-oss-20b-ctx32k: FAIL, 7/8; Error: protocol or semantics mismatch
- ollama:granite4.2-8b-ctx32k: PASS, 8/8; 
- ollama:comparison-neohorse: PASS, 8/8; 
