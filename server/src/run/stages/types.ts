/**
 * Типы декларации этапов витка — общие для модулей этапов, реестра и сборки промпта.
 *
 * Отдельным файлом без значений: `prompt/build.ts` берёт отсюда типы, не подтягивая модули
 * этапов, а те — рантайм витка. Иначе импорт промпта замыкал бы цикл модулей.
 */

import type { ArtifactKey, WitokPaths } from '../../artifacts/paths.ts';
import type { StageId, ToolName } from '@sdlc-runner/shared';

export interface StageContext {
  paths: WitokPaths;
  /** Номер chunk'а витка, с 1. */
  chunk: number;
  /** Номер попытки текущего chunk'а, с 1. */
  attempt: number;
}

export interface Precondition {
  /** Что требуется — показывается оператору как есть. */
  describe: string;
  /** `null` — выполнено; строка — причина, по которой этап не начинается. */
  check: (c: StageContext) => string | null;
  /**
   * Артефакт, который проверяет условие, — по нему называется этап-виновник
   * (`stageProducing`). Без него «этап не стартовал» читался провалом этого этапа, хотя
   * завалил его артефакт ПРЕДЫДУЩЕГО, помеченного `ok` (8 из 25 прогонов серии v4).
   * Зовётся только для проваленного условия; `null` — вину не несёт этап-производитель
   * (например, недостаёт решения человека, а форма цела).
   */
  artifact?: (c: StageContext) => string | null;
}

export interface StageDef {
  id: StageId;
  /** Каталог скилла в `runner.skillsDir`, откуда берётся тело системного промпта. */
  skill: string;
  title: string;
  tools: readonly ToolName[];
  /** Субагенты, которых методология требует именно на этом этапе. */
  subagents: readonly string[];
  produces: (c: StageContext) => string[];
  requires: readonly Precondition[];
  /**
   * Артефакты, которые агент не вправе переписывать на этом этапе: решения человека и
   * конфигурация процесса. Агент, который может переписать одобренный план, может снять
   * с себя любое ограничение.
   */
  protectedArtifacts: (c: StageContext) => string[];
  /**
   * Поле решения человека, без которого следующий этап не начинается.
   *
   * Артефакт назван ключом, а не путём: тот же ключ приходит из интерфейса, когда
   * оператор записывает решение, и путь по нему собирает рантайм.
   */
  humanGate: { artifact: ArtifactKey; label: string } | null;
  /** Причина пропустить этап, либо `null`. */
  skipIf: ((c: StageContext) => string | null) | null;
}

export interface StageInput {
  path: string;
  /** Необязательный вход: отсутствие файла не мешает этапу. */
  optional: boolean;
}

export interface PreconditionProblem {
  text: string;
  /** Путь артефакта, завалившего условие; `null` — условие не привязано к артефакту. */
  artifact: string | null;
}

export interface PreconditionReport {
  ok: boolean;
  /** Причины, по которым этап не начинается. Собираются все сразу. */
  problems: string[];
  /** Те же причины с артефактом каждой — для называния этапа-виновника. */
  details: PreconditionProblem[];
  /** Причина пропустить этап, если он условный. */
  skip: string | null;
}

export interface PreconditionOptions {
  /** Оператор объявил обрыв витка: handoff оформляет передачу без зелёного вердикта. */
  abortHandoff?: boolean;
  /**
   * Считать ли артефакт каждой причины (`details[].artifact`). У `granted` это второе чтение
   * файла, а GET-опрос витка виновника не показывает — `false` там экономит чтение.
   */
  withArtifacts?: boolean;
}
