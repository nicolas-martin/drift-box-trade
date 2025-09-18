import * as anchor from '@coral-xyz/anchor';
import {
	Connection,
	PublicKey,
	Transaction,
	VersionedTransaction,
} from '@solana/web3.js';
import {
	BN,
	BASE_PRECISION,
	PRICE_PRECISION,
	QUOTE_PRECISION,
	PositionDirection,
	loadKeypair,
} from '@drift-labs/sdk';
import nacl from 'tweetnacl';
import { Buffer } from 'buffer';
import { AuthorityDrift } from './Drift/clients/AuthorityDrift';
import { CentralServerDrift } from './Drift/clients/CentralServerDrift';
import * as path from 'path';

const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '.env') });

const POSITION_SIZE = '0.01';
export const DEFAULT_POSITION_SIZE = parseFloat(POSITION_SIZE);
const DEFAULT_MARKET_INDEX = 0;
export const MARKET_INDEX = Number(process.env.MARKET_INDEX ?? DEFAULT_MARKET_INDEX);
const FILL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;
const FILL_TOLERANCE_PERCENT = 95;
const LIMIT_ORDER_SLIPPAGE_BPS = 10;
export const DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS = LIMIT_ORDER_SLIPPAGE_BPS;

const GREEN = '\x1b[32m';
const NC = '\x1b[0m';

const BN_100 = new BN(100);

type SwiftEnabledWallet = anchor.Wallet & {
	signMessage(message: Uint8Array): Promise<Uint8Array>;
};

type ExecutableTransaction = VersionedTransaction | Transaction;

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

export interface PlaceLimitOrderRequest {
	orderId: string;
	targetPrice: number;
	direction?: PositionDirection;
	size?: number;
	slippageBps?: number;
	waitForFill?: boolean;
	marketIndex?: number;
}

export interface PlaceLimitOrderResponse {
	signature?: string;
	position?: PositionSummary | null;
	direction: PositionDirection;
	marketIndex: number;
}

export interface ClosePositionsResponse {
	signatures: string[];
	remainingPositions: PositionSummary[];
	direction?: PositionDirection;
	marketIndex: number;
}

export interface PerpTradingService {
	initialize(): Promise<void>;
	placeLimitOrder(request: PlaceLimitOrderRequest): Promise<PlaceLimitOrderResponse>;
	handleTrigger(orderId: string): Promise<ClosePositionsResponse>;
	handleExpiry(orderId: string): Promise<ClosePositionsResponse>;
	getOpenPositions(): Promise<PositionSummary[]>;
	getAuthorityDrift(): AuthorityDrift;
	getCentralServerDrift(): CentralServerDrift;
	getUserAccountPublicKey(): PublicKey;
}

export class ArcadePerpService implements PerpTradingService {
	private static instance: ArcadePerpService;

	private authorityDrift?: AuthorityDrift;
	private centralServerDrift?: CentralServerDrift;
	private userAccountPublicKey?: PublicKey;
	private wallet?: SwiftEnabledWallet;
	private connection?: Connection;
	private initializePromise: Promise<void> | null = null;
	private readonly orderMeta = new Map<string, { direction: PositionDirection; marketIndex: number }>();

	public static getInstance(): ArcadePerpService {
		if (!ArcadePerpService.instance) {
			ArcadePerpService.instance = new ArcadePerpService();
		}
		return ArcadePerpService.instance;
	}

	private constructor() { }

	public async initialize(): Promise<void> {
		if (this.authorityDrift && this.centralServerDrift && this.userAccountPublicKey && this.wallet && this.connection) {
			return;
		}
		if (this.initializePromise) {
			return this.initializePromise;
		}

		this.initializePromise = (async () => {
			console.log(`${GREEN}🚀 Initializing Drift clients...${NC}`);

			if (!process.env.ANCHOR_WALLET) {
				throw new Error('ANCHOR_WALLET must be set in .env file');
			}

			if (!process.env.ENDPOINT) {
				throw new Error('ENDPOINT environment variable must be set to your Solana RPC endpoint');
			}

			class SwiftWallet extends anchor.Wallet {
				async signMessage(message: Uint8Array): Promise<Uint8Array> {
					if (!this.payer) {
						throw new Error('Wallet must have a payer to sign messages');
					}
					return nacl.sign.detached(message, this.payer.secretKey);
				}
			}

			this.wallet = new SwiftWallet(loadKeypair(process.env.ANCHOR_WALLET as string)) as SwiftEnabledWallet;

			this.connection = new Connection(process.env.ENDPOINT as string, {
				commitment: 'confirmed',
				httpHeaders: process.env.RPC_API_KEY
					? { Authorization: `Bearer ${process.env.RPC_API_KEY}` }
					: undefined,
			});

			this.authorityDrift = new AuthorityDrift({
				solanaRpcEndpoint: process.env.ENDPOINT as string,
				driftEnv: 'mainnet-beta',
				wallet: this.wallet,
				additionalDriftClientConfig: {
					connection: this.connection,
					txVersion: 0,
					txParams: {
						computeUnits: 300000,
						computeUnitsPrice: 1000,
					},
				},
			});

			await this.authorityDrift.subscribe();

			if (!this.authorityDrift.driftClient.hasUser(0)) {
				await this.authorityDrift.driftClient.addUser(0, this.wallet.publicKey);
			}
			this.userAccountPublicKey = await this.authorityDrift.driftClient.getUserAccountPublicKey(
				0,
				this.wallet.publicKey
			);

			const rpcApiKey = process.env.RPC_API_KEY;
			this.centralServerDrift = new CentralServerDrift({
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
			await this.centralServerDrift.subscribe();
		})();

		try {
			await this.initializePromise;
		} finally {
			this.initializePromise = null;
		}
	}

	public async placeLimitOrder(request: PlaceLimitOrderRequest): Promise<PlaceLimitOrderResponse> {
		await this.initialize();

		const marketIndex = request.marketIndex ?? MARKET_INDEX;
		const direction = request.direction ?? this.inferDirection(request.targetPrice, marketIndex);
		const baseSize = request.size ?? DEFAULT_POSITION_SIZE;
		const slippageBps = request.slippageBps ?? DEFAULT_LIMIT_ORDER_SLIPPAGE_BPS;

		const amountRaw = Math.round(baseSize * BASE_PRECISION.toNumber());
		const amountBN = new BN(amountRaw);
		const slippagePct = slippageBps / 10_000;

		const limitPrice = this.resolveLimitPrice({
			direction,
			marketIndex,
			explicitPrice: request.targetPrice,
			slippagePct,
		});

		const limitPriceRaw = Math.round(limitPrice * PRICE_PRECISION.toNumber());
		const limitPriceBN = new BN(limitPriceRaw);

		const limitOrderTxn = await this.centralServerDrift!.getOpenPerpNonMarketOrderTxn(
			this.userAccountPublicKey!,
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

		const signature = await this.executeTransaction(
			limitOrderTxn,
			'Open Perp Limit Order'
		);

		let position: PositionSummary | null = null;
		if (request.waitForFill ?? true) {
			position = await this.waitForPositionFill(direction, amountBN);
		}

		this.orderMeta.set(request.orderId, { direction, marketIndex });

		return { signature, position, direction, marketIndex };
	}

	public async handleTrigger(orderId: string): Promise<ClosePositionsResponse> {
		return this.closeAndCleanup(orderId);
	}

	public async handleExpiry(orderId: string): Promise<ClosePositionsResponse> {
		return this.closeAndCleanup(orderId);
	}

	public async getOpenPositions(): Promise<PositionSummary[]> {
		await this.initialize();
		return this.collectPositions();
	}

	public getAuthorityDrift(): AuthorityDrift {
		if (!this.authorityDrift) {
			throw new Error('AuthorityDrift is not initialized. Call initialize() first.');
		}
		return this.authorityDrift;
	}

	public getCentralServerDrift(): CentralServerDrift {
		if (!this.centralServerDrift) {
			throw new Error('CentralServerDrift is not initialized. Call initialize() first.');
		}
		return this.centralServerDrift;
	}

	public getUserAccountPublicKey(): PublicKey {
		if (!this.userAccountPublicKey) {
			throw new Error('User account not initialized. Call initialize() first.');
		}
		return this.userAccountPublicKey;
	}

	private async closeAndCleanup(orderId: string): Promise<ClosePositionsResponse> {
		await this.initialize();
		const meta = this.orderMeta.get(orderId);
		const marketIndex = meta?.marketIndex ?? MARKET_INDEX;

		const result = await this.closePerpPositions({
			direction: meta?.direction,
			marketIndex,
			waitForClose: true,
		});

		this.orderMeta.delete(orderId);
		return { ...result, direction: meta?.direction, marketIndex };
	}

	private resolveLimitPrice({
		direction,
		marketIndex,
		explicitPrice,
		slippagePct,
	}: {
		direction: PositionDirection;
		marketIndex: number;
		explicitPrice?: number;
		slippagePct: number;
	}): number {
		if (explicitPrice != null) {
			return explicitPrice;
		}
		const oracleData = this.authorityDrift!.driftClient.getOracleDataForPerpMarket(marketIndex);
		if (!oracleData) {
			throw new Error('Oracle data unavailable. Cannot place limit order.');
		}
		const oraclePrice = oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
		if (direction === PositionDirection.LONG) {
			return oraclePrice * (1 + slippagePct);
		}
		return oraclePrice * Math.max(0, 1 - slippagePct);
	}

	private inferDirection(targetPrice: number, marketIndex: number): PositionDirection {
		try {
			const oracleData = this.authorityDrift!.driftClient.getOracleDataForPerpMarket(marketIndex);
			if (!oracleData) {
				return PositionDirection.LONG;
			}
			const oraclePrice = oracleData.price.toNumber() / PRICE_PRECISION.toNumber();
			return targetPrice >= oraclePrice ? PositionDirection.LONG : PositionDirection.SHORT;
		} catch (_err) {
			return PositionDirection.LONG;
		}
	}

	private async closePerpPositions({
		direction,
		marketIndex,
		waitForClose = true,
	}: {
		direction?: PositionDirection;
		marketIndex: number;
		waitForClose?: boolean;
	}): Promise<{ signatures: string[]; remainingPositions: PositionSummary[] }> {
		const openPositions = await this.collectPositions();
		const targets = openPositions.filter((pos) => {
			const matchesMarket = pos.marketIndex === marketIndex;
			const matchesDirection = direction ? pos.directionEnum === direction : true;
			return matchesMarket && matchesDirection;
		});

		if (targets.length === 0) {
			return { signatures: [], remainingPositions: openPositions };
		}

		const signatures: string[] = [];
		for (const position of targets) {
			if (position.baseAssetAmountRaw.isZero()) continue;

			const closeDirection =
				position.direction === 'LONG'
					? PositionDirection.SHORT
					: PositionDirection.LONG;

			const closeOrderTxn = await this.centralServerDrift!.getOpenPerpMarketOrderTxn(
				this.userAccountPublicKey!,
				'base',
				position.marketIndex,
				closeDirection,
				position.baseAssetAmountRaw,
				this.authorityDrift!.driftEndpoints.dlobServerHttpUrl,
				{ reduceOnly: true },
				false
			);

			const sig = await this.executeTransaction(
				closeOrderTxn,
				'Close Perp Position'
			);
			if (sig) {
				signatures.push(sig);
			}
		}

		if (waitForClose) {
			await this.waitForAllPositionsClosed();
		}

		const remainingPositions = await this.collectPositions();
		return { signatures, remainingPositions };
	}

	private async executeTransaction(txnResult: any, transactionType: string): Promise<string | undefined> {
		const txn = this.ensureExecutableTransaction(txnResult);

		console.log(`✅ ${transactionType} transaction prepared`);
		console.log('\n📝 Signing Transaction...');

		if (txn instanceof VersionedTransaction) {
			txn.sign([this.wallet!.payer]);
		} else {
			txn.sign(this.wallet!.payer);
		}
		console.log('✅ Transaction signed successfully');

		console.log('\n🚀 Sending transaction to the network...');
		const { txSig } = await this.centralServerDrift!.sendSignedTransaction(txn);
		const signature = txSig?.toString();
		console.log('✅ Transaction sent successfully!');
		if (signature) {
			console.log(`📋 Transaction Signature: ${signature}`);
			console.log(`🔍 View on Solscan: https://solscan.io/tx/${signature}`);
		}
		console.log();
		return signature;
	}

	private ensureExecutableTransaction(result: any): ExecutableTransaction {
		if (result instanceof VersionedTransaction || result instanceof Transaction) {
			return result;
		}
		if (result && typeof result === 'object' && typeof result.serialize === 'function') {
			return result as ExecutableTransaction;
		}
		throw new Error('Unsupported transaction type returned from CentralServerDrift (Swift orders not supported in arcade flow).');
	}

	private async waitForPositionFill(
		direction: PositionDirection,
		targetAmount: BN,
		timeoutMs: number = FILL_TIMEOUT_MS
	): Promise<PositionSummary | null> {
		const minimumSatisfiedAmount = targetAmount
			.mul(new BN(FILL_TOLERANCE_PERCENT))
			.div(BN_100);
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const positions = await this.collectPositions();
			const match = positions.find(
				(position) =>
					position.directionEnum === direction &&
					position.baseAssetAmountRaw.gte(minimumSatisfiedAmount)
			);

			if (match) {
				return match;
			}

			await this.sleep(POLL_INTERVAL_MS);
		}

		return null;
	}

	private async waitForAllPositionsClosed(timeoutMs: number = CLOSE_TIMEOUT_MS): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const positions = await this.collectPositions();
			if (positions.length === 0) {
				return true;
			}
			await this.sleep(POLL_INTERVAL_MS);
		}

		return false;
	}

	private async collectPositions(): Promise<PositionSummary[]> {
		// Ensure user is loaded
		if (!this.authorityDrift!.driftClient.hasUser(0)) {
			await this.authorityDrift!.driftClient.addUser(0, this.wallet!.publicKey);
		}

		await this.sleep(500);

		const userData = this.authorityDrift!.userAccountCache[`0_${this.wallet!.publicKey.toString()}`];
		if (!userData) {
			return [];
		}

		const positions: PositionSummary[] = [];
		for (const positionInfo of userData.openPerpPositions) {
			const perpMarket = this.authorityDrift!.driftClient.getPerpMarketAccount(MARKET_INDEX);
			const marketName = Buffer.from(perpMarket.name)
				.toString('utf8')
				.replace(/\0/g, '')
				.trim();

			const oracleData = this.authorityDrift!.driftClient.getOracleDataForPerpMarket(MARKET_INDEX);
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

	private sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

export function getArcadePerpService(): ArcadePerpService {
	return ArcadePerpService.getInstance();
}
