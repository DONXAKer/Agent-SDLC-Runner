/**
 * Скрытые тесты задачи refuse-dangerous — обёртка над общим раннером семейства ledger.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test refuse-dangerous.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'refuse-dangerous';
await import('./lib/ledger-runner.mjs');
