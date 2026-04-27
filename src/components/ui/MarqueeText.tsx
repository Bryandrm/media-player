import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

type Props = {
  text: string;
  className?: string;
};

/*
 * Texto en una sola línea con marquesina en hover.
 * - Si el texto entra: trunca con ellipsis, sin animación.
 * - Si no entra: deja la primera porción visible y al hacer hover, scrollea
 *   horizontalmente hasta el final, espera, y vuelve. El `--marquee-distance`
 *   se calcula con `scrollWidth - clientWidth` y se re-mide cada vez que el
 *   contenedor cambia de tamaño (window resize, split del visualizer, etc.).
 */
export function MarqueeText({ text, className = "" }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;

    const measure = () => {
      const overflow = inner.scrollWidth - wrap.clientWidth;
      setDistance(overflow > 0 ? overflow : 0);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(wrap);
    return () => obs.disconnect();
  }, [text]);

  const overflows = distance > 0;

  return (
    <div
      ref={wrapRef}
      className={`overflow-hidden whitespace-nowrap ${overflows ? "marquee-host" : ""} ${className}`}
      style={
        overflows
          ? ({
              "--marquee-distance": `${distance}px`,
              // Duración proporcional a la distancia: textos largos toman más
              // tiempo en deslizarse. Mínimo 4s.
              "--marquee-duration": `${Math.max(4, distance * 0.025)}s`,
            } as CSSProperties)
          : undefined
      }
      title={text}
    >
      <span
        ref={innerRef}
        className={overflows ? "marquee-inner" : "block truncate"}
      >
        {text}
      </span>
    </div>
  );
}
