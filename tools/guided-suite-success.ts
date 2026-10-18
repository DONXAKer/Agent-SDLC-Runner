type SuiteResult = {
  driver?: { stopped?: unknown };
  finalVerdict?: { passed?: unknown };
  hidden?: { total?: unknown; pass?: unknown; fail?: unknown; skipped?: unknown; errorText?: unknown } | null;
  honesty?: { ok?: unknown }[];
};

/** Один критерий для запуска серии и повторного построения HTML; неполные данные не дают успех. */
export function guidedSuiteSuccess(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const result = value as SuiteResult;
  const hidden = result.hidden;
  return result.driver?.stopped === 'handoff' && result.finalVerdict?.passed === true &&
    typeof hidden?.total === 'number' && Number.isSafeInteger(hidden.total) && hidden.total > 0 &&
    hidden.pass === hidden.total && hidden.fail === 0 && hidden.skipped === 0 && hidden.errorText === null &&
    Array.isArray(result.honesty) && result.honesty.every(check => check?.ok === true || check?.ok === null);
}
