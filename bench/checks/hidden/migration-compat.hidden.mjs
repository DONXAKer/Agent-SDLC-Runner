/**
 * Скрытые тесты задачи migration-compat — обёртка над общим раннером семейства catalog.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test migration-compat.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'migration-compat';
await import('./lib/catalog-runner.mjs');
