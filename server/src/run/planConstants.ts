/**
 * Числовые константы плана против фактического diff'а попытки.
 *
 * Узкая проверка на конкретный класс отказа, пойманный живым прогоном
 * (`docs/model-runs.md`, серия r33, `qwen3-coder-30b-a3b` на фикстуре bench): модель
 * проигнорировала явно названные в `plan.md` пороги и ставки (`LONGEST_SIDE_LIMIT_CM = 120`,
 * `SIDE_SURCHARGE_PCT = 40`, …) и придумала свои (`OVERSIZE_THRESHOLD_CM = 100`,
 * `OVERSIZE_ADDEND_PCT = 20`). Собственные тесты под собственную выдумку зеленеют, не
 * доказывая ничего о реальной задаче — а исполнитель именно так и решил, что закончил.
 *
 * Ловит только план, называющий константу форматом `` `ИМЯ = число` `` — этой же формой
 * план и сам эталон методологии описывают пороги/ставки в тексте шагов. Молчит на любом
 * другом формате: недобор безопаснее перебора для предупреждения, которое оператор видит
 * в панели и может перестать замечать, если оно шумит по каждому прогону.
 */

const CONST_RE = /`([A-Z][A-Z0-9_]*)\s*=\s*(-?\d+(?:\.\d+)?)`/g;

/**
 * Возвращает готовые к показу строки расхождений — пусто, если план не называет ни одной
 * константы в распознанном формате, либо все они нашлись в diff'е с тем же числом.
 */
export function planConstantsMissingFromDiff(planText: string, diffText: string): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const m of planText.matchAll(CONST_RE)) {
    const name = m[1]!;
    const expected = m[2]!;
    // План не называет одно и то же имя разными числами дважды — берём первое упоминание.
    if (seen.has(name)) continue;
    seen.add(name);

    const inDiff = new RegExp(`\\b${name}\\b\\s*[=:]\\s*(-?\\d+(?:\\.\\d+)?)`).exec(diffText);
    if (inDiff === null) {
      problems.push(`план называет «${name} = ${expected}», в diff'е этого имени нет вовсе`);
    } else if (inDiff[1] !== expected) {
      problems.push(`план называет «${name} = ${expected}», в diff'е «${name} = ${inDiff[1]}»`);
    }
  }
  return problems;
}
