import { animate } from "motion";

// Imperative animation for when an order expires
// Returns a Promise that resolves when the animation finishes
export function animateOrderExpire(target: Element | null): Promise<void> {
  return new Promise((resolve) => {
    if (!target) return resolve();
    try {
      const controls = animate(target, {
        y: [-2, -8],
        scale: [1, 0.9],
        opacity: [1, 0],
      }, { duration: 0.26, easing: "ease-in" });
      // Quick dim of color as it fades
      animate(target as any, {
        fill: ["rgba(50,160,255,0.18)", "rgba(50,160,255,0.05)"],
        stroke: ["#69f", "#457"],
      }, { duration: 0.26, easing: "ease-in" });
      controls.finished.finally(() => resolve());
    } catch {
      resolve();
    }
  });
}
