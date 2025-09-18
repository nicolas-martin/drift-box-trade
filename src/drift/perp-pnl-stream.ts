import { PRICE_PRECISION, QUOTE_PRECISION } from '@drift-labs/sdk';
import { Subscription } from 'rxjs';
import { initializeClients, getAuthorityDriftInstance, MARKET_INDEX } from './perp-test-flow';
import { MarketId } from '../types';

const subscriptions: Subscription[] = [];
let shuttingDown = false;
let hasOpenPosition = false;

function formatPrice(raw: number): string {
	return `$${raw.toFixed(4)}`;
}

function formatPnl(pnl: number): string {
	const sign = pnl >= 0 ? '+' : '-';
	return `${sign}${Math.abs(pnl).toFixed(4)}`;
}

async function runPerpPnlStream() {
	console.log('🚀 Starting perp PnL stream test...');
	await initializeClients();

	const authorityDrift = getAuthorityDriftInstance();
	const marketKey = MarketId.createPerpMarket(MARKET_INDEX).key;

	const markPriceSub = authorityDrift.onMarkPricesUpdate((lookup) => {
		const data = lookup[marketKey];
		if (!data) return;

		const markPrice = data.markPrice.toNumber() / PRICE_PRECISION.toNumber();
		console.log(`📉 Mark Price Update: ${formatPrice(markPrice)}`);
	});
	subscriptions.push(markPriceSub);

	const oraclePriceSub = authorityDrift.onOraclePricesUpdate((lookup) => {
		const data = lookup[marketKey];
		if (!data) return;

		const oraclePrice = data.price.toNumber() / PRICE_PRECISION.toNumber();
		console.log(`🔮 Oracle Price Update: ${formatPrice(oraclePrice)}`);
	});
	subscriptions.push(oraclePriceSub);

	const userSub = authorityDrift.onUserAccountUpdate((account) => {
		const position = account.openPerpPositions.find(
			(pos) => pos.marketIndex === MARKET_INDEX
		);

		if (!position) {
			if (hasOpenPosition) {
				console.log('ℹ️  Position closed. Waiting for new fills to report PnL.');
				hasOpenPosition = false;
			}
			return;
		}
		hasOpenPosition = true;

		const pnlBigNum = position.positionPnl.markBased.positionNotionalPnl;
		const pnlRaw = pnlBigNum.val.toNumber();
		const pnlUsd = pnlRaw / QUOTE_PRECISION.toNumber();
		const pnlPct = position.positionPnl.markBased.positionPnlPercentage;

		console.log(
			`💰 Mark PnL: ${formatPnl(pnlUsd)} USD (${pnlPct.toFixed(2)}%)`
		);
	});
	subscriptions.push(userSub);

	console.log('📡 Streaming updates... Press Ctrl+C to exit.');

	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;

		console.log('\n🛑 Shutting down stream...');
		subscriptions.splice(0).forEach((sub) => sub.unsubscribe());
		await authorityDrift.unsubscribe();
		console.log('✅ Stream closed.');
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

if (require.main === module) {
	runPerpPnlStream().catch((error) => {
		console.error('💥 Fatal error during PnL stream:', error);
		process.exit(1);
	});
}

export { runPerpPnlStream };
