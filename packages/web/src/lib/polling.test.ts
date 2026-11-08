import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backoffDelay, startPolling } from './polling';
import type { VisibilitySource } from './polling';

function fakeDoc(): VisibilitySource & { hidden: boolean; fire(): void; listeners: number } {
  const set = new Set<() => void>();
  return {
    hidden: false,
    addEventListener: (_t, l) => void set.add(l),
    removeEventListener: (_t, l) => void set.delete(l),
    fire: () => set.forEach((l) => l()),
    get listeners() {
      return set.size;
    },
  };
}

describe('backoffDelay', () => {
  it('doubles per failure and caps at 60 s', () => {
    expect(backoffDelay(5000, 0)).toBe(5000);
    expect(backoffDelay(5000, 1)).toBe(10000);
    expect(backoffDelay(5000, 2)).toBe(20000);
    expect(backoffDelay(5000, 10)).toBe(60000);
  });
});

describe('startPolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ticks every interval while visible', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const stop = startPolling(tick, 5000, fakeDoc());
    await vi.advanceTimersByTimeAsync(15000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
  });

  it('pauses while hidden and refreshes when visible again', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const doc = fakeDoc();
    const stop = startPolling(tick, 5000, doc);
    doc.hidden = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(tick).not.toHaveBeenCalled();
    doc.hidden = false;
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });

  it('cleanup stops ticks and removes the listener', async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    const doc = fakeDoc();
    const stop = startPolling(tick, 5000, doc);
    stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(tick).not.toHaveBeenCalled();
    expect(doc.listeners).toBe(0);
  });

  it('never overlaps ticks while one is pending', async () => {
    let release: () => void = () => undefined;
    const tick = vi.fn(() => new Promise<void>((r) => (release = r)));
    const doc = fakeDoc();
    const stop = startPolling(tick, 5000, doc);
    await vi.advanceTimersByTimeAsync(5000);
    doc.fire(); // visibility change while pending
    await vi.advanceTimersByTimeAsync(30000);
    expect(tick).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(2);
    stop();
  });

  it('backs off after failures, resets on success and reports only the first failure', async () => {
    const onError = vi.fn();
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error('a'))
      .mockRejectedValueOnce(new Error('b'))
      .mockResolvedValue(undefined);
    const stop = startPolling(tick, 5000, fakeDoc(), onError);
    await vi.advanceTimersByTimeAsync(5000); // fail 1 -> next in 10 s
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // fail 2 -> next in 20 s
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20000); // success -> back to 5 s
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls.map((c) => c[1])).toEqual([true, false]);
    stop();
  });
});
