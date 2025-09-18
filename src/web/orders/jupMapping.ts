import { PublicKey } from "@solana/web3.js";
import { JUPITER_PERPETUALS_PROGRAM } from "@/jupiter/constants";
import { getLiquidationPrice } from "@/jupiter/getLiquidationPrice";

export type BoxAnnotations = {
  liquidationPriceUsd: string; // red line label
  autoSellPriceUsd: string;    // top of box default
  autoSellTimeMs: number;      // right boundary default (epoch ms)
  multiplierAt1Pct: number;    // e.g., 1.2 for +1% move with 20x
};

export function multiplier(leverage: number, movePct: number) {
  // 1 + (leverage * movePct)
  return 1 + leverage * movePct;
}

export async function deriveBoxAnnotations(positionPk: PublicKey): Promise<BoxAnnotations> {
  const pos = await JUPITER_PERPETUALS_PROGRAM.account.position.fetch(positionPk);
  const { usd: liqUsd } = await getLiquidationPrice(positionPk);

  // Defaults: auto-sell at +1% over entry for longs (below for shorts); time = 60s
  const entryPrice = Number(pos.price) / 1_000_000; // USDC 6 decimals
  const isLong = !!pos.side.long;
  const autoMove = 0.01; // 1%
  const autoPrice = isLong ? entryPrice * (1 + autoMove) : entryPrice * (1 - autoMove);
  const leverage = Number(pos.sizeUsd) / Number(pos.collateralUsd || 1);
  const mAt1Pct = multiplier(leverage, 0.01);

  return {
    liquidationPriceUsd: liqUsd,
    autoSellPriceUsd: autoPrice.toFixed(2),
    autoSellTimeMs: Date.now() + 60_000,
    multiplierAt1Pct: Number.isFinite(mAt1Pct) ? mAt1Pct : 1,
  };
}

