import * as anchor from '@coral-xyz/anchor';
import {
	Connection,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	BN,
	loadKeypair,
	BASE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	PositionDirection,
} from '@drift-labs/sdk';
import { Buffer } from 'buffer';
import nacl from 'tweetnacl';
import { AuthorityDrift } from './Drift/clients/AuthorityDrift';
import { CentralServerDrift } from './Drift/clients/CentralServerDrift';
import * as path from 'path';

// Load environment variables
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '.env') });

// Configuration
const POSITION_SIZE = '0.01'; // Minimum position size
export const DEFAULT_POSITION_SIZE = parseFloat(POSITION_SIZE);
const DEFAULT_MARKET_INDEX = 0; // SUI-PERP
export const MARKET_INDEX = Number(process.env.MARKET_INDEX ?? DEFAULT_MARKET_INDEX);
const FILL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const FILL_TOLERANCE_PERCENT = 95;
const LIMIT_ORDER_SLIPPAGE_BPS = 10; // 0.10% above oracle
export const DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS = LIMIT_ORDER_SLIPPAGE_BPS;

// Colors for output
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m'; // No Color

let authorityDrift: AuthorityDrift;
let centralServerDrift: CentralServerDrift;
let userAccountPublicKey: PublicKey;
type SwiftEnabledWallet = anchor.Wallet & {
	signMessage(message: Uint8Array): Promise<Uint8Array>;
};

let wallet: SwiftEnabledWallet;
let connection: Connection;
let initializeClientsPromise: Promise<void> | null = null;

export interface PositionSummary {
	marketIndex: number;
	marketName: string;
	direction: 'LONG' | 'SHORT';
	directionEnum: PositionDirection;
	size: number;
	entryPrice: number;
	currentPrice: number;
	pnl: number;
	notional: number;
	leverage: number;
	liquidationPrice: number;
	baseAssetAmountRaw: BN;
}

export async function initializeClients(): Promise<void> {
	if (authorityDrift && centralServerDrift && userAccountPublicKey && wallet && connection) {
		return;
	}
	if (initializeClientsPromise) {
		return initializeClientsPromise;
	}

	initializeClientsPromise = (async () => {
		console.log(`${GREEN}🚀 Initializing clients...${NC}\n`);

		if (!process.env.ANCHOR_WALLET) {
			throw new Error('ANCHOR_WALLET must be set in .env file');
		}

		if (!process.env.ENDPOINT) {
			throw new Error('ENDPOINT environment variable must be set to your Solana RPC endpoint');
		}

		// Setup wallet with Swift-compatible signMessage support
		class SwiftWallet extends anchor.Wallet {
			async signMessage(message: Uint8Array): Promise<Uint8Array> {
				if (!this.payer) {
					throw new Error('Wallet must have a payer to sign messages');
				}
				return nacl.sign.detached(message, this.payer.secretKey);
			}
		}

		wallet = new SwiftWallet(loadKeypair(process.env.ANCHOR_WALLET as string)) as SwiftEnabledWallet;
		console.log(`✅ Wallet: ${wallet.publicKey.toString()}`);

		// Setup connection with auth headers
		connection = new Connection(process.env.ENDPOINT as string, {
			commitment: 'confirmed',
			httpHeaders: process.env.RPC_API_KEY
				? { Authorization: `Bearer ${process.env.RPC_API_KEY}` }
				: undefined,
		});

		// Initialize AuthorityDrift with DriftOperations
		authorityDrift = new AuthorityDrift({
			solanaRpcEndpoint: process.env.ENDPOINT as string,
			driftEnv: 'mainnet-beta',
			wallet,
			additionalDriftClientConfig: {
				connection, // Pass the connection with auth headers
				txVersion: 0,
				txParams: {
					computeUnits: 300000,
					computeUnitsPrice: 1000,
				},
			},
		});

		console.log('📡 Subscribing to market data (AuthorityDrift)...');
		await authorityDrift.subscribe();

		// Ensure user account is loaded
		if (!authorityDrift.driftClient.hasUser(0)) {
			await authorityDrift.driftClient.addUser(0, wallet.publicKey);
		}
		userAccountPublicKey = await authorityDrift.driftClient.getUserAccountPublicKey(
			0,
			wallet.publicKey
		);

		const rpcApiKey = process.env.RPC_API_KEY;
		console.log('🏗️  Initializing CentralServerDrift...');
		centralServerDrift = new CentralServerDrift({
			solanaRpcEndpoint: process.env.ENDPOINT as string,
			driftEnv: 'mainnet-beta',
			rpcApiKey,
			additionalDriftClientConfig: {
				txVersion: 0,
				txParams: {
					computeUnits: 200000,
					computeUnitsPrice: 1000,
				},
			},
		});
		await centralServerDrift.subscribe();
		console.log('✅ CentralServerDrift ready');

		console.log('✅ Connected to Drift Protocol\n');
	})();

	try {
		await initializeClientsPromise;
	} finally {
		initializeClientsPromise = null;
	}
}

export async function ensurePerpClientsInitialized(): Promise<void> {
	await initializeClients();
}

async function getPositions(): Promise<PositionSummary[]> {
	// Ensure user is loaded
	if (!authorityDrift.driftClient.hasUser(0)) {
		await authorityDrift.driftClient.addUser(0, wallet.publicKey);
	}

	// Wait a moment for cache to update
	await sleep(500);

	// Get user account data from the cache
	const userData = authorityDrift.userAccountCache[`0_${wallet.publicKey.toString()}`];
	if (!userData) {
		console.warn('⚠️  User account not found in cache');
		return [];
	}

	const positions: PositionSummary[] = [];

	// Check for open perp positions
	for (const positionInfo of userData.openPerpPositions) {
		// if (positionInfo.marketIndex !== MARKET_INDEX) continue;

		const perpMarket = authorityDrift.driftClient.getPerpMarketAccount(MARKET_INDEX);
		const marketName = Buffer.from(perpMarket.name)
			.toString('utf8')
			.replace(/\0/g, '')
			.trim();

		// Get current oracle price for mark price
		const oracleData = authorityDrift.driftClient.getOracleDataForPerpMarket(MARKET_INDEX);
		const currentPrice = oracleData ? oracleData.price.toNumber() / PRICE_PRECISION.toNumber() : 0;

		const size = positionInfo.baseSize.val.toNumber() / BASE_PRECISION.toNumber();
		const entryPrice = positionInfo.entryPrice.val.toNumber() / PRICE_PRECISION.toNumber();
		const liquidationPrice = positionInfo.liquidationPrice.val.toNumber() / PRICE_PRECISION.toNumber();
		const notional = positionInfo.notionalSize.val.toNumber() / QUOTE_PRECISION.toNumber();
		const markBasedPnl = positionInfo.positionPnl.markBased.positionNotionalPnl.val.toNumber() / QUOTE_PRECISION.toNumber();
		const feesAndFundingPnl = positionInfo.feesAndFundingPnl.val.toNumber() / QUOTE_PRECISION.toNumber();
		const pnl = markBasedPnl + feesAndFundingPnl;

		const totalCollateral = userData.marginInfo.totalInitialMargin.val.toNumber() / QUOTE_PRECISION.toNumber();
		const leverage = totalCollateral > 0 ? notional / totalCollateral : 0;

		const isLong = positionInfo.direction === PositionDirection.LONG;

		positions.push({
			marketIndex: MARKET_INDEX,
			marketName,
			direction: isLong ? 'LONG' : 'SHORT',
			directionEnum: positionInfo.direction,
			size: Math.abs(size),
			entryPrice,
			currentPrice,
			pnl,
			notional,
			leverage,
			liquidationPrice,
			baseAssetAmountRaw: positionInfo.baseSize.val.abs(),
		});
	}

	return positions;
}

// Remove executeTransaction function as we'll use DriftOperations directly

async function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
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

/**
 * Execute a regular transaction
 */
async function executeTransaction(
	txn: VersionedTransaction | Transaction,
	transactionType: string
): Promise<string | undefined> {
	if (!centralServerDrift) {
		throw new Error('CentralServerDrift must be initialized before executing transactions');
	}

	console.log(`✅ ${transactionType} transaction created successfully`);
	console.log('\n📝 Signing Transaction...');

	if (txn instanceof VersionedTransaction) {
		txn.sign([wallet.payer]);
	} else {
		txn.sign(wallet.payer);
	}
	console.log('✅ Transaction signed successfully');

	console.log('\n🚀 Sending transaction to the network...');
	const { txSig } = await centralServerDrift.sendSignedTransaction(txn);
	const signature = txSig?.toString();
	console.log('✅ Transaction sent successfully!');
	if (signature) {
		console.log(`📋 Transaction Signature: ${signature}`);
		console.log(`🔍 View on Solscan: https://solscan.io/tx/${signature}`);
	}
	console.log();
	return signature;
}

const BN_100 = new BN(100);

export function getAuthorityDriftInstance(): AuthorityDrift {
	if (!authorityDrift) {
		throw new Error('AuthorityDrift has not been initialized. Call initializeClients first.');
	}

	return authorityDrift;
}

export function getCentralServerDriftInstance(): CentralServerDrift {
	if (!centralServerDrift) {
		throw new Error('CentralServerDrift has not been initialized. Call initializeClients first.');
	}

	return centralServerDrift;
}

export function getUserAccountPublicKey(): PublicKey {
	if (!userAccountPublicKey) {
		throw new Error('User account public key not initialized. Call initializeClients first.');
	}

	return userAccountPublicKey;
}

async function waitForPositionFill(
	direction: PositionDirection,
	targetAmount: BN,
	timeoutMs: number = FILL_TIMEOUT_MS
): Promise<PositionSummary | null> {
	const minimumSatisfiedAmount = targetAmount
		.mul(new BN(FILL_TOLERANCE_PERCENT))
		.div(BN_100);
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const positions = await getPositions();
		const match = positions.find(
			(position) =>
				position.directionEnum === direction &&
				position.baseAssetAmountRaw.gte(minimumSatisfiedAmount)
		);

		if (match) {
			return match;
		}

		await sleep(POLL_INTERVAL_MS);
	}

	return null;
}

async function waitForAllPositionsClosed(
	timeoutMs: number = CLOSE_TIMEOUT_MS
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;

	while (Date.now() < deadline) {
		const positions = await getPositions();
		if (positions.length === 0) {
			return true;
		}
		await sleep(POLL_INTERVAL_MS);
	}

	return false;
}

type ExecutableTransaction = VersionedTransaction | Transaction;

function ensureExecutableTransaction(result: any): ExecutableTransaction {
	if (result instanceof VersionedTransaction || result instanceof Transaction) {
		return result;
	}
	if (result && typeof result === 'object' && typeof result.serialize === 'function') {
		return result as ExecutableTransaction;
	}
	throw new Error('Unsupported transaction type returned from CentralServerDrift (Swift orders not supported in arcade flow).');
}

export interface PlacePerpLimitOrderParams {
	direction?: PositionDirection;
	size?: number;
	limitPrice?: number;
	slippageBps?: number;
	waitForFill?: boolean;
	marketIndex?: number;
}

export interface PlacePerpLimitOrderResult {
	signature?: string;
	position?: PositionSummary | null;
}

async function placePerpLimitOrder(
	params: PlacePerpLimitOrderParams = {}
): Promise<PlacePerpLimitOrderResult> {
	await ensurePerpClientsInitialized();

	const direction = params.direction ?? PositionDirection.LONG;
	const baseSize = params.size ?? DEFAULT_POSITION_SIZE;
	const marketIndex = params.marketIndex ?? MARKET_INDEX;
	const slippageBps = params.slippageBps ?? DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS;
	const amountRaw = Math.round(baseSize * BASE_PRECISION.toNumber());
	const amountBN = new BN(amountRaw);
	const slippagePct = slippageBps / 10_000;

	const resolvedLimitPrice = (() => {
		if (params.limitPrice != null) {
			return params.limitPrice;
		}
		const oracleData = authorityDrift.driftClient.getOracleDataForPerpMarket(marketIndex);
		if (!oracleData) {
			throw new Error('Oracle data unavailable. Cannot place limit order.');
		}
		const oraclePrice = oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
		if (direction === PositionDirection.LONG) {
			return oraclePrice * (1 + slippagePct);
		}
		return oraclePrice * Math.max(0, 1 - slippagePct);
	})();

	const limitPriceRaw = Math.round(resolvedLimitPrice * PRICE_PRECISION.toNumber());
	const limitPriceBN = new BN(limitPriceRaw);

	const limitOrderTxn = await centralServerDrift.getOpenPerpNonMarketOrderTxn(
		userAccountPublicKey,
		marketIndex,
		direction,
		amountBN,
		'base',
		limitPriceBN,
		undefined,
		'limit',
		false,
		undefined,
		false
	);

	const signature = await executeTransaction(
		ensureExecutableTransaction(limitOrderTxn),
		'Open Perp Limit Order'
	);

	let position: PositionSummary | null = null;
	if (params.waitForFill ?? true) {
		position = await waitForPositionFill(direction, amountBN);
	}

	return { signature, position };
}

export interface ClosePerpPositionsOptions {
	direction?: PositionDirection;
	marketIndex?: number;
	waitForClose?: boolean;
}

export interface ClosePerpPositionsResult {
	signatures: string[];
	remainingPositions: PositionSummary[];
}

async function closePerpPositions(
	options: ClosePerpPositionsOptions = {}
): Promise<ClosePerpPositionsResult> {
	await ensurePerpClientsInitialized();
	const targetMarketIndex = options.marketIndex ?? MARKET_INDEX;
	const openPositions = await getPositions();
	const targets = openPositions.filter((pos) => {
		const matchesMarket = pos.marketIndex === targetMarketIndex;
		const matchesDirection = options.direction
			? pos.directionEnum === options.direction
			: true;
		return matchesMarket && matchesDirection;
	});

	if (targets.length === 0) {
		return { signatures: [], remainingPositions: openPositions };
	}

	const signatures: string[] = [];
	for (const position of targets) {
		if (position.baseAssetAmountRaw.isZero()) {
			continue;
		}
		const closeDirection =
			position.direction === 'LONG'
				? PositionDirection.SHORT
				: PositionDirection.LONG;
		const closeOrderTxn = await centralServerDrift.getOpenPerpMarketOrderTxn(
			userAccountPublicKey,
			'base',
			position.marketIndex,
			closeDirection,
			position.baseAssetAmountRaw,
			authorityDrift.driftEndpoints.dlobServerHttpUrl,
			{ reduceOnly: true },
			false
		);
		const sig = await executeTransaction(
			ensureExecutableTransaction(closeOrderTxn),
			'Close Perp Position'
		);
		if (sig) {
			signatures.push(sig);
		}
	}

	if (options.waitForClose ?? true) {
		await waitForAllPositionsClosed();
	}

	const remainingPositions = await getPositions();
	return { signatures, remainingPositions };
}

async function getOpenPerpPositions(): Promise<PositionSummary[]> {
	await ensurePerpClientsInitialized();
	return getPositions();
}

export interface PlaceLimitOrderRequest extends PlacePerpLimitOrderParams {
	orderId: string;
	targetPrice: number;
}

export interface PlaceLimitOrderResponse extends PlacePerpLimitOrderResult {
	direction: PositionDirection;
	marketIndex: number;
}

export interface ClosePositionsResponse extends ClosePerpPositionsResult {
	direction?: PositionDirection;
	marketIndex: number;
}

export interface PerpTradingService {
	initialize(): Promise<void>;
	placeLimitOrder(request: PlaceLimitOrderRequest): Promise<PlaceLimitOrderResponse>;
	handleTrigger(orderId: string): Promise<ClosePositionsResponse>;
	handleExpiry(orderId: string): Promise<ClosePositionsResponse>;
	getOpenPositions(): Promise<PositionSummary[]>;
}

export class DriftPerpTradingService implements PerpTradingService {
	private readonly orderMeta = new Map<string, { direction: PositionDirection; marketIndex: number }>();

	public async initialize(): Promise<void> {
		await ensurePerpClientsInitialized();
	}

	public async placeLimitOrder(
		request: PlaceLimitOrderRequest
	): Promise<PlaceLimitOrderResponse> {
		await this.initialize();
		const marketIndex = request.marketIndex ?? MARKET_INDEX;
		const direction = request.direction ?? this.inferDirection(request.targetPrice, marketIndex);
		const result = await placePerpLimitOrder({
			direction,
			size: request.size,
			limitPrice: request.targetPrice,
			slippageBps: request.slippageBps,
			waitForFill: request.waitForFill ?? false,
			marketIndex,
		});
		this.orderMeta.set(request.orderId, { direction, marketIndex });
		return { ...result, direction, marketIndex };
	}

	public async handleTrigger(orderId: string): Promise<ClosePositionsResponse> {
		return this.closeAndMaybeForget(orderId);
	}

	public async handleExpiry(orderId: string): Promise<ClosePositionsResponse> {
		return this.closeAndMaybeForget(orderId);
	}

	public async getOpenPositions(): Promise<PositionSummary[]> {
		await this.initialize();
		return getOpenPerpPositions();
	}

	private inferDirection(targetPrice: number, marketIndex: number): PositionDirection {
		try {
			const authority = getAuthorityDriftInstance();
			const oracle = authority.driftClient.getOracleDataForPerpMarket(marketIndex);
			if (!oracle) {
				return PositionDirection.LONG;
			}
			const price = oracle.price.toNumber() / PRICE_PRECISION.toNumber();
			return targetPrice >= price ? PositionDirection.LONG : PositionDirection.SHORT;
		} catch (_err) {
			return PositionDirection.LONG;
		}
	}

	private async closeAndMaybeForget(orderId: string): Promise<ClosePositionsResponse> {
		await this.initialize();
		const meta = this.orderMeta.get(orderId);
		const marketIndex = meta?.marketIndex ?? MARKET_INDEX;
		const result = await closePerpPositions({
			direction: meta?.direction,
			marketIndex,
			waitForClose: true,
		});
		this.orderMeta.delete(orderId);
		return { ...result, direction: meta?.direction, marketIndex };
	}
}

async function getPositionOnly() {
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}`);
	console.log(`${GREEN}     DRIFT GET POSITIONS${NC}`);
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}\n`);

	await initializeClients();

	try {
		console.log(`${YELLOW}🔍 Fetching positions...${NC}`);
		const positions = await getPositions();
		console.log(`\n${GREEN}Found ${positions.length} position(s)${NC}\n`);

		if (positions.length > 0) {
			positions.forEach((pos, index) =>
				printPositionDetails(pos, `Remaining Position ${index + 1}`)
			);
		} else {
			console.log('No open positions found');
		}
	} catch (error: any) {
		console.error(`${RED}❌ Error:${NC}`, error.message);
		if (error.logs) {
			console.error('Transaction logs:', error.logs);
		}
	} finally {
		// Cleanup
		console.log('👋 Unsubscribing...');
		await authorityDrift.unsubscribe();
		console.log('✅ Done!');
	}
}

async function runPerpTestFlow() {
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}`);
	console.log(`${GREEN}     DRIFT PERP TRADING TEST FLOW${NC}`);
	console.log(`${GREEN}═══════════════════════════════════════════════${NC}\n`);

	// Enable stdin for user input
	process.stdin.resume();
	process.stdin.setEncoding('utf8');

	await initializeClients();

	try {
		// Step 1: Check initial positions
		console.log(`${YELLOW}📊 Step 1: Checking initial positions...${NC}`);
		let positions = await getPositions();
		console.log(`Found ${positions.length} open position(s)`);
		if (positions.length > 0) {
			positions.forEach((pos, index) =>
				printPositionDetails(pos, `Existing Position ${index + 1}`)
			);
		}
		console.log();

		// Step 2: Place a limit order to open a long position
		console.log(`${YELLOW}📈 Step 2: Opening LONG position with limit order...${NC}`);
		console.log(`Market: SOL-PERP`);
		console.log(`Size: ${POSITION_SIZE} SOL`);
		console.log(`Direction: LONG`);

		const amountRaw = Math.round(
			parseFloat(POSITION_SIZE) * BASE_PRECISION.toNumber()
		);
		const amountBN = new BN(amountRaw);
		const oracleData = authorityDrift.driftClient.getOracleDataForPerpMarket(MARKET_INDEX);
		if (!oracleData) {
			throw new Error('Oracle data unavailable. Cannot place limit order.');
		}
		const oraclePrice = oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
		const slippagePct = LIMIT_ORDER_SLIPPAGE_BPS / 10_000;
		const limitPrice = oraclePrice * (1 + slippagePct);
		const limitPriceRaw = Math.round(
			limitPrice * PRICE_PRECISION.toNumber()
		);
		const limitPriceBN = new BN(limitPriceRaw);

		console.log(`Current Oracle Price: $${oraclePrice.toFixed(2)}`);
		console.log(
			`Submitting limit order at $${limitPrice.toFixed(2)} (${(slippagePct * 100).toFixed(2)}% above oracle)`
		);

		const limitOrderTxn = await centralServerDrift.getOpenPerpNonMarketOrderTxn(
			userAccountPublicKey,
			MARKET_INDEX,
			PositionDirection.LONG,
			amountBN,
			'base',
			limitPriceBN,
			undefined,
			'limit',
			false,
			undefined,
			false
		);

		console.log(`✅ Limit order transaction prepared.`);
		await executeTransaction(
			limitOrderTxn as VersionedTransaction,
			'Open Perp Limit Order'
		);

		console.log(`${YELLOW}⏳ Waiting for position to fill...${NC}`);
		let filledPosition = await waitForPositionFill(
			PositionDirection.LONG,
			amountBN
		);

		// Step 3: Verify position was created
		console.log(`${YELLOW}📊 Step 3: Verifying position creation...${NC}`);
		if (!filledPosition) {
			await sleep(POLL_INTERVAL_MS);
			positions = await getPositions();
			filledPosition = positions[0];
		} else {
			positions = [filledPosition];
		}

		console.log(`Found ${positions.length} open position(s)`);

		if (filledPosition) {
			printPositionDetails(filledPosition);
		} else {
			console.log('⚠️  Limit order not filled within timeout window.');
			console.log(`${YELLOW}🛑 Flow will stop since there is no position to manage.${NC}`);
			return;
		}
		console.log();

		// Step 4: Wait and check PnL
		console.log(`${YELLOW}⏰ Step 5: Waiting 5 seconds to check PnL...${NC}`);
		await sleep(5000);

		positions = await getPositions();
		if (positions.length > 0) {
			const pos = positions[0];
			console.log(`${GREEN}💰 Current PnL:${NC}`);
			console.log(`  Entry Price: $${pos.entryPrice.toFixed(2)}`);
			console.log(`  Current Mark Price: $${pos.currentPrice.toFixed(2)}`);
			console.log(
				`  Liquidation Price: ${pos.liquidationPrice > 0
					? `$${pos.liquidationPrice.toFixed(2)}`
					: 'N/A'
				}`
			);
			console.log(`  PnL: ${pos.pnl >= 0 ? GREEN : RED}$${pos.pnl.toFixed(4)}${NC}`);
			console.log(`  PnL %: ${pos.pnl >= 0 ? GREEN : RED}${((pos.pnl / pos.notional) * 100).toFixed(2)}%${NC}`);
		}
		console.log();

		// Step 5: Ask for user confirmation before closing
		console.log(`${YELLOW}🔒 Step 6: Ready to close position${NC}`);
		console.log(`${GREEN}✋ Please check the position in the UI at https://app.drift.trade${NC}`);
		console.log(`${YELLOW}Press Enter when ready to close the position...${NC}`);

		// Wait for user input
		await new Promise(resolve => {
			process.stdin.once('data', resolve);
		});

		console.log(`${YELLOW}Closing position...${NC}`);

		// Get the actual position to close the exact amount
		positions = await getPositions();
		if (positions.length === 0) {
			console.log(`${YELLOW}⚠️  No position to close${NC}`);
			return;
		}

		// Close using the exact position size from the current position
		const positionToClose = positions[0];
		const baseAssetAmount = positionToClose.baseAssetAmountRaw;
		if (baseAssetAmount.isZero()) {
			console.log(`${YELLOW}⚠️  Position size already zero. Skipping close.${NC}`);
		} else {
			const closeDirection = positionToClose.direction === 'LONG'
				? PositionDirection.SHORT
				: PositionDirection.LONG;
			console.log(
				`Closing ${positionToClose.direction} position of ${positionToClose.size} SOL`
			);

			const closeOrderTxn = await centralServerDrift.getOpenPerpMarketOrderTxn(
				userAccountPublicKey,
				'base',
				MARKET_INDEX,
				closeDirection,
				baseAssetAmount,
				authorityDrift.driftEndpoints.dlobServerHttpUrl,
				{ reduceOnly: true },
				false
			);

			console.log(`✅ Close order transaction prepared.`);
			await executeTransaction(
				closeOrderTxn as VersionedTransaction,
				'Close Perp Position'
			);
		}

		// Step 7: Verify position is closed
		console.log(`${YELLOW}✅ Step 7: Verifying position closure...${NC}`);
		const fullyClosed = await waitForAllPositionsClosed();
		positions = fullyClosed ? [] : await getPositions();
		console.log(`Found ${positions.length} open position(s)`);

		if (positions.length === 0) {
			console.log(`${GREEN}✅ All positions successfully closed!${NC}`);
		} else {
			console.log(`${YELLOW}⚠️  Still have open positions:${NC}`);
			positions.forEach((pos, index) =>
				printPositionDetails(pos, `Remaining Position ${index + 1}`)
			);
		}

	} catch (error: any) {
		console.error(`${RED}❌ Error:${NC}`, error.message);
		if (error.logs) {
			console.error('Transaction logs:', error.logs);
		}
	} finally {
		// Cleanup
		console.log('\n👋 Unsubscribing...');
		await authorityDrift.unsubscribe();
		console.log('✅ Done!');
	}
}

// Run if called directly
if (require.main === module) {
	// Check for CLI arguments
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
