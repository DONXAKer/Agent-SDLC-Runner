/**
 * Маршрут независимого скана ревью этапа 6 и право его находок ронять вердикт.
 *
 * Норма verify (`server/methodology/guided.md`, редизайн 2026-10-05/06): модельное ревью
 * той же моделью, что исполнитель, уровнем вердикта НЕ является — вердикт считает
 * рантайм из гейтов этапа, скрытых тестов (в бенче), проверок честности и сверки diff
 * с деревом. Блокирующими могут быть только находки рецензента, чей `provider:model`
 * отличается от исполнителя (маршрута этапа chunk): отдельный `reviewModel` в конфиге
 * раннера либо маршрут этапа verify, назначенный на другую модель. Находки скана той же
 * моделью принимаются в отчёт, но помечаются advisory и вердикт не роняют.
 */

import type { ModelsConfig, ResolvedRoute } from '../config/schema.ts';
import { resolveReviewRoute } from '../config/profiles.ts';

/** Ключ сравнения маршрутов — ровно `provider:model`, как `guided.modelId`. */
export function routeKey(r: { provider: string; model: string }): string {
  return `${r.provider}:${r.model}`;
}

export interface ReviewScanDecision {
  /** Маршрут независимого скана этапа 6 (и ревью проработки этапа 4). */
  route: ResolvedRoute;
  /**
   * `true` — рецензент не совпадает с исполнителем, и его подтверждённые находки
   * роняют вердикт (прежнее поведение). `false` — скан выполняется той же моделью,
   * что исполнитель: находки справочные (advisory), видны в отчёте, вердикт не роняют.
   */
  blocking: boolean;
}

/**
 * Скан идёт по `reviewModel` из конфига раннера, если он задан; иначе — по маршруту
 * этапа verify, как прежде. Блокирующим скан остаётся, только пока его модель — не
 * исполнитель: саморевью уровнем вердикта не является ни при какой конфигурации.
 *
 * Неизвестный id `reviewModel` — ошибка, а не откат на маршрут этапа: рецензент «не
 * той» модели хуже отказа. При штатной загрузке это проверено раньше, в `loadConfig`;
 * здесь страховка для витков, собранных в обход неё (тесты, ad-hoc профили).
 */
export function decideReviewScan(input: {
  reviewModelId: string | undefined;
  models: ModelsConfig;
  executor: { provider: string; model: string };
  verifyRoute: ResolvedRoute;
}): ReviewScanDecision {
  const route =
    input.reviewModelId === undefined
      ? input.verifyRoute
      : resolveReviewRoute(input.models, input.reviewModelId);
  return { route, blocking: routeKey(route) !== routeKey(input.executor) };
}
