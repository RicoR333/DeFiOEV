# OEV Searcher Agent

An educational Oracle Extractable Value (OEV) searcher that monitors Morpho Blue lending positions on Base and identifies liquidation opportunities.

## What is OEV?

**Oracle Extractable Value (OEV)** is value that can be captured by controlling the timing of oracle price updates. In DeFi lending protocols:

1. Users deposit collateral and borrow assets
2. Positions become liquidatable when collateral value drops (relative to debt)
3. Liquidators repay the debt and receive collateral at a discount (the "liquidation bonus")

Traditionally, liquidations happen through competitive bidding - whoever gets their transaction included first wins. This leads to:
- Gas wars and priority fee bidding
- Value extraction by block builders (MEV)
- Unpredictable profitability for liquidators

**With OEV (via API3's OEV Network):**
- Searchers bid for the right to update oracle prices
- Winners can atomically update prices and liquidate in one transaction
- Bid proceeds go back to the dApp (not lost to MEV)
- More predictable and efficient liquidations

## Features

- 📊 **Real Data**: Fetches live positions from Morpho Blue subgraph
- 💰 **Real Prices**: Gets prices from API3 and CoinGecko
- 🔍 **Health Analysis**: Calculates health factors for all positions
- 🎯 **Opportunity Detection**: Identifies liquidatable positions
- 📈 **Paper Trading**: Tracks hypothetical P&L without real execution
- 🎨 **Beautiful Output**: Colorful, structured console output

## Architecture

```
src/
├── index.ts              # Main entry point and orchestration
├── data/
│   ├── morpho.ts         # Morpho Blue subgraph queries
│   └── prices.ts         # API3 and CoinGecko price feeds
├── agent/
│   ├── analyzer.ts       # Health factor calculations
│   └── tracker.ts        # Paper trading P&L tracker
└── utils/
    └── logger.ts         # Formatted console output
```

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd DeFiOEV

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Build TypeScript
npm run build

# Run the agent
npm start
```

## Development

```bash
# Run in development mode (with ts-node)
npm run dev

# Watch mode (recompile on changes)
npm run watch
```

## Configuration

See `.env.example` for all configuration options. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `SCAN_INTERVAL_MS` | 60000 | Time between scans (ms) |
| `MAX_POSITIONS` | 200 | Max positions to analyze |
| `HEALTH_THRESHOLD` | 1.1 | Alert when health < this |
| `LIQUIDATION_BONUS` | 0.05 | Expected liquidation bonus |
| `MIN_PROFIT_USD` | 10 | Minimum profit to consider |
| `CONTINUOUS_MODE` | true | Run continuously |

## Understanding Health Factors

The **Health Factor** determines if a position can be liquidated:

```
Health Factor = (Collateral Value × LLTV) / Debt Value
```

- **HF > 1**: Position is healthy, cannot be liquidated
- **HF = 1**: At liquidation threshold
- **HF < 1**: Position can be liquidated

**Example:**
- Collateral: 1 ETH worth $3,000
- LLTV: 86%
- Debt: $2,000 USDC
- Health Factor = ($3,000 × 0.86) / $2,000 = 1.29 ✅

If ETH drops to $2,500:
- Health Factor = ($2,500 × 0.86) / $2,000 = 1.075 ⚠️ (at risk)

If ETH drops to $2,300:
- Health Factor = ($2,300 × 0.86) / $2,000 = 0.989 🔴 (liquidatable!)

## Paper Trading vs Real Trading

This agent runs in **paper trading mode** only. It:

✅ Fetches real position data
✅ Uses real price feeds
✅ Calculates accurate health factors
✅ Tracks what profits would have been

❌ Does NOT execute actual liquidations
❌ Does NOT send any transactions
❌ Does NOT interact with smart contracts

**Why paper trade first?**
1. Validate your strategy without risking capital
2. Understand opportunity frequency and size
3. Test price feed accuracy
4. Learn the market dynamics

**Paper trading overestimates real profits because:**
- Gas costs can be $5-50+ per liquidation
- Other searchers compete for the same opportunities
- Large liquidations can cause price slippage
- Block builders may extract MEV from your transactions

## Morpho Blue Markets

Morpho Blue is a minimalist lending protocol where:

- Each market is isolated (separate risk)
- Markets are defined by: collateral token, loan token, oracle, LLTV
- Anyone can create markets (permissionless)
- No governance needed for parameter changes

Popular Base markets include:
- WETH/USDC (borrow USDC against ETH)
- cbBTC/USDC (borrow USDC against Bitcoin)
- wstETH/WETH (borrow ETH against staked ETH)

## API3 OEV Integration

This agent is designed to work with API3's OEV Network in the future:

1. **Detection**: Identify positions near liquidation
2. **Bidding**: Bid on the OEV Network for price update rights
3. **Execution**: Update price and liquidate atomically
4. **Profit**: Capture liquidation bonus minus bid amount

The bid proceeds go back to the dApp (Morpho), creating a win-win:
- Dapps receive OEV revenue
- Searchers get predictable opportunities
- Users experience faster, more efficient liquidations

## Example Output

```
╔═══════════════════════════════════════════════════════════════╗
║             Oracle Extractable Value Searcher                 ║
║                  Morpho Blue on Base                          ║
╚═══════════════════════════════════════════════════════════════╝

📊 Fetching positions from Morpho Blue...
Found 150 active positions

💰 Fetching token prices...
  ETH: $3,500
  USDC: $1.00
  wstETH: $4,000

🔍 Analyzing positions...

═══════════════════════════════════════════════════════════════
POSITION ANALYSIS SUMMARY
═══════════════════════════════════════════════════════════════
  Total positions analyzed: 150
  🔴 Liquidatable (HF < 1.0): 2
  🟡 At risk (HF < 1.1):      8
  🟢 Healthy (HF >= 1.1):     140

  💰 Total estimated profit: $1,234.56

 🎯 LIQUIDATION OPPORTUNITY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Borrower:        0x1234...5678
  Health Factor:   0.9823
  Est. Profit:     $567.89
  Details:         WETH/USDC market
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Educational Resources

### DeFi Lending
- [Morpho Blue Docs](https://docs.morpho.org/)
- [Understanding Health Factors](https://docs.aave.com/faq/borrowing#what-is-the-health-factor)

### MEV and OEV
- [Flashbots MEV Research](https://writings.flashbots.net/)
- [API3 OEV Documentation](https://docs.api3.org/)

### Technical
- [The Graph Subgraphs](https://thegraph.com/docs/)
- [viem Documentation](https://viem.sh/)

## Disclaimer

⚠️ **This is for EDUCATIONAL PURPOSES ONLY**

- This code is provided as-is with no warranties
- Paper trading results do not guarantee real trading profits
- Always do your own research before deploying capital
- DeFi protocols carry significant risks including smart contract bugs, oracle manipulation, and market volatility

## License

MIT
