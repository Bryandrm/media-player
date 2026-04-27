type Props = {
  /** 0..1; -1 = indeterminado. */
  value: number;
};

// Barra brutalist: 1px border-fg + fill accent. Sin animación de "pulse"
// para indeterminado — sólo dejamos el fill en 100% gris y el label dice "—".
export function ProgressBar({ value }: Props) {
  const indeterminate = value < 0;
  const pct = indeterminate ? 0 : Math.max(0, Math.min(1, value)) * 100;

  return (
    <div className="border-2 border-fg h-3 relative overflow-hidden">
      <div
        className={`h-full ${indeterminate ? "bg-muted" : "bg-accent"}`}
        style={{ width: indeterminate ? "100%" : `${pct}%` }}
      />
    </div>
  );
}
