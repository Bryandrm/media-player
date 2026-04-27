import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  size?: "sm" | "md";
};

export function Button({ size = "md", className = "", ...rest }: Props) {
  const sizing = size === "sm" ? "px-3 py-1 text-xs" : "px-4 py-2";
  const base =
    `bg-bg text-fg border-2 border-fg ${sizing} font-bold tracking-wider uppercase ` +
    "hover:bg-accent hover:text-bg hover:border-accent " +
    "disabled:text-muted disabled:border-muted disabled:cursor-not-allowed disabled:bg-bg";
  return <button {...rest} className={`${base} ${className}`} />;
}
