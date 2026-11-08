/**
 * Loading/ready/error state for one async read. Stale responses (after the
 * deps changed or the component unmounted) are ignored; errors are logged for
 * the developer and returned for an inline message.
 */

import { useCallback, useEffect, useState } from 'react';
import type { DependencyList } from 'react';

export type AsyncState<T> =
  | { status: 'loading'; data?: undefined; error?: undefined }
  | { status: 'ready'; data: T; error?: undefined }
  | { status: 'error'; data?: undefined; error: unknown };

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: DependencyList,
): AsyncState<T> & { reload(): void } {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fn().then(
      (data) => {
        if (!cancelled) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (cancelled) return;
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
