import { getArcadePerpService, PerpPnlUpdate } from './ArcadePerpService';

let shuttingDown = false;
let releasePnl: (() => void) | null = null;

async function runPerpPnlStream() {
	console.log('🚀 Starting perp PnL stream test...');
	const service = getArcadePerpService();
	await service.initialize();

	releasePnl = await service.subscribeToPnl((update) => {
		printPnl(update);
	});

	console.log('📡 Streaming updates... Press Ctrl+C to exit.');

	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;

		console.log('\n🛑 Shutting down stream...');
		releasePnl?.();
		await service.getAuthorityDrift().unsubscribe();
		console.log('✅ Stream closed.');
		process.exit(0);
	};

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

function formatPrice(raw: number): string {
	return `$${raw.toFixed(4)}`;
}

function formatPnl(pnl: number): string {
	const sign = pnl >= 0 ? '+' : '-';
	return `${sign}${Math.abs(pnl).toFixed(4)}`;
}

function printPnl(update: PerpPnlUpdate) {
	const priceLine = `📉 Mark Price Update: ${formatPrice(update.markPrice)}`;
	const oracleLine = `🔮 Oracle Price Update: ${formatPrice(update.oraclePrice)}`;
	console.log(priceLine);
	console.log(oracleLine);
	if (update.hasPosition) {
		console.log(
			`💰 Mark PnL: ${formatPnl(update.pnlUsd)} USD (${update.pnlPct.toFixed(2)}%)`
		);
	} else {
		console.log('ℹ️  No active perp position.');
	}
}

if (require.main === module) {
	runPerpPnlStream().catch((error) => {
		console.error('💥 Fatal error during PnL stream:', error);
		process.exit(1);
	});
}

export { runPerpPnlStream };
