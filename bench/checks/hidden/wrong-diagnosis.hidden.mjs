/**
 * Скрытые тесты задачи wrong-diagnosis — обёртка над общим раннером семейства billing-bug.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test wrong-diagnosis.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано; Pr3 —
 * сторож поведения строки без скидки, зелёный по дизайну; H1 на цели без .git пропускается).
 */

process.env.BENCH_EXPECTED_SLUG = 'wrong-diagnosis';
await import('./lib/billing-bug-runner.mjs');
