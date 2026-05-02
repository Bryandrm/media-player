import { useEffect, useRef, useState } from "react";
import { useUiStore, type View } from "../../stores/uiStore";

const TABS: Array<{ id: View; label: string }> = [
  { id: "library", label: "LIBRARY" },
  { id: "downloads", label: "DOWNLOADS" },
  { id: "visualizer", label: "VISUALIZER" },
];

const PRESS_FLASH_MS = 150;

export function Tabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  // Una sola pressed slot para todos los tabs — el usuario sólo puede
  // pressear uno a la vez. Mismo patrón que `usePressFlash` pero con un
  // discriminador (id del tab) en vez de boolean.
  const [pressedId, setPressedId] = useState<View | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handlePress = (id: View) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setPressedId(id);
    timerRef.current = window.setTimeout(() => {
      setPressedId(null);
      timerRef.current = null;
    }, PRESS_FLASH_MS);
  };

  return (
    <nav className="flex">
      {TABS.map((t) => {
        const active = view === t.id;
        const isPressed = pressedId === t.id;
        const base =
          "px-4 py-2 text-xs font-bold tracking-wider uppercase border-2 -ml-[2px] first:ml-0 transition-colors duration-100 ease-out";
        // Pressed → flash a inversión con borde negro. En tab activa
        // (que ya es blanca) eso significa borde negro destacado; en tab
        // inactiva, flip total. En ambos casos, distinto al hover.
        const variant = isPressed
          ? "bg-fg text-bg border-bg"
          : active
            ? "bg-fg text-bg border-fg"
            : "bg-bg text-fg border-fg hover:bg-accent hover:text-bg hover:border-accent";
        return (
          <button
            key={t.id}
            onPointerDown={() => handlePress(t.id)}
            onClick={() => setView(t.id)}
            className={`${base} ${variant}`}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}
