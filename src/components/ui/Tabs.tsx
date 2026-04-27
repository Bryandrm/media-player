import { useUiStore, type View } from "../../stores/uiStore";

const TABS: Array<{ id: View; label: string }> = [
  { id: "library", label: "LIBRARY" },
  { id: "downloads", label: "DOWNLOADS" },
  { id: "visualizer", label: "VISUALIZER" },
];

export function Tabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <nav className="flex">
      {TABS.map((t) => {
        const active = view === t.id;
        const base =
          "px-4 py-2 text-xs font-bold tracking-wider uppercase border-2 border-fg -ml-[2px] first:ml-0";
        const variant = active
          ? "bg-fg text-bg"
          : "bg-bg text-fg hover:bg-accent hover:text-bg hover:border-accent";
        return (
          <button
            key={t.id}
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
