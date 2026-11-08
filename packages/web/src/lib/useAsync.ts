/**
 * Loading/ready/error state for one async read. Stale responses (after the
 * deps changed or the component unmounted) are ignored; errors are logged for
 * the developer and returned for an inline message.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList } from 'react';
import { startPolling } from './polling';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: DependencyList,
  /** Silent background refresh (no loading flash, errors keep the last data); paused while the tab is hidden. */
  refreshMs?: number,
): AsyncState<T> & { reload(): void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // Only the newest request may write state (initial/reload fetch vs. background refresh).
  const seq = useRef(0);

  useEffect(() => {
    if (refreshMs === undefined) return;
    let cancelled = false;
    const stop = startPolling(
      async () => {
        const mine = ++seq.current;
        const data = await fnRef.current();
        if (!cancelled && mine === seq.current) setState({ status: 'ready', data });
      },
      refreshMs,
      document,
      // Keep showing the last good data; polling backs off and retries. Log only the first failure.
      (error, first) => {
        if (first) console.error('[web] background refresh failed', error);
      },
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [...deps, tick, refreshMs]);

  useEffect(() => {
    let cancelled = false;
    const mine = ++seq.current;
    setState({ status: 'loading' });
    fn().then(
      (data) => {
        if (!cancelled && mine === seq.current) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (cancelled || mine !== seq.current) return;
        console.error('[web] request failed', error);
        setState({ status: 'error', error });
      },
    );
    return () => {
      cancelled = true;
    };
    // fn is recreated each render; the caller's deps decide when to refetch.
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
