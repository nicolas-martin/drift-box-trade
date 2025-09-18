"use client";

import { motion } from "motion/react";
import { type CSSProperties } from "react";
import { usePerpPnl } from "@/web/hooks/usePerpPnl";
import { usePnlTickerAnimation } from "@/web/animations/usePnlTickerAnimation";

const baseStyle: CSSProperties = {
	fontSize: 64,
	fontFamily: "var(--font-mono, monospace)",
	margin: 0,
	lineHeight: 1,
};

const labelStyle: CSSProperties = {
	fontSize: 14,
	letterSpacing: 2,
	color: '#97a2b3',
	textTransform: 'uppercase',
	marginBottom: 4,
	display: 'inline-block',
};

export function PnlTicker() {
	const { pnlUsd, hasPosition } = usePerpPnl();
	const target = hasPosition ? pnlUsd : 0;
	const { display, color } = usePnlTickerAnimation(target);

	return (
		<div style={{ textAlign: 'right' }}>
			<span style={labelStyle}>PNL (USD)</span>
			<motion.pre style={{ ...baseStyle, color }}>
				{hasPosition ? display : "--"}
			</motion.pre>
		</div>
	);
}
