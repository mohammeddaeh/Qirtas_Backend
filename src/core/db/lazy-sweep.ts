/**
 * **A read-time sweep, paid once per window instead of on every read**
 * (2026-10-14).
 *
 * Expired orders and overdue print jobs are closed lazily — whoever reads the
 * queue corrects it, so no scheduled job has to be running for the numbers to
 * be right. But every board polls every 30s, so the sweep ran on each poll
 * from each device: one more query each time, and several devices racing to
 * close the same rows and waiting on each other's locks.
 *
 * The wrapper keeps the lazy design and bounds its cost: a call within [gapMs]
 * of the last sweep skips it, and calls that arrive while one runs wait for
 * that one instead of starting their own. A row past its deadline is closed
 * within [gapMs] of someone looking — never later.
 */
export function lazySweep(sweep: () => Promise<unknown>, gapMs: number): () => Promise<void> {
  let last = 0;
  let running: Promise<unknown> | null = null;
  return async () => {
    if (running) {
      await running;
      return;
    }
    if (Date.now() - last < gapMs) return;
    last = Date.now();
    running = sweep().finally(() => {
      running = null;
    });
    await running;
  };
}
