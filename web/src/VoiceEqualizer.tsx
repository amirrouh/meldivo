import { useEffect, useRef } from "react";

// The five bars inside the voice shape: they jump like an equalizer while someone is talking,
// sweep in a wave while the agent works, and breathe slowly while it listens. Bars are resized
// around their centre (not scaled) so their rounded ends keep their shape.

const BARS = [
  { x: 353, y: 653, w: 78, h: 139 },
  { x: 464, y: 577, w: 86, h: 288 },
  { x: 584, y: 493, w: 86, h: 430 },
  { x: 704, y: 577, w: 86, h: 288 },
  { x: 823, y: 653, w: 78, h: 139 },
];

const WAVE_MS: Record<string, number> = { loading: 160, running: 200, thinking: 320 };

export function VoiceEqualizer({ state, level }: { state: string; level: number }) {
  const bars = useRef<(SVGRectElement | null)[]>([]);
  const live = useRef({ state, level });
  live.current = { state, level };

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const bands = BARS.map(() => ({ value: 0.35, target: 0.35, next: 0 }));
    let frame = 0;
    const draw = (t: number) => {
      const { state, level } = live.current;
      const talking = state === "speaking" || state === "hearing";
      BARS.forEach((bar, i) => {
        let size: number;
        if (reduced) size = 0.8;
        else if (talking) {
          const band = bands[i]!;
          if (t > band.next) {
            band.target = 0.35 + Math.random() * (0.3 + level * 0.8);
            band.next = t + 60 + Math.random() * 110;
          }
          band.value += (band.target - band.value) * (band.target > band.value ? 0.55 : 0.18);
          size = band.value;
        } else if (WAVE_MS[state]) size = 0.55 + 0.4 * Math.max(0, Math.sin(t / WAVE_MS[state]! - i * 0.9));
        else if (state === "muted" || state === "error") size = 0.35;
        else size = 0.8 + 0.12 * Math.sin(t / 700 + i * 0.8);
        const height = Math.max(bar.w, bar.h * Math.min(1.15, Math.max(0.3, size)));
        const rect = bars.current[i];
        if (rect) {
          rect.setAttribute("height", height.toFixed(1));
          rect.setAttribute("y", (bar.y + (bar.h - height) / 2).toFixed(1));
        }
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <svg className="voice-shape__bars" viewBox="340 440 574 540" aria-hidden="true">
    {BARS.map((bar, i) => <rect
      key={i}
      ref={(el) => { bars.current[i] = el; }}
      x={bar.x} y={bar.y} width={bar.w} height={bar.h} rx={bar.w / 2}
    />)}
  </svg>;
}
