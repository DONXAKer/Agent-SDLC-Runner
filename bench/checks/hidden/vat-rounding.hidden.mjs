/**
 * Скрытые тесты задачи vat-rounding — обёртка над общим раннером семейства billing.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test vat-rounding.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'vat-rounding';
await import('./lib/billing-runner.mjs');
