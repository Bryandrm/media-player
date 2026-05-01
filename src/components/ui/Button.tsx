import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "active";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "sm" | "md";
  variant?: Variant;
};

// Importante: los colores se aplican según `variant`, NO se concatenan con
// utilidades de override en `className`. Tailwind v4 genera las utilidades
// de color en orden alfabético dentro del CSS layer — y `bg-bg` cae después
// de `bg-accent`, así que `bg-bg` siempre ganaba sobre cualquier intento de
// override desde fuera. Acá hacemos el switch *antes* de generar la string
// para que sólo un set de colores quede en el className final.
export function Button({
  size = "md",
  variant = "default",
  className = "",
  ...rest
}: Props) {
  const sizing = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2";
  const colors =
    variant === "active"
      ? "bg-accent text-bg border-accent"
      : "bg-bg text-fg border-fg hover:bg-accent hover:text-bg hover:border-accent";
  const base =
    `border-2 ${sizing} font-bold tracking-wider uppercase ${colors} ` +
    "disabled:text-muted disabled:border-muted disabled:cursor-not-allowed disabled:bg-bg";
  return <button {...rest} className={`${base} ${className}`} />;
}
