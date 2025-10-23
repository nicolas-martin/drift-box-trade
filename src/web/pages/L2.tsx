import * as d3 from "d3";
import { useEffect, useRef } from "react";
// Use direct WebSocket to Hermes to avoid Node Buffer polyfill issues
import { startHermesPriceStream } from "@/web/utils/hermesPriceStream";
import { animateOrderCreate } from "@/web/animations/orderCreate";
import { animateOrderTrigger } from "@/web/animations/orderTrigger";
import { animateOrderExpire } from "@/web/animations/orderExpire";
import { animateHoverEnter, animateHoverExit } from "@/web/animations/hover";
import { emitOrderEvent } from "@/web/events/orderBus";
const SOL_USD_FEED_ID =
	"0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d"; // SOL/USD
export type OrderStatus = "pending" | "triggered" | "expired";

export interface Config {
	width: number;
	height: number;
	margin: { top: number; right: number; bottom: number; left: number };
	windowMs: number;   // total window; "now" is centered so you get future space
	stepMs: number;     // grid step in time
	stepP: number;      // grid step in price
	tickMs: number;     // stream timer
	squareMode: boolean;// keep visual squares regardless of zoom
	throttleMs: number; // throttle WS updates per id
	// If provided, set the price step (grid height) as a percent of first price
	// Example: 0.001 = 0.1% of first price
	stepPPercent?: number;

	// Optional action hooks to integrate order placement / sounds
	onCreateOrder?: (o: OrderBox) => void;
	onTriggerOrder?: (o: OrderBox) => void;
	onExpireOrder?: (o: OrderBox) => void;
}

export interface Point { t: Date; p: number; _x?: number; _y?: number }

export interface OrderBox {
	id: string;
	// cell indices (center-based) -> used for occupancy & stable keys
	i: number; // time cell index (center = i*stepMs)
	j: number; // price cell index (center = j*stepP)
	t0: number; t1: number; // in ms epoch
	p0: number; p1: number; // in price units
	status: OrderStatus;
	firedAt?: number;
}

export interface API {
	destroy(): void;
	createAt(nowMs: number, price: number): void;
	getOrders(): OrderBox[];
	setStepGranularity(percent: number): void;
}

export function initLiveOrders(container: HTMLElement, userCfg?: Partial<Config>): API {
	let stream: { close: () => void } | null = null;
	const cfg: Config = {
		width: container.clientWidth || 1000,
		height: container.clientHeight || 560,
		margin: { top: 20, right: 60, bottom: 30, left: 60 },
		windowMs: 60_000,
		stepMs: 5_000,
		stepP: 0.5,
		tickMs: 16,
		squareMode: true,
		throttleMs: 100,
		stepPPercent: 0.001,
		...userCfg,
	};
	const half = cfg.windowMs / 2;

	const innerW = cfg.width - cfg.margin.left - cfg.margin.right;
	const innerH = cfg.height - cfg.margin.top - cfg.margin.bottom;

	// --- DOM layers ---
	const root = d3.select(container).classed("d3-live-orders", true);

	const canvas = root.append("canvas")
		.attr("width", cfg.width)
		.attr("height", cfg.height)
		.style("position", "absolute")
		.style("left", "0px").style("top", "0px");
	const ctx = (canvas.node() as HTMLCanvasElement).getContext("2d")!;

	const svg = root.append("svg")
		.attr("width", cfg.width)
		.attr("height", cfg.height)
		.style("position", "absolute")
		.style("left", "0px").style("top", "0px");

	const gRoot = svg.append("g")
		.attr("transform", `translate(${cfg.margin.left},${cfg.margin.top})`);
	const gx = gRoot.append("g").attr("class", "axis x").attr("transform", `translate(0,${innerH})`);
	const gy = gRoot.append("g").attr("class", "axis y");
	const gGrid = gRoot.append("g").attr("class", "grid");
	const gOrders = gRoot.append("g").attr("class", "orders");
	const gHover = gRoot.append("g").attr("class", "hover").style("pointer-events", "none");
	const hoverRect = gHover.append("rect").style("fill", "rgba(180,220,255,0.18)")
		.style("stroke", "#9cf").style("stroke-dasharray", "3 3").style("opacity", 0);
	const hoverText = gHover.append("text").attr("dy", "0.9em").attr("x", 4).attr("y", 2)
		.style("fill", "#def").style("font-size", "10px").style("pointer-events", "none").style("opacity", 0);
	const overlay = svg.append("rect")
		.attr("x", cfg.margin.left).attr("y", cfg.margin.top)
		.attr("width", innerW).attr("height", innerH)
		.style("fill", "transparent").style("cursor", "crosshair");

	// --- Helpers ---
	const cellKey = (i: number, j: number) => `${i}:${j}`;
	const nowMs = () => Date.now();

	// --- Scales & zoom ---
	const x = d3.scaleTime().range([0, innerW]);
	const y = d3.scaleLinear().range([innerH, 0]);
	let transform = d3.zoomIdentity;

	// --- Data ---
	const points: Point[] = [];
	let price = 100;
	let hasFirstPrice = false;
	let yCenter = price; // EMA-tracked center for square mode
	let priceStep = cfg.stepP; // dynamic stepP; can be derived from first price via stepPPercent
	let firstPrice = 0;
	let lastHoverKey: string | null = null;
	let lastHoverI: number | null = null;
	let lastHoverJ: number | null = null;

	const orders = new Map<string, OrderBox>();
	const occupied = new Set<string>(); // `${i}:${j}`

	const lineGen = d3.line<Point>()
		.x(d => d._x!)
		.y(d => d._y!);

	function rescaled() {
		return { xz: transform.rescaleX(x), yz: transform.rescaleY(y) };
	}

	function ticksTimeByStep(domain: [Date, Date], stepMs: number): Date[] {
		const [t0, t1] = domain;
		const a: Date[] = [];
		const start = Math.ceil(+t0 / stepMs) * stepMs;
		for (let t = start; t <= +t1; t += stepMs) a.push(new Date(t));
		return a;
	}

	function updateYDomainSquareMode(now: number) {
		// lock y so each stepP maps to same pixels as each stepMs
		// Important: compute against the base x scale (not rescaled), so
		// zoom scaling applies equally to x and y and cancels out.
		const pxXStepBase = Math.max(1, x(new Date(now + cfg.stepMs)) - x(new Date(now)));
		// ySpan in data units so that base px per priceStep equals base px per stepMs
		const ySpan = (innerH * priceStep) / pxXStepBase; // data units
		// track center with EMA to keep trace on-screen but stable
		yCenter = yCenter * 0.9 + price * 0.1;
		y.domain([yCenter - ySpan / 2, yCenter + ySpan / 2]);
	}

	function drawGridAxes() {
		const { xz, yz } = rescaled();

		// Grid lines (time)
		const xt = ticksTimeByStep(xz.domain() as [Date, Date], cfg.stepMs);
		const v = gGrid.selectAll<SVGLineElement, Date>("line.v").data(xt, d => +d as any);
		v.join(
			enter => enter.append("line").attr("class", "v").attr("y1", 0).attr("y2", innerH)
				.attr("x1", d => xz(d)).attr("x2", d => xz(d)),
			update => update.attr("x1", d => xz(d)).attr("x2", d => xz(d)),
			exit => exit.remove()
		);

		// Grid lines (price)
		const [p0, p1] = yz.domain().map(yz.invert).sort((a, b) => a - b) as [number, number];
		const startP = Math.ceil(p0 / priceStep) * priceStep;
		const yt: number[] = [];
		for (let p = startP; p <= p1 + 1e-9; p += priceStep) yt.push(p);
		const h = gGrid.selectAll<SVGLineElement, number>("line.h").data(yt);
		h.join(
			enter => enter.append("line").attr("class", "h").attr("x1", 0).attr("x2", innerW)
				.attr("y1", d => yz(d)).attr("y2", d => yz(d)),
			update => update.attr("y1", d => yz(d)).attr("y2", d => yz(d)),
			exit => exit.remove()
		);

		// Now line (center of view)
		const xNow = xz(new Date());
		const nowSel = gGrid.selectAll<SVGLineElement, number>("line.now").data([0]);
		nowSel.join(
			enter => enter.append("line").attr("class", "now")
				.attr("x1", xNow).attr("x2", xNow).attr("y1", 0).attr("y2", innerH)
				.style("stroke", "#777").style("stroke-dasharray", "4 4"),
			update => update.attr("x1", xNow).attr("x2", xNow)
		);

		// Axes
		gx.call(d3.axisBottom(xz).ticks(6) as any);
		gy.call(d3.axisLeft(yz).ticks(7) as any);
	}

	function drawLine() {
		const { xz, yz } = rescaled();
		ctx.clearRect(0, 0, cfg.width, cfg.height);
		ctx.save(); ctx.translate(cfg.margin.left, cfg.margin.top);
		for (const d of points) { d._x = xz(d.t); d._y = yz(d.p); }
		ctx.beginPath();
		const p = new Path2D(lineGen(points));
		ctx.strokeStyle = "#8fd3ff"; ctx.lineWidth = 1.25; ctx.stroke(p);
		ctx.restore();
	}

	function labelFor(o: OrderBox): string {
		const midP = ((o.p0 + o.p1) / 2).toFixed(3);
		const secs = Math.max(0, Math.round((o.t1 - nowMs()) / 1000));
		return `${midP} (${secs}s)`;
	}

	function drawOrders() {
		const { xz, yz } = rescaled();
		const sel = gOrders.selectAll<SVGGElement, OrderBox>("g.order").data([...orders.values()], d => d.id);
		const ent = sel.enter().append("g").attr("class", "order").attr("data-order", d => d.id);
		ent.append("rect");
		ent.append("text").attr("dy", "0.9em").attr("x", 4).attr("y", 2)
			.style("fill", "#cfe").style("font-size", "10px").style("pointer-events", "none");

		const merged = ent.merge(sel as any)
			.attr("class", (d) => `order ${d.status}`)
			.attr("data-order", d => d.id);

		merged.select<SVGRectElement>("rect")
			.attr("x", d => Math.min(xz(d.t0), xz(d.t1)))
			.attr("y", d => Math.min(yz(d.p1), yz(d.p0)))
			.attr("width", d => Math.abs(xz(d.t1) - xz(d.t0)))
			.attr("height", d => Math.abs(yz(d.p0) - yz(d.p1)))
			.attr("rx", 2).attr("ry", 2)
			.style("fill", "rgba(50,160,255,0.18)")
			.style("stroke", "#69f").style("stroke-width", "1px");

		merged.select<SVGTextElement>("text")
			.attr("transform", d => `translate(${Math.min(xz(d.t0), xz(d.t1)) + 2},${Math.min(yz(d.p1), yz(d.p0)) + 2})`)
			.text(d => labelFor(d));

		sel.exit().remove();
	}

	function drawHover() {
		if (!lastHoverKey || lastHoverI == null || lastHoverJ == null) {
			hoverRect.style("opacity", 0);
			hoverText.style("opacity", 0);
			return;
		}
		const { xz, yz } = rescaled();
		const tCenter = lastHoverI * cfg.stepMs;
		const pCenter = lastHoverJ * priceStep;
		const x0 = xz(new Date(tCenter - cfg.stepMs / 2));
		const x1 = xz(new Date(tCenter + cfg.stepMs / 2));
		const y0 = yz(pCenter - priceStep / 2);
		const y1 = yz(pCenter + priceStep / 2);
		hoverRect
			.attr("x", Math.min(x0, x1))
			.attr("y", Math.min(y1, y0))
			.attr("width", Math.abs(x1 - x0))
			.attr("height", Math.abs(y0 - y1))
			.style("opacity", 1);
		hoverText
			.attr("transform", `translate(${Math.min(x0, x1) + 2},${Math.min(y1, y0) + 2})`)
			.text(`${(pCenter).toFixed(4)}`)
			.style("opacity", 1);
	}

	let renderScheduled = false;
	let lastRenderTime = 0;
	const MIN_RENDER_INTERVAL = 16; // 60fps

	function render() {
		const now = Date.now();
		if (now - lastRenderTime < MIN_RENDER_INTERVAL) {
			if (!renderScheduled) {
				renderScheduled = true;
				requestAnimationFrame(() => {
					renderScheduled = false;
					render();
				});
			}
			return;
		}
		lastRenderTime = now;

		if (cfg.squareMode) updateYDomainSquareMode(nowMs());
		drawGridAxes();
		drawLine();
		drawOrders();
		drawHover();
	}

	function onTriggered(id: string) {
		const rect = (svg.node() as SVGSVGElement).querySelector(`[data-order="${id}"] rect`) as SVGRectElement | null;
		if (!rect) return;
		animateOrderTrigger(rect);
		const o = orders.get(id);
		if (o) {
			cfg.onTriggerOrder?.(o);
			emitOrderEvent('order:trigger', { order: o });
		}
	}
	function onExpired(id: string) {
		const rect = (svg.node() as SVGSVGElement).querySelector(`[data-order="${id}"] rect`) as SVGRectElement | null;
		if (!rect) return;
		const o = orders.get(id);
		if (o) {
			cfg.onExpireOrder?.(o);
			emitOrderEvent('order:expire', { order: o });
		}
		animateOrderExpire(rect);
	}

	function onCreated(id: string) {
		const o = orders.get(id);
		if (o) {
			cfg.onCreateOrder?.(o);
			emitOrderEvent('order:create', { order: o });
		}

		// Animation needs to wait for DOM element to exist
		requestAnimationFrame(() => {
			const rect = (svg.node() as SVGSVGElement).querySelector(`[data-order="${id}"] rect`) as SVGRectElement | null;
			if (rect) {
				animateOrderCreate(rect);
			}
		});
	}

	// --- Hover + Pointer create: only future cells ---
	function hideHover() {
		animateHoverExit(hoverRect.node() as Element, hoverText.node() as Element);
		lastHoverKey = null;
		lastHoverI = null;
		lastHoverJ = null;
		// Set hidden state after animation; immediate styles will be set on next draw
		hoverRect.style("opacity", 0);
		hoverText.style("opacity", 0);
	}

	let lastMouseMoveTime = 0;
	const MOUSE_THROTTLE_MS = 16; // 60fps for mouse

	overlay.on("mousemove", (ev: MouseEvent) => {
		if (!hasFirstPrice) return;

		const now = Date.now();
		if (now - lastMouseMoveTime < MOUSE_THROTTLE_MS) return;
		lastMouseMoveTime = now;

		// Execute mouse logic asynchronously
		requestAnimationFrame(() => {
			const [mx, my] = d3.pointer(ev, gRoot.node() as SVGGElement);
			const { xz, yz } = rescaled();
			const t = xz.invert(mx).getTime();
			const p = yz.invert(my);
			const currentTime = nowMs();
			if (t < currentTime) { hideHover(); return; }

			const iRaw = Math.round(t / cfg.stepMs);
			const jRaw = Math.round(p / priceStep);
			const minI = Math.ceil(currentTime / cfg.stepMs);
			const i = Math.max(iRaw, minI);
			const j = jRaw;
			const key = cellKey(i, j);
			// Do not render hover over an already-occupied cell
			const sameCell = lastHoverKey === key;
			if (sameCell) return; // still inside the same snapped cell

			// Cursor left the current hover cell: remove existing preview first (animated)
			hideHover();

			// Verify the new snapped cell is valid (future + not occupied), then show
			if (occupied.has(key)) { return; }

			lastHoverKey = key;
			lastHoverI = i;
			lastHoverJ = j;
			animateHoverEnter(hoverRect.node() as Element, hoverText.node() as Element);
			render();
		});
	});

	overlay.on("mouseleave", () => hideHover());

	overlay.on("click", (ev: MouseEvent) => {
		if (!hasFirstPrice) return; // ignore until we have a baseline

		// Process click immediately without waiting for render cycle
		ev.stopPropagation();

		// Execute click logic immediately
		let i: number | null = lastHoverI;
		let j: number | null = lastHoverJ;
		let key: string | null = lastHoverKey;
		if (i == null || j == null || !key) {
			const [mx, my] = d3.pointer(ev, gRoot.node() as SVGGElement);
			const { xz, yz } = rescaled();
			const t = xz.invert(mx).getTime();
			const p = yz.invert(my);
			const now = nowMs();
			if (t < now) return;
			const iRaw = Math.round(t / cfg.stepMs);
			const jRaw = Math.round(p / priceStep);
			const minI = Math.ceil(now / cfg.stepMs);
			i = Math.max(iRaw, minI);
			j = jRaw;
			key = cellKey(i, j);
		}

		if (i == null || j == null || !key) return;
		if (occupied.has(key)) return; // no overlap

		const tCenter = i * cfg.stepMs;
		const pCenter = j * priceStep;
		const box: OrderBox = {
			id: cryptoId(), i, j,
			t0: tCenter - cfg.stepMs / 2, t1: tCenter + cfg.stepMs / 2,
			p0: pCenter - priceStep / 2, p1: pCenter + priceStep / 2,
			status: "pending",
		};

		// Update state immediately
		orders.set(box.id, box);
		occupied.add(key);
		hideHover();

		// Call onCreated immediately to preserve user interaction context for audio
		// This must happen synchronously with the click event
		onCreated(box.id);

		// Schedule render asynchronously
		requestAnimationFrame(() => {
			render();
		});
	});

	// --- Stream timer ---
	const timer = setInterval(() => {
		if (!hasFirstPrice) return; // wait for first price before drawing
		const now = nowMs();
		x.domain([new Date(now - half), new Date(now + half)]);

		points.push({ t: new Date(now), p: price });

		const cutoff = now - half - 2000;
		while (points.length && points[0].t.getTime() < cutoff) points.shift();
		// lifecycle
		for (const o of [...orders.values()]) {
			if (o.status === "pending") {
				const inTime = now >= o.t0 && now <= o.t1;
				const inBand = price >= Math.min(o.p0, o.p1) && price <= Math.max(o.p0, o.p1);
				if (inTime && inBand) {
					o.status = "triggered"; o.firedAt = now; onTriggered(o.id);
				} else if (now > o.t1) {
					o.status = "expired"; onExpired(o.id);
					setTimeout(() => { orders.delete(o.id); occupied.delete(cellKey(o.i, o.j)); render(); }, 380);
				}
			} else if (now > o.t1) {
				// Past cleanup (any status)
				orders.delete(o.id); occupied.delete(cellKey(o.i, o.j));
			}
		}

		render();
	}, cfg.tickMs);

	// --- Init price stream (direct WS via shared util) ---
	stream = startHermesPriceStream({
		ids: [SOL_USD_FEED_ID],
		throttleMs: cfg.throttleMs,
		onPrice: ({ actualPrice }) => {
			price = actualPrice;
			if (!hasFirstPrice) {
				const now = Date.now();
				hasFirstPrice = true;
				firstPrice = price;
				// set priceStep based on first price if percent is configured
				if (cfg.stepPPercent != null) {
					priceStep = Math.max(1e-12, Math.abs(firstPrice) * cfg.stepPPercent);
				}
				yCenter = price; // initialize center to first price
				x.domain([new Date(now - half), new Date(now + half)]);
				points.push({ t: new Date(now), p: price });
				render();
			}
		},
	});
	// Defer domain initialization until first price arrives

	// Set up zoom after render is defined
	const zoom = d3.zoom<SVGSVGElement, unknown>()
		.scaleExtent([0.5, 50])
		.translateExtent([[0, 0], [cfg.width, cfg.height]])
		.on("zoom", (ev) => { transform = ev.transform; render(); });
	(svg.node() as SVGSVGElement).addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
	svg.call(zoom as any).call(zoom.transform as any, d3.zoomIdentity);

	// Do not render until first price update

	function destroy() {
		clearInterval(timer);
		if (stream) { stream.close(); stream = null; }
		root.selectAll("*").remove();
	}

	function createAt(timeMs: number, pMid: number) {
		const i = Math.max(Math.round(timeMs / cfg.stepMs), Math.ceil(nowMs() / cfg.stepMs));
		const j = Math.round(pMid / priceStep);
		if (occupied.has(cellKey(i, j))) return;
		const tCenter = i * cfg.stepMs; const pCenter = j * priceStep;
		const box: OrderBox = {
			id: cryptoId(), i, j,
			t0: tCenter - cfg.stepMs / 2, t1: tCenter + cfg.stepMs / 2,
			p0: pCenter - priceStep / 2, p1: pCenter + priceStep / 2,
			status: "pending",
		};
		orders.set(box.id, box);
		occupied.add(cellKey(i, j));
		render();
		onCreated(box.id);
	}

	function setStepGranularity(percent: number) {
		cfg.stepPPercent = percent;
		if (!hasFirstPrice) return;
		priceStep = Math.max(1e-12, Math.abs(firstPrice) * (cfg.stepPPercent ?? 0));
		for (const o of orders.values()) {
			const pCenter = o.j * priceStep;
			o.p0 = pCenter - priceStep / 2;
			o.p1 = pCenter + priceStep / 2;
		}
		render();
	}

	return {
		destroy,
		createAt,
		getOrders: () => [...orders.values()],
		setStepGranularity,
	};
}

function cryptoId(): string {
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
	return Math.random().toString(36).slice(2);
}

export function L2() {
	const containerRef = useRef<HTMLDivElement>(null);
	const apiRef = useRef<API | null>(null);

	useEffect(() => {
		if (!containerRef.current) return;

		apiRef.current = initLiveOrders(containerRef.current, {
			width: window.innerWidth,
			height: window.innerHeight,
		});

		return () => {
			if (apiRef.current) {
				apiRef.current.destroy();
				apiRef.current = null;
			}
		};
	}, []);

	return (
		<div
			ref={containerRef}
			style={{
				width: '100vw',
				height: '100vh',
				position: 'relative',
				backgroundColor: '#0a0a0a'
			}}
		/>
	);
}
