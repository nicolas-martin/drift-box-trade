import { animate, useMotionValue, useTransform } from "motion/react";
import { useEffect } from "react";

export function usePnlTickerAnimation(target: number) {
	const count = useMotionValue(target);
	const display = useTransform(count, (value) => {
		const rounded = Math.round(value * 100) / 100;
		const prefix = rounded > 0 ? "+" : "";
		return `${prefix}${rounded.toFixed(2)}`;
	});
	const color = useTransform(count, (value) => (value >= 0 ? "#8df0cc" : "#f28383"));

	useEffect(() => {
		const controls = animate(count, target, { duration: 0.6, ease: "easeOut" });
		return () => controls.stop();
	}, [count, target]);

	return { display, color };
}
