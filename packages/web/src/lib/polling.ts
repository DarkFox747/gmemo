/**
 * Visibility-aware polling loop. The next tick is scheduled only after the
 * previous one settled (no overlapping requests, so an older response can never
 * land after a newer one). It skips while the tab is hidden, refreshes once as
 * soon as the tab is visible again, and backs off (doubling, capped) after
 * failed ticks. Returns the cleanup that stops everything (call it on unmount).
 */

/** Live-refresh interval for the queue, quarantine list and sidebar badges. */
export const REFRESH_MS = 5000;
export const MAX_BACKOFF_MS = 60_000;

export interface VisibilitySource {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** Delay before the next tick: `ms` doubled per consecutive failure, capped at MAX_BACKOFF_MS. */
export function backoffDelay(ms: number, failures: number): number {
  return Math.min(ms * 2 ** failures, Math.max(ms, MAX_BACKOFF_MS));
}

/**
 * `tick` signals failure by rejecting. `onError` receives the error and whether
 * it is the first of a consecutive run (so callers can log it only once).
 */
export function startPolling(
  tick: () => Promise<unknown> | void,
  ms: number,
  doc: VisibilitySource,
  onError: (err: unknown, first: boolean) => void = () => undefined,
): () => void {
  let stopped = false;
  let inFlight = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => void run(), backoffDelay(ms, failures));
  };

  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    if (doc.hidden) {
      schedule();
      return;
    }
    inFlight = true;
    try {
      await tick();
      failures = 0;
    } catch (err) {
      failures += 1;
      onError(err, failures === 1);
    } finally {
      inFlight = false;
    }
    schedule();
  }

  const onVisibility = (): void => {
    if (!doc.hidden && !inFlight) {
      clearTimeout(timer);
      void run();
    }
  };
  doc.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}
