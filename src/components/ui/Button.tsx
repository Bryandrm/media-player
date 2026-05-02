import type { ButtonHTMLAttributes, PointerEvent } from "react";
import { usePressFlash } from "../../hooks/usePressFlash";

type Variant = "default" | "active";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "sm" | "md";
  variant?: Variant;
};

// Importante: los colores se aplican según `variant` y `pressed`, NO se
// concatenan con utilidades de override en `className`. Tailwind v4 genera
// las utilidades de color en orden alfabético dentro del CSS layer — y
// `bg-bg` cae después de `bg-accent`, así que `bg-bg` siempre ganaba sobre
// cualquier intento de override desde fuera. Acá hacemos el switch *antes*
// de generar la string para que sólo un set de colores quede en el
// className final.
//
// El press feedback va vía JS (usePressFlash) en vez de CSS `:active` — el
// pseudo-class CSS termina demasiado rápido con tap-to-click de trackpad
// de macOS (~5ms) para ser visible. JS mantiene el flash 150ms siempre.
export function Button({
  size = "md",
  variant = "default",
  className = "",
  onPointerDown: userOnPointerDown,
  ...rest
}: Props) {
  const { pressed, trigger } = usePressFlash();

  const handlePointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    trigger();
    userOnPointerDown?.(e);
  };

  const sizing = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2";

  // Estados visualmente distintos para que `active` no se confunda con
  // `hover` (ambos usaban naranja antes y eran indistinguibles cuando el
  // mouse quedaba sobre un botón toggle):
  //   - default rest   → negro
  //   - default hover  → naranja
  //   - active rest    → blanco con borde negro (mismo patrón que tabs activas)
  //   - active hover   → idem (no override; se queda blanco)
  //   - press flash    → blanco con borde negro (igual que active rest pero
  //                       el flash tiene precedencia + sale durante el click)
  const colors = pressed
    ? "bg-fg text-bg border-bg"
    : variant === "active"
      ? "bg-fg text-bg border-bg"
      : "bg-bg text-fg border-fg hover:bg-accent hover:text-bg hover:border-accent";

  // 100ms ease-out en transition-colors: lo suficiente para que el flash y
  // el hover se vean como transición y no como flicker.
  const base =
    `border-2 ${sizing} font-bold tracking-wider uppercase transition-colors duration-100 ease-out ${colors} ` +
    "disabled:text-muted disabled:border-muted disabled:cursor-not-allowed disabled:bg-bg";

  return (
    <button
      {...rest}
      onPointerDown={handlePointerDown}
      className={`${base} ${className}`}
    />
  );
}
