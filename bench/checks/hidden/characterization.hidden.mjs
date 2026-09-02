/**
 * Скрытые тесты задачи characterization — обёртка над общим раннером семейства legacy-docs.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test characterization.hidden.mjs`; без переменной
 * цель — пристинная фикстура (regression зелёные, precision красные — так задумано; Pr2 —
 * «набор цели зелёный» — зелёный и на пристинной по дизайну, см. комментарий в эталоне).
 */

process.env.BENCH_EXPECTED_SLUG = 'characterization';
await import('./lib/legacy-docs-runner.mjs');
