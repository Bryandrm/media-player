import { convertFileSrc } from "@tauri-apps/api/core";

type Props = {
  path: string | null | undefined;
  size?: "sm" | "md";
};

// Cuadrado brutalist con borde fg de 2px. Si hay path, mostramos la imagen
// con `loading="lazy"` y `object-cover` para no deformar el aspect ratio.
// Si no hay, queda un cuadrado negro con un símbolo "·" muteado al centro
// como placeholder — sin dejar el espacio en blanco que rompe el balance.
export function CoverArt({ path, size = "md" }: Props) {
  const dim = size === "sm" ? "w-10 h-10" : "w-16 h-16";

  return (
    <div
      className={`${dim} border-2 border-fg bg-bg flex items-center justify-center shrink-0 overflow-hidden`}
    >
      {path ? (
        <img
          src={convertFileSrc(path)}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover block"
        />
      ) : (
        <span className="text-muted text-2xl leading-none">·</span>
      )}
    </div>
  );
}
