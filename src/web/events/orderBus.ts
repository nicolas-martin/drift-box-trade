// Lightweight event bus for order lifecycle events.
// Consumers (e.g., sounds or order placement) can subscribe without coupling.

export type OrderEventType = 'order:create' | 'order:trigger' | 'order:expire';

const bus = new EventTarget();

export function emitOrderEvent<T = any>(type: OrderEventType, detail: T) {
	bus.dispatchEvent(new CustomEvent(type, { detail }));
}

export function onOrderEvent<T = any>(type: OrderEventType, handler: (detail: T) => void) {
	const listener = (ev: Event) => handler((ev as CustomEvent<T>).detail);
	bus.addEventListener(type, listener as EventListener);
	return () => bus.removeEventListener(type, listener as EventListener);
}

