import { PositionDirection } from '@drift-labs/sdk';
import {
	ArcadePerpService,
	ClosePositionsResponse,
	DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS,
	DEFAULT_POSITION_SIZE,
	MARKET_INDEX,
	PlaceLimitOrderResponse,
	PositionSummary,
	getArcadePerpService,
} from './ArcadePerpService';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

const service: ArcadePerpService = getArcadePerpService();

export async function ensurePerpClientsInitialized(): Promise<void> {
	await service.initialize();
}

export function getAuthorityDriftInstance() {
	return service.getAuthorityDrift();
}

export function getCentralServerDriftInstance() {
	return service.getCentralServerDrift();
}

export function getUserAccountPublicKey() {
	return service.getUserAccountPublicKey();
}

async function printPositions(label: string) {
	const positions = await service.getOpenPositions();
	console.log(`\n${GREEN}${label}${NC}`);
	if (positions.length === 0) {
		console.log('No open positions found');
		return;
	}
	positions.forEach((pos, index) => printPositionDetails(pos, `Position ${index + 1}`));
}

function printPositionDetails(pos: PositionSummary, label?: string) {
	if (label) {
		console.log(`${YELLOW}${label}:${NC}`);
	} else {
		console.log(`${GREEN}✅ Position Details:${NC}`);
	}
	console.log(`  Market: ${pos.marketName} (Index: ${pos.marketIndex})`);
	console.log(`  Direction: ${pos.direction}`);
	console.log(`  Size: ${pos.size} SOL`);
	console.log(`  Entry Price: $${pos.entryPrice.toFixed(2)}`);
	console.log(`  Current Price: $${pos.currentPrice.toFixed(2)}`);
	console.log(
		`  Liquidation Price: ${pos.liquidationPrice > 0
			? `$${pos.liquidationPrice.toFixed(2)}`
			: 'N/A'
		}`
	);
	console.log(`  PnL: ${pos.pnl >= 0 ? GREEN : RED}$${pos.pnl.toFixed(4)}${NC}`);
	console.log(`  Notional: $${pos.notional.toFixed(2)}`);
	console.log(`  Leverage: ${pos.leverage.toFixed(2)}x`);
	console.log(`  Raw Base Asset Amount: ${pos.baseAssetAmountRaw.toString()}`);
	console.log();
}

async function getPositionOnly() {
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}`);
	console.log(`${GREEN}     DRIFT GET POSITIONS${NC}`);
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}\n`);

	await ensurePerpClientsInitialized();

	try {
		await printPositions('Open Positions');
	} catch (error: any) {
		console.error(`${RED}❌ Error:${NC}`, error.message ?? error);
		if (error.logs) {
			console.error('Transaction logs:', error.logs);
		}
	} finally {
		console.log('👋 Unsubscribing...');
		await service.getAuthorityDrift().unsubscribe();
		console.log('✅ Done!');
	}
}

async function runPerpTestFlow() {
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}`);
	console.log(`${GREEN}     DRIFT PERP TRADING TEST FLOW${NC}`);
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}\n`);

	process.stdin.resume();
	process.stdin.setEncoding('utf8');

	await ensurePerpClientsInitialized();

	const authority = service.getAuthorityDrift();
	const oracleData = authority.driftClient.getOracleDataForPerpMarket(MARKET_INDEX);
	if (!oracleData) {
		throw new Error('Oracle data unavailable. Cannot continue flow.');
	}

	try {
		console.log(`${YELLOW}📊 Step 1: Checking initial positions...${NC}`);
		await printPositions('Existing Positions');
		console.log();

		console.log(`${YELLOW}📈 Step 2: Opening LONG position with limit order...${NC}`);
		console.log(`Market: SOL-PERP`);
		console.log(`Size: ${DEFAULT_POSITION_SIZE} SOL`);
		console.log(`Direction: LONG`);

		const oraclePrice = oracleData.price.toNumber() / 1_000_000;
		const slippagePct = DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS / 10_000;
		const limitPrice = oraclePrice * (1 + slippagePct);
		console.log(`Current Oracle Price: $${oraclePrice.toFixed(2)}`);
		console.log(
			`Submitting limit order at $${limitPrice.toFixed(2)} (${(slippagePct * 100).toFixed(2)}% above oracle)`
		);

		const orderId = `cli-${Date.now()}`;
		const orderResult: PlaceLimitOrderResponse = await service.placeLimitOrder({
			orderId,
			direction: PositionDirection.LONG,
			size: DEFAULT_POSITION_SIZE,
			targetPrice: limitPrice,
			slippageBps: DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS,
			waitForFill: true,
		});

		const filledPosition = orderResult.position;
		console.log(`${YELLOW}📊 Step 3: Verifying position creation...${NC}`);
		if (filledPosition) {
			printPositionDetails(filledPosition, 'New Position');
		} else {
			console.log(`${YELLOW}⚠️  Limit order not filled within timeout window.${NC}`);
			console.log(`${YELLOW}🛑 Flow will stop since there is no position to manage.${NC}`);
			return;
		}
		console.log();

		console.log(`${YELLOW}⏰ Step 4: Waiting 5 seconds to check PnL...${NC}`);
		await sleep(5000);

		const [currentPosition] = await service.getOpenPositions();
		if (currentPosition) {
			console.log(`${GREEN}💰 Current PnL:${NC}`);
			console.log(`  Entry Price: $${currentPosition.entryPrice.toFixed(2)}`);
			console.log(`  Current Mark Price: $${currentPosition.currentPrice.toFixed(2)}`);
			console.log(
				`  Liquidation Price: ${currentPosition.liquidationPrice > 0
					? `$${currentPosition.liquidationPrice.toFixed(2)}`
					: 'N/A'
				}`
			);
			console.log(
				`  PnL: ${currentPosition.pnl >= 0 ? GREEN : RED}$${currentPosition.pnl.toFixed(4)}${NC}`
			);
			console.log(
				`  PnL %: ${currentPosition.pnl >= 0 ? GREEN : RED}${((currentPosition.pnl / currentPosition.notional) * 100).toFixed(2)}%${NC}`
			);
		}
		console.log();

		console.log(`${YELLOW}🔒 Step 5: Ready to close position${NC}`);
		console.log(`${GREEN}✋ Please check the position in the UI at https://app.drift.trade${NC}`);
		console.log(`${YELLOW}Press Enter when ready to close the position...${NC}`);

		await new Promise((resolve) => process.stdin.once('data', resolve));

		console.log(`${YELLOW}Closing position...${NC}`);
		const closeResult: ClosePositionsResponse = await service.handleTrigger(orderId);
		console.log(`Close signatures: ${closeResult.signatures.join(', ') || 'none (already closed)'}`);

		console.log(`${YELLOW}✅ Step 6: Verifying position closure...${NC}`);
		const remaining = closeResult.remainingPositions;
		console.log(`Found ${remaining.length} open position(s)`);

		if (remaining.length === 0) {
			console.log(`${GREEN}✅ All positions successfully closed!${NC}`);
		} else {
			remaining.forEach((pos, index) => printPositionDetails(pos, `Remaining Position ${index + 1}`));
		}
	} catch (error: any) {
		console.error(`${RED}❌ Error:${NC}`, error.message ?? error);
		if (error.logs) {
			console.error('Transaction logs:', error.logs);
		}
	} finally {
		console.log('\n👋 Unsubscribing...');
		await service.getAuthorityDrift().unsubscribe();
		console.log('✅ Done!');
	}
}

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
	const args = process.argv.slice(2);
	const shouldGetPositionOnly = args.includes('--getposition');

	if (shouldGetPositionOnly) {
		getPositionOnly()
			.then(() => process.exit(0))
			.catch((error) => {
				console.error('💥 Fatal error:', error);
				process.exit(1);
			});
	} else {
		runPerpTestFlow()
			.then(() => process.exit(0))
			.catch((error) => {
				console.error('💥 Fatal error:', error);
				process.exit(1);
			});
	}
}
