import { usePlayerStore, EQ_GAIN_RANGE_DB } from "../../stores/playerStore";
import { EQ_BAND_FREQS } from "../../audio/context";
import { Button } from "../ui/Button";

// 10-band EQ. Layout: bypass toggle + reset arriba, 10 sliders verticales
// abajo, cada uno con label de frecuencia + gain actual. Estándar
// foobar/winamp con ±12dB.
//
// Decisión brutalist: sin presets pre-armados ("rock", "pop"). El usuario
// arma su preset o lo deja flat. Presets predefinidos contradicen el
// principio de "el usuario sabe qué quiere" y agregan UI cosmética.

function formatFreq(hz: number): string {
  if (hz >= 1000) {
    // 1000 → 1K, 2000 → 2K, 16000 → 16K. Brutalist: sin punto decimal.
    return `${Math.round(hz / 1000)}K`;
  }
  return `${hz}`;
}

function formatGain(db: number): string {
  if (Math.abs(db) < 0.05) return "0";
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)}`;
}

export function EqualizerView() {
  const eqGains = usePlayerStore((s) => s.eqGains);
  const eqEnabled = usePlayerStore((s) => s.eqEnabled);
  const setEqGain = usePlayerStore((s) => s.setEqGain);
  const setEqEnabled = usePlayerStore((s) => s.setEqEnabled);
  const resetEq = usePlayerStore((s) => s.resetEq);

  // Cantidad de tracks "tocados" (banda con gain != 0) — útil para mostrar
  // un hint si el usuario tiene EQ off pero con preset cargado.
  const activeBands = eqGains.filter((g) => Math.abs(g) > 0.05).length;

  return (
    <div className="h-full flex flex-col">
      {/* Header / controles */}
      <div className="shrink-0 px-6 py-3 border-b-2 border-fg flex items-center gap-4 text-xs uppercase tracking-wider">
        <span className="font-bold">EQUALIZER</span>
        <span className="text-muted">10-BAND · ±{EQ_GAIN_RANGE_DB}DB</span>

        <div className="ml-auto flex items-center gap-2">
          {!eqEnabled && activeBands > 0 && (
            <span className="text-muted">
              {activeBands} BAND{activeBands === 1 ? "" : "S"} SAVED · BYPASSED
            </span>
          )}
          <Button
            size="sm"
            variant={eqEnabled ? "active" : "default"}
            onClick={() => setEqEnabled(!eqEnabled)}
          >
            {eqEnabled ? "ON" : "BYPASS"}
          </Button>
          <Button size="sm" onClick={resetEq}>
            RESET
          </Button>
        </div>
      </div>

      {/* Bandas */}
      <div className="flex-1 min-h-0 flex items-stretch justify-center px-8 py-6">
        <div className="flex items-stretch gap-6 max-w-4xl w-full">
          {/* Eje de dB a la izquierda (referencia visual) */}
          <div className="flex flex-col justify-between text-[10px] text-muted py-2 tabular-nums shrink-0">
            <span>+{EQ_GAIN_RANGE_DB}</span>
            <span>0</span>
            <span>-{EQ_GAIN_RANGE_DB}</span>
          </div>

          {EQ_BAND_FREQS.map((freq, i) => {
            const gain = eqGains[i] ?? 0;
            return (
              <div
                key={freq}
                className="flex-1 flex flex-col items-center justify-between gap-2"
              >
                {/* Display de gain actual arriba */}
                <div
                  className={`text-[10px] tabular-nums w-full text-center ${
                    Math.abs(gain) > 0.05 ? "text-accent" : "text-muted"
                  }`}
                >
                  {formatGain(gain)}
                </div>

                {/* Slider vertical. min/max invertidos por writing-mode:rtl
                    — el thumb arriba = max value, abajo = min. */}
                <input
                  type="range"
                  min={-EQ_GAIN_RANGE_DB}
                  max={EQ_GAIN_RANGE_DB}
                  step={0.5}
                  value={gain}
                  onChange={(e) => setEqGain(i, parseFloat(e.target.value))}
                  onDoubleClick={() => setEqGain(i, 0)}
                  className="range-brutal-vert flex-1"
                  // title para que el usuario descubra el reset por doble click.
                  title="DOUBLE-CLICK TO RESET TO 0"
                  disabled={!eqEnabled}
                />

                {/* Label de frecuencia abajo */}
                <div className="text-[10px] text-fg tabular-nums w-full text-center">
                  {formatFreq(freq)}
                  <span className="text-muted">
                    {freq >= 1000 ? "" : "Hz"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer con hint discreto */}
      <div className="shrink-0 px-6 py-2 border-t-2 border-fg text-[10px] text-muted uppercase tracking-wider flex items-center justify-between">
        <span>DOUBLE-CLICK A SLIDER TO RESET ITS BAND TO 0</span>
        <span>EQ APPLIES POST-MIX · VISUALIZER UNAFFECTED</span>
      </div>
    </div>
  );
}
