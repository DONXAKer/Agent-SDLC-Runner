/**
 * Скрытые тесты задачи multi-file-cascade — обёртка над общим раннером семейства ledger.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test multi-file-cascade.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'multi-file-cascade';
await import('./lib/ledger-runner.mjs');
