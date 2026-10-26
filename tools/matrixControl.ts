/** Cancellation and fail-fast share one synchronous boundary before every spawn. */
export class MatrixControl {
  private readonly aborter = new AbortController();
  firstFailure: string | undefined;
  private readonly stopOnFailure: boolean;
  constructor(stopOnFailure = false) { this.stopOnFailure = stopOnFailure; }
  get signal(): AbortSignal { return this.aborter.signal; }
  cancel(): void { this.aborter.abort(new Error('Matrix cancelled')); }
  complete(cell: { id: string; status: string; outcome?: { success: boolean } }): void {
    if (this.stopOnFailure && cell.status === 'complete' && cell.outcome?.success !== true) this.firstFailure ??= cell.id;
  }
  assertMayStart(): void {
    this.signal.throwIfAborted();
    if (this.firstFailure) throw new Error(`Control failed at cell ${this.firstFailure}`);
  }
  async request(host: string, path: string, data?: unknown, timeout = 10000): Promise<unknown> {
    this.assertMayStart();
    const response = await fetch(host + path, { ...(data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }), signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeout)]) });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }
}
