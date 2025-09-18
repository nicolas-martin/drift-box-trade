// Stub order action functions.
// Replace bodies with real integrations (e.g., send tx, call backend).
import type { OrderBox } from '@/web/pages/L2';

export async function placeCreateOrder(order: OrderBox): Promise<void> {
	// TODO: Implement real create placement
	console.log('[orders] create stub', order);
}

export async function placeTriggerOrder(order: OrderBox): Promise<void> {
	// TODO: Implement real trigger handling
	console.log('[orders] trigger stub', order);
}

export async function placeExpireCleanup(order: OrderBox): Promise<void> {
	// TODO: Implement real expire cleanup
	console.log('[orders] expire stub', order);
}

