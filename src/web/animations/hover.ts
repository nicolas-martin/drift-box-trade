import { animate } from "motion";

export function animateHoverEnter(rectEl: Element | null, textEl?: Element | null) {
	if (!rectEl) return;
	try {
		// Ensure transforms feel centered on the rect box
		(rectEl as HTMLElement).style.transformBox = 'fill-box';
		(rectEl as HTMLElement).style.transformOrigin = 'center';
		(rectEl as HTMLElement).style.willChange = 'transform, opacity';
		animate(rectEl, { opacity: [0, 1], scale: [0.95, 1] }, { duration: 0.18, easing: 'ease-out' });
		if (textEl) animate(textEl, { opacity: [0, 1] }, { duration: 0.18, easing: 'ease-out' });
	} catch { /* noop */ }
}

export function animateHoverExit(rectEl: Element | null, textEl?: Element | null) {
	if (!rectEl) return;
	try {
		animate(rectEl, { opacity: [1, 0] }, { duration: 0.12, easing: 'ease-in' });
		if (textEl) animate(textEl, { opacity: [1, 0] }, { duration: 0.12, easing: 'ease-in' });
	} catch { /* noop */ }
}

