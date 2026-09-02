/**
 * Скрытые тесты задачи ghost-requirement — обёртка над общим раннером семейства warehouse.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test ghost-requirement.hidden.mjs`; без
 * переменной цель — пристинная фикстура (regression зелёные, human красные — так задумано).
 */

process.env.BENCH_EXPECTED_SLUG = 'ghost-requirement';
await import('./lib/warehouse-runner.mjs');
