/**
 * Скрытые тесты задачи undo-feature — обёртка над общим раннером семейства feature-present.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test undo-feature.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision/human красные — так задумано:
 * фича на месте, отчёт считает 7%, report.ts импортирует ./loyalty).
 */

process.env.BENCH_EXPECTED_SLUG = 'undo-feature';
await import('./lib/feature-present-runner.mjs');
