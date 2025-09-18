import {
	DriftPerpTradingService,
	PlaceLimitOrderResponse,
} from '@/drift/perp-test-flow';
import type { OrderBox } from '@/web/pages/L2';
import { PositionDirection } from '@drift-labs/sdk';

const perpService = new DriftPerpTradingService();

function directionLabel(direction: PositionDirection | undefined): string {
	if (direction == null) return 'ALL';
	return direction === PositionDirection.LONG ? 'LONG' : 'SHORT';
}

export async function placeCreateOrder(order: OrderBox): Promise<void> {
	const midPrice = (order.p0 + order.p1) / 2;
	const result: PlaceLimitOrderResponse = await perpService.placeLimitOrder({
		orderId: order.id,
		targetPrice: midPrice,
		waitForFill: false,
	});

	console.log('[orders] placed perp limit order', {
		id: order.id,
		direction: directionLabel(result.direction),
		targetPrice: midPrice,
		signature: result.signature,
	});
}

export async function placeTriggerOrder(order: OrderBox): Promise<void> {
	const result = await perpService.handleTrigger(order.id);
	console.log('[orders] trigger hit, closing positions', {
		id: order.id,
		direction: directionLabel(result.direction),
		signatures: result.signatures,
	});
}

export async function placeExpireCleanup(order: OrderBox): Promise<void> {
	const result = await perpService.handleExpiry(order.id);
	console.log('[orders] order expired, ensuring positions closed', {
		id: order.id,
		direction: directionLabel(result.direction),
		signatures: result.signatures,
	});
}
