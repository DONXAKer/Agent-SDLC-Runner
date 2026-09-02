/**
 * Скрытые тесты задачи already-done — обёртка над общим раннером семейства feature-present.
 * Запуск: `BENCH_TARGET_DIR=<дерево> node --test already-done.hidden.mjs`; без переменной
 * цель — пристинная фикстура: regression зелёные ПО ДИЗАЙНУ (фича уже есть — меряется
 * отсутствие лишнего), precision (дерево не тронуто) на цели без .git ПРОПУСКАЮТСЯ, не
 * краснеют — единственная задача бенчмарка с таким раскладом, см. expected/already-done.json.
 */

process.env.BENCH_EXPECTED_SLUG = 'already-done';
await import('./lib/feature-present-runner.mjs');
