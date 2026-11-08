import { describe, expect, it } from 'vitest';
import { confidenceTone, thresholdPercent } from './confidence';

describe('confidence', () => {
  it('is ok at or above the threshold and warn below or unknown', () => {
    expect(confidenceTone(0.8, 0.8)).toBe('ok');
    expect(confidenceTone(0.95, 0.8)).toBe('ok');
    expect(confidenceTone(0.7, 0.8)).toBe('warn');
    expect(confidenceTone(null, 0.8)).toBe('warn');
  });

  it('threshold marker is a clamped percentage', () => {
    expect(thresholdPercent(0.8)).toBe(80);
    expect(thresholdPercent(1.5)).toBe(100);
    expect(thresholdPercent(-1)).toBe(0);
  });
});
