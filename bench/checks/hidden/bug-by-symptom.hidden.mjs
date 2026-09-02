/**
 * Скрытые тесты задачи bug-by-symptom — обёртка над общим раннером семейства billing-bug.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test bug-by-symptom.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано; Pr3 —
 * сторож неизменности поведения без скидки, зелёный на пристинной по дизайну).
 */

process.env.BENCH_EXPECTED_SLUG = 'bug-by-symptom';
await import('./lib/billing-bug-runner.mjs');
