import { useEffect } from 'react';
import { onOrderEvent } from '@/web/events/orderBus';
import { playSound } from 'react-sounds';

// Bridges order lifecycle events to sound effects.
// Today this uses our existing Howler-based SoundProvider.
// To switch to `react-sounds`, replace the internals to call that API instead.
export function OrderSounds() {
	useEffect(() => {
		const offCreate = onOrderEvent('order:create', () => playSound('ui/button_medium'));
		const offTrigger = onOrderEvent('order:trigger', () => playSound('notification/info'));
		const offExpire = onOrderEvent('order:expire', () => playSound('notification/error'));
		return () => {
			offCreate(); offTrigger(); offExpire();
		};
	}, []);

	return null;
}
