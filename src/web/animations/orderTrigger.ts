import { animate } from "motion";

// Imperative animation for when an order triggers
export function animateOrderTrigger(target: Element | null) {
	if (!target) return;
	try {
		// Snappy pulse with quick overshoot
		animate(target, {
			scale: [1, 1.28, 0.94, 1],
		}, { duration: 0.28, easing: "ease-out" });

		// Flash stroke/fill to highlight trigger
		animate(target as any, {
			stroke: ["#69f", "#ffea00", "#69f"],
			fill: ["rgba(50,160,255,0.18)", "rgba(255,230,100,0.35)", "rgba(50,160,255,0.18)"],
		}, { duration: 0.28, easing: "ease-out" });
	} catch {
		// no-op
	}
}
