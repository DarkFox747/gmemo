/** Confidence vs the judge threshold (the API sends the threshold in review detail). */

export const DEFAULT_THRESHOLD = 0.8;

export type ConfidenceTone = 'ok' | 'warn';

export function confidenceTone(confidence: number | null, threshold: number): ConfidenceTone {
  return confidence !== null && confidence >= threshold ? 'ok' : 'warn';
}

/** Position of the threshold marker on the 0-100 % track (clamped). */
export function thresholdPercent(threshold: number): number {
  return Math.round(Math.min(1, Math.max(0, threshold)) * 100);
}
