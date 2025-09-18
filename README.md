# Trading Arcade Game - Jupiter Perpetuals


A real-money trading arcade game built on Jupiter Perpetuals where each "box" represents an actual perpetual position with automatic take-profit orders.

## Architecture

### Core Components

1. **Game Engine** (`game-engine.ts`)
   - Manages actual Jupiter Perps positions
   - Creates positions with automatic TP limit orders
   - Monitors positions for liquidation and TP hits
   - Handles position lifecycle (preview → open → tp_hit/liquidated)

2. **Price Streamer** (`sol-price-streamer.ts`)
   - Streams real-time SOL prices from Doves oracle
   - Calculates live payout multiples
   - Monitors distance to TP and liquidation
   - WebSocket + polling for reliability

3. **Zustand Store** (`store/game-store.ts`)
   - Centralized state management
   - Four slices: prices, boxes, game, perps
   - Real-time PnL calculations
   - Score and game mode management

## Game Mechanics

### Box Lifecycle
```
Preview → Pending → Open → TP Hit / Liquidated / Expired
```

1. **Preview**: User drags on chart to preview box
2. **Pending**: Transaction submitted to blockchain
3. **Open**: Position created, TP limit order placed
4. **TP Hit**: Take profit reached, position closes automatically
5. **Liquidated**: Price moved against position beyond margin
6. **Expired**: Arcade mode timer expired (closes at market)

### Payout Calculation
```
Payout Multiple = (Margin + Net PnL) / Margin
```
- Accounts for actual Jupiter Perps fees
- Real-time funding rate accumulation
- Price impact based on position size

### Game Modes

**Arcade Mode**
- Time limited (1-5 minutes)
- Score based on payout multiples
- Positions auto-close on expiry
- Leaderboard eligible

**Sandbox Mode**
- No time limit
- Practice with real positions
- Full control over position lifecycle

## Technical Integration

### Jupiter Perpetuals Mapping
- **Position Creation**: `constructMarketOpenPositionTrade()`
- **TP Orders**: `instantCreateLimitOrder()` with trigger price
- **Liquidation Monitoring**: Position account subscriptions
- **PnL Calculation**: Real-time from position state

### Account Subscriptions
```typescript
// Position monitoring
connection.onAccountChange(positionPubkey, ...)

// Limit order monitoring  
connection.onAccountChange(limitOrderPubkey, ...)

// Price feed streaming
connection.onProgramAccountChange(DOVES_PROGRAM_ID, ...)
```

## Running the Demo

1. Install dependencies:
```bash
npm install
```

2. Set up environment:
```bash
# ../.env
TEST_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://api.mainnet-beta.solana.com
```

3. Run the demo:
```bash
npm run dev
```

## Safety Features

- **Leverage Caps**: Maximum 10x leverage
- **Margin Limits**: $10 min, $1000 max per box
- **Liquidation Warnings**: Visual alerts when approaching liquidation
- **Slippage Protection**: 5% default slippage tolerance
- **Fee Transparency**: All fees shown before placing position

## UI Integration (React Native)

### Skia Chart Component
```tsx
<SkiaChart>
  <PriceLine current={price} />
  <Box 
    entry={box.entryPrice}
    tp={box.tpPrice}
    liq={box.liquidationPrice}
    status={box.status}
  />
</SkiaChart>
```

### Animations
- **TP Hit**: Green glow → collapse → coin burst
- **Liquidation**: Red flash → shake → crumble
- **Hover**: Spring animation on payout multiple

### Gesture Handling
```tsx
const gesture = Gesture.Pan()
  .onUpdate((e) => {
    // Update preview box
    previewBox.tpPrice = priceFromY(e.y)
  })
  .onEnd(() => {
    // Create actual position
    gameEngine.createBox(previewBox)
  })
```

## Production Considerations

1. **RPC Optimization**
   - Use dedicated RPC with getProgramAccounts caching
   - Batch account fetches
   - Implement exponential backoff

2. **Transaction Management**
   - Priority fees for faster execution
   - Transaction retry logic
   - Confirmation monitoring

3. **Risk Management**
   - Position size limits based on pool liquidity
   - Max open positions per user
   - Emergency close-all functionality

4. **Error Handling**
   - Graceful degradation on RPC failures
   - Transaction simulation before submission
   - User-friendly error messages

## Game Scoring Formula

```typescript
score = Σ(payoutMultiple * 100) - (liquidations * 50)
```

**Multiplier Bonuses:**
- 10x+ payout: Diamond tier (+500 bonus)
- 5x+ payout: Legendary tier (+200 bonus)
- 3x+ payout: Epic tier (+100 bonus)

## Next Steps

1. **React Native UI**: Implement Skia-based chart with gesture controls
2. **Leaderboard**: On-chain high scores using Solana accounts
3. **Sound Effects**: Position events trigger arcade sounds
4. **Social Features**: Share winning positions as NFTs
5. **Tournament Mode**: Scheduled competitions with prize pools
