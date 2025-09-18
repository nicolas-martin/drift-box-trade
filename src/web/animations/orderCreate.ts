import { animate } from "motion";

// Imperative animation for when an order cell is created
// Can be swapped to a React-based animation easily without touching callers
export function animateOrderCreate(target: Element | null) {
  if (!target) return;
  try {
    // Fast arcade pop with a quick glow
    animate(target, {
      opacity: [0, 1],
      scale: [0.6, 1.15, 1],
    }, { duration: 0.22, easing: "ease-out" });

    // Brief color flash for excitement
    animate(target as any, {
      stroke: ["#69f", "#6ef", "#69f"],
      fill: ["rgba(50,160,255,0.10)", "rgba(120,210,255,0.32)", "rgba(50,160,255,0.18)"],
    }, { duration: 0.22, easing: "ease-out" });
  } catch {
    // no-op
  }
}
