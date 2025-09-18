import { onOrderEvent } from '@/web/events/orderBus';
import { placeCreateOrder, placeTriggerOrder, placeExpireCleanup } from '@/web/orders/actions';

export function attachOrderHandlers() {
	const offCreate = onOrderEvent('order:create', async ({ order }) => {
		try { await placeCreateOrder(order); } catch (e) { console.warn('create handler failed', e); }
	});
	const offTrigger = onOrderEvent('order:trigger', async ({ order }) => {
		try { await placeTriggerOrder(order); } catch (e) { console.warn('trigger handler failed', e); }
	});
	const offExpire = onOrderEvent('order:expire', async ({ order }) => {
		try { await placeExpireCleanup(order); } catch (e) { console.warn('expire handler failed', e); }
	});
	return () => { offCreate(); offTrigger(); offExpire(); };
}

