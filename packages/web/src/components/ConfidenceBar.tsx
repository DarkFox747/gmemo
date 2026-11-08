import { formatConfidence } from '../lib/format';

/** The bar is decorative (aria-hidden); the number is visible text. */
export function ConfidenceBar({ value, threshold }: { value: number | null; threshold?: number }) {
  const pct = value === null ? 0 : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className={threshold === undefined ? 'confidence' : 'confidence confidence--wide'}>
      <span className="confidence__value">{formatConfidence(value)}</span>
      <span className="confidence__track" aria-hidden="true">
        <span className="confidence__fill" style={{ width: `${pct}%` }} />
      </span>
      {threshold !== undefined && (
        <span className="confidence__threshold">umbral {formatConfidence(threshold)}</span>
      )}
    </span>
  );
}
