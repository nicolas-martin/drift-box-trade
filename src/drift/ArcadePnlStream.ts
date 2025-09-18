import {
	BehaviorSubject,
	Observable,
	Subscription,
} from 'rxjs';
import {
	MARKET_INDEX,
	PositionSummary,
	getArcadePerpService,
} from './ArcadePerpService';
import {
	PRICE_PRECISION,
	QUOTE_PRECISION,
} from '@drift-labs/sdk';
import { MarketId } from '../types';

export interface PerpPnlUpdate {
	markPrice: number;
	oraclePrice: number;
	pnlUsd: number;
	pnlPct: number;
	hasPosition: boolean;
}

const defaultState: PerpPnlUpdate = {
	markPrice: 0,
	oraclePrice: 0,
	pnlUsd: 0,
	pnlPct: 0,
	hasPosition: false,
};

let currentState: PerpPnlUpdate = defaultState;

const pnlSubject = new BehaviorSubject<PerpPnlUpdate>(defaultState);

let refCount = 0;
let started = false;
let markPriceSub: Subscription | null = null;
let oraclePriceSub: Subscription | null = null;
let userSub: Subscription | null = null;

function publish(update: Partial<PerpPnlUpdate>) {
	currentState = { ...currentState, ...update };
	pnlSubject.next(currentState);
}

function resetState() {
	currentState = defaultState;
	pnlSubject.next(currentState);
}

async function startInternal() {
	if (started) return;

	const service = getArcadePerpService();
	await service.initialize();

	const authority = service.getAuthorityDrift();
	const marketKey = MarketId.createPerpMarket(MARKET_INDEX).key;

	markPriceSub = authority.onMarkPricesUpdate((lookup) => {
		const data = lookup[marketKey];
		if (!data) return;
		const markPrice = data.markPrice.toNumber() / PRICE_PRECISION.toNumber();
		publish({ markPrice });
	});

	oraclePriceSub = authority.onOraclePricesUpdate((lookup) => {
		const data = lookup[marketKey];
		if (!data) return;
		const oraclePrice = data.price.toNumber() / PRICE_PRECISION.toNumber();
		publish({ oraclePrice });
	});

	userSub = authority.onUserAccountUpdate((account) => {
		const position = account.openPerpPositions.find(
			(pos) => pos.marketIndex === MARKET_INDEX
		);

		if (!position) {
			if (currentState.hasPosition) {
				publish({ hasPosition: false, pnlUsd: 0, pnlPct: 0 });
			}
			return;
		}

		const pnlBigNum = position.positionPnl.markBased.positionNotionalPnl;
		const pnlRaw = pnlBigNum.val.toNumber();
		const pnlUsd = pnlRaw / QUOTE_PRECISION.toNumber();
		const pnlPct = position.positionPnl.markBased.positionPnlPercentage ?? 0;

		publish({ pnlUsd, pnlPct, hasPosition: true });
	});

	started = true;
}

function stopInternal() {
	if (!started) return;
	markPriceSub?.unsubscribe();
	oraclePriceSub?.unsubscribe();
	userSub?.unsubscribe();
	markPriceSub = oraclePriceSub = userSub = null;
	started = false;
	resetState();
}

export async function acquirePerpPnlStream(): Promise<() => void> {
	refCount++;
	await startInternal();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		refCount = Math.max(0, refCount - 1);
		if (refCount === 0) {
			stopInternal();
		}
	};
}

export function observePerpPnl(): Observable<PerpPnlUpdate> {
	return pnlSubject.asObservable();
}

export function getLatestPerpPnl(): PerpPnlUpdate {
	return currentState;
}

export function projectPnlFromPositions(positions: PositionSummary[]): PerpPnlUpdate {
	if (positions.length === 0) {
		return { ...defaultState };
	}
	const position = positions[0];
	return {
		markPrice: position.currentPrice,
		oraclePrice: currentState.oraclePrice,
		pnlUsd: position.pnl,
		pnlPct: position.notional ? (position.pnl / position.notional) * 100 : 0,
		hasPosition: true,
	};
}
