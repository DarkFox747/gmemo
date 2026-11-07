import { describe, it, expect, vi, afterEach } from 'vitest';
import { logNotifier, safeNotify, type Notifier, type NotifyEvent } from '../../src/notify/notifier.js';
import { logger } from '../../src/observability/logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logNotifier', () => {
  it('logs review_enqueued at info with ids/queue/criterion only', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const event: NotifyEvent = {
      type: 'review_enqueued',
      itemId: 'item-1',
      queue: 'mandatory',
      criterion: 'specificity',
    };
    await logNotifier.notify('proj-1', event);
    expect(info).toHaveBeenCalledWith('notify', {
      projectId: 'proj-1',
      type: 'review_enqueued',
      itemId: 'item-1',
      queue: 'mandatory',
      criterion: 'specificity',
    });
  });

  it('logs leak_detected at warn with category names only', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await logNotifier.notify('proj-1', {
      type: 'leak_detected',
      itemId: 'item-2',
      categories: ['aws_access_key'],
    });
    expect(warn).toHaveBeenCalledWith('notify', {
      projectId: 'proj-1',
      type: 'leak_detected',
      itemId: 'item-2',
      categories: ['aws_access_key'],
    });
  });
});

describe('safeNotify', () => {
  const event: NotifyEvent = { type: 'leak_detected', itemId: 'item-3', categories: ['x'] };

  it('delegates to the notifier on success', async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    await safeNotify({ notify }, 'p', event);
    expect(notify).toHaveBeenCalledWith('p', event);
  });

  it('resolves and logs an error (ids only) when the notifier rejects', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const n: Notifier = { notify: () => Promise.reject(new Error('smtp down')) };
    await expect(safeNotify(n, 'p', event)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toBe('notify failed');
    expect(error.mock.calls[0]![1]).toMatchObject({
      event: 'leak_detected',
      projectId: 'p',
      itemId: 'item-3',
    });
  });

  it('resolves and logs when the notifier throws synchronously', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const n: Notifier = {
      notify: () => {
        throw new Error('boom');
      },
    };
    await expect(safeNotify(n, 'p', event)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});
