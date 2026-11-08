import { DEFAULT_THRESHOLD, confidenceTone, thresholdPercent } from '../lib/confidence';
import { formatConfidence } from '../lib/format';

/**
 * The bar is decorative (aria-hidden); the number is visible text. The marker
 * shows the judge threshold (0.80 when the API does not send one, e.g. queue rows);
 * green at or above it, amber below.
 */
export function ConfidenceBar({
  value,
  threshold = DEFAULT_THRESHOLD,
  wide = false,
}: {
  value: number | null;
  threshold?: number;
  wide?: boolean;
}) {
  const pct = value === null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = confidenceTone(value, threshold);
  return (
    <span className={wide ? 'confidence confidence--wide' : 'confidence'}>
      <span className="confidence__value">{formatConfidence(value)}</span>
      <span className="confidence__track" aria-hidden="true">
        <span
          className={`confidence__fill confidence__fill--${tone}`}
          style={{ width: `${pct}%` }}
        />
        <span className="confidence__marker" style={{ left: `${thresholdPercent(threshold)}%` }} />
      </span>
      {wide && <span className="confidence__threshold">umbral {formatConfidence(threshold)}</span>}
    </span>
  );
}
