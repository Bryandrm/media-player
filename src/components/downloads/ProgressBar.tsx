type Props = {
  /** 0..1; -1 = indeterminado. */
  value: number;
};

// Barra brutalist: 2px border-fg.
// - Determinado (download): fill accent ancho proporcional al fraction.
// - Indeterminado (converting): bloque accent de 1/3 barriéndose en loop
//   (clase `.progress-indeterminate` definida en tokens.css).
export function ProgressBar({ value }: Props) {
  const indeterminate = value < 0;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, value)) * 100;

  return (
    <div className="border-2 border-fg h-3 relative overflow-hidden">
      {indeterminate ? (
        <div className="progress-indeterminate" />
      ) : (
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      )}
    </div>
  );
}
