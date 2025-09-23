// Lightweight event bus for order lifecycle events.
// All events are dispatched asynchronously to prevent blocking the UI thread.

export type OrderEventType = 'order:create' | 'order:trigger' | 'order:expire';

const bus = new EventTarget();

/**
 * Emit an order event asynchronously using Promise.resolve().then()
 * This ensures the event is dispatched in the next microtask,
 * preventing it from blocking the current execution.
 */
export function emitOrderEvent<T = any>(type: OrderEventType, detail: T) {
	// Use Promise.resolve().then() to defer execution to next microtask
	Promise.resolve().then(() => {
		try {
			bus.dispatchEvent(new CustomEvent(type, { detail }));
		} catch (error) {
			console.error(`Error emitting ${type} event:`, error);
		}
	});
}

/**
 * Subscribe to order events. Handlers are automatically wrapped
 * to execute asynchronously, preventing them from blocking the UI.
 */
export function onOrderEvent<T = any>(type: OrderEventType, handler: (detail: T) => void) {
	const listener = (ev: Event) => {
		// Execute handler asynchronously to prevent blocking
		Promise.resolve().then(() => {
			try {
				handler((ev as CustomEvent<T>).detail);
			} catch (error) {
				console.error(`Error in ${type} event handler:`, error);
			}
		});
	};

	bus.addEventListener(type, listener as EventListener);
	return () => bus.removeEventListener(type, listener as EventListener);
}
