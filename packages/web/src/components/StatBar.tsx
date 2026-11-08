import { barPercent } from '../lib/insights';

export type StatTone = 'ok' | 'warn' | 'danger' | 'neutral';

/**
 * Label + visible number + decorative proportional bar (aria-hidden), like
 * ConfidenceBar: the width is set through CSSOM (CSP-safe), the number is text.
 */
export function StatBar({
  label,
  value,
  max,
  tone = 'ok',
}: {
  label: string;
  value: number;
  max: number;
  tone?: StatTone;
}) {
  return (
    <div className="stat-bar">
      <span className="stat-bar__label">{label}</span>
      <span className="stat-bar__value">{value}</span>
      <span className="stat-bar__track" aria-hidden="true">
        <span
          className={`stat-bar__fill stat-bar__fill--${tone}`}
          style={{ width: `${barPercent(value, max)}%` }}
        />
      </span>
    </div>
  );
}
