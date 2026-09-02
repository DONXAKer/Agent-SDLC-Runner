/**
 * Скрытые тесты задачи impossible-without-data — обёртка над общим раннером семейства warehouse.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test impossible-without-data.hidden.mjs`; без
 * переменной цель — пристинная фикстура (regression зелёные, human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'impossible-without-data';
await import('./lib/warehouse-runner.mjs');
