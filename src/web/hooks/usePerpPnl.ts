import { useEffect, useState } from 'react';
import {
	PerpPnlUpdate,
	getArcadePerpService,
} from '@/drift/ArcadePerpService';

export function usePerpPnl(): PerpPnlUpdate {
	const service = getArcadePerpService();
	const [state, setState] = useState<PerpPnlUpdate>(() => service.getLatestPnl());

	useEffect(() => {
		let cancelled = false;
		let release: (() => void) | null = null;

		service
			.subscribeToPnl((update) => {
				if (!cancelled) {
					setState(update);
				}
			})
			.then((cleanup) => {
				if (cancelled) {
					cleanup();
					return;
				}
				release = cleanup;
			})
			.catch((error) => {
				console.error('[perp-pnl] subscribe failed', error);
			});

		return () => {
			cancelled = true;
			release?.();
		};
	}, [service]);

	return state;
}
