export interface FilterOption<K extends string> {
  key: K;
  label: string;
}

/** Pill buttons; the selected one has aria-pressed=true. */
export function FilterBar<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<FilterOption<K>>;
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="filters" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className="pill"
          aria-pressed={o.key === value}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
