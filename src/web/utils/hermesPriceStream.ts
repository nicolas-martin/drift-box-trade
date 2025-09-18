export type PriceUpdate = {
	id: string;
	price: number | string; // raw value from feed
	expo: number;
	publishTime?: number; // seconds epoch if present
	actualPrice: number; // computed decimal
};

export type StartHermesPriceStreamOptions = {
	ids: string[];
	throttleMs?: number;
	onPrice: (u: PriceUpdate) => void;
};

export function startHermesPriceStream(opts: StartHermesPriceStreamOptions) {
	const { ids, onPrice, throttleMs = 100 } = opts;

	const wantIds = new Set(ids.map((x) => x.replace('0x', '').toLowerCase()));
	const subscribeIds = [...ids];
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let closedByUser = false;
	const lastEmit: Record<string, number> = {};

	const handleMessage = (event: MessageEvent) => {
		try {
			const now = Date.now();
			const data = JSON.parse(event.data as string);

			const payloads: any[] = Array.isArray(data?.parsed)
				? data.parsed
				: data?.price_feed
					? [data.price_feed]
					: [data];

			for (const payload of payloads) {
				const id = (payload?.id || '').replace('0x', '').toLowerCase();
				if (!id || !wantIds.has(id)) continue;

				const priceVal = payload?.price?.price ?? payload?.price ?? payload?.aggregate?.price;
				const expo = payload?.price?.expo ?? payload?.exponent ?? payload?.aggregate?.expo ?? -8;
				const publishTime = payload?.price?.publish_time ?? payload?.timestamp ?? payload?.publish_time;

				if (priceVal == null) continue;

				// Throttle by id
				const last = lastEmit[id] ?? 0;
				if (now - last < throttleMs) continue;

				const actualPrice = Number(priceVal) * Math.pow(10, expo);
				lastEmit[id] = now;
				onPrice({ id, price: priceVal, expo, publishTime, actualPrice });
			}
		} catch {
			// ignore parse errors
		}
	};

	const connect = () => {
		if (closedByUser) return;
		try {
			ws = new WebSocket('wss://hermes.pyth.network/ws');
			ws.onopen = () => {
				const msg = { type: 'subscribe', ids: subscribeIds } as const;
				ws?.send(JSON.stringify(msg));
			};
			ws.onmessage = handleMessage;
			ws.onerror = () => {
				// noop; will reconnect on close
			};
			ws.onclose = () => {
				if (closedByUser) return;
				if (reconnectTimer) clearTimeout(reconnectTimer);
				reconnectTimer = setTimeout(connect, 3000);
			};
		} catch {
			// schedule reconnect on unexpected errors
			if (!closedByUser) reconnectTimer = setTimeout(connect, 3000);
		}
	};

	const close = () => {
		closedByUser = true;
		if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
		if (ws) { try { ws.close(); } catch { /* empty */ } ws = null; }
	};

	connect();

	return { close };
}
