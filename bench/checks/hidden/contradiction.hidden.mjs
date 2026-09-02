/**
 * Скрытые тесты задачи contradiction — обёртка над общим раннером семейства ledger.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test contradiction.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'contradiction';
await import('./lib/ledger-runner.mjs');
