/**
 * OEV Searcher Agent - Main Entry Point
 *
 * This is an educational OEV (Oracle Extractable Value) searcher that monitors
 * Morpho Blue lending positions on Base and identifies liquidation opportunities
 * specifically in markets using API3 oracles.
 *
 * OEV-FOCUSED APPROACH:
 * Unlike traditional liquidation bots that compete in gas wars, this agent
 * focuses on API3-oracle markets where OEV auctions provide:
 * - Exclusive liquidation rights through bidding
 * - No competition on the target chain
 * - Value returned to the protocol instead of block builders
 *
 * WHAT THIS AGENT DOES:
 * 1. Fetches positions from Morpho Blue (API3-oracle markets only)
 * 2. Gets real-time prices from API3/CoinGecko
 * 3. Calculates health factors to identify liquidatable positions
 * 4. Shows OEV auction status for each opportunity
 * 5. Tracks paper trading P&L
 *
 * References:
 * - OEV Network: https://docs.api3.org/oev-searchers/
 * - OEV-Boosted Markets: https://blog.api3.org/introducing-oev-boosted-morpho-markets/
 * - Morpho Blue: https://docs.morpho.org/
 *
 * DISCLAIMER:
 * This is for EDUCATIONAL PURPOSES ONLY. Paper trading mode - no real
 * transactions are executed. Always do your own research.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import logger, { formatUSD, formatNumber, formatAddress } from './utils/logger';
import { fetchAllPositions, getUniqueTokens, AnalyzablePosition } from './data/morpho';
import { getTokenPrices, checkPriceFeedHealth } from './data/prices';
import {
  analyzePositions,
  getLiquidatablePositions,
  getAtRiskPositions,
  printAnalysisSummary,
  calculateLiquidationPriceChange,
  AnalyzerConfig,
  PositionAnalysis,
} from './agent/analyzer';
import { getTracker, PaperTradingTracker } from './agent/tracker';
import {
  API3_MORPHO_MARKETS_BASE,
  getKnownApi3MarketIds,
  isOevEnabledMarket,
  estimateOptimalBid,
  getOevMarketsSummary,
  OEV_NETWORK_CHAIN_ID,
} from './data/oev';

// =============================================================================
// CONFIGURATION
// =============================================================================

interface SearcherConfig {
  scanIntervalMs: number;
  maxPositions: number;
  healthFactorThreshold: number;
  liquidationBonus: number;
  minProfitUSD: number;
  continuousMode: boolean;
  maxScans: number;
  // OEV-specific config
  oevOnly: boolean;  // Only track API3-oracle markets
  showAllPositions: boolean;  // Show non-API3 positions too (for comparison)
}

const DEFAULT_CONFIG: SearcherConfig = {
  scanIntervalMs: 60_000,
  maxPositions: 200,
  healthFactorThreshold: 1.1,
  liquidationBonus: 0.05,
  minProfitUSD: 10,
  continuousMode: true,
  maxScans: 0,
  oevOnly: true,  // Default to OEV-only mode
  showAllPositions: false,
};

function loadConfig(): SearcherConfig {
  return {
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || String(DEFAULT_CONFIG.scanIntervalMs)),
    maxPositions: parseInt(process.env.MAX_POSITIONS || String(DEFAULT_CONFIG.maxPositions)),
    healthFactorThreshold: parseFloat(process.env.HEALTH_THRESHOLD || String(DEFAULT_CONFIG.healthFactorThreshold)),
    liquidationBonus: parseFloat(process.env.LIQUIDATION_BONUS || String(DEFAULT_CONFIG.liquidationBonus)),
    minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD || String(DEFAULT_CONFIG.minProfitUSD)),
    continuousMode: process.env.CONTINUOUS_MODE !== 'false',
    maxScans: parseInt(process.env.MAX_SCANS || String(DEFAULT_CONFIG.maxScans)),
    oevOnly: process.env.OEV_ONLY !== 'false',
    showAllPositions: process.env.SHOW_ALL_POSITIONS === 'true',
  };
}

// =============================================================================
// OEV-SPECIFIC OUTPUT FUNCTIONS
// =============================================================================

/**
 * Print OEV-enhanced position details
 */
function printOevPositionDetails(
  analysis: PositionAnalysis,
  isApi3Market: boolean
): void {
  const {
    position,
    collateralValueUSD,
    debtValueUSD,
    healthFactor,
    isLiquidatable,
    estimatedLiquidationProfit,
  } = analysis;

  // Determine oracle type indicator
  const oracleIndicator = isApi3Market
    ? '✓ API3 Oracle (OEV Enabled)'
    : '✗ Non-API3 Oracle';

  console.log('\n┌─────────────────────────────────────────────────────────┐');
  console.log(`│ Position: ${formatAddress(position.borrower).padEnd(47)} │`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  Market:          ${(position.collateralToken.symbol + '/' + position.loanToken.symbol).padEnd(38)} │`);
  console.log(`│  Oracle:          ${oracleIndicator.padEnd(38)} │`);
  console.log('├─────────────────────────────────────────────────────────┤');
  console.log(`│  Collateral:      ${formatUSD(collateralValueUSD).padEnd(38)} │`);
  console.log(`│  Debt:            ${formatUSD(debtValueUSD).padEnd(38)} │`);

  // Color-coded health factor
  const hfStr = formatNumber(healthFactor, 4);
  const hfStatus = healthFactor < 1.0 ? '🔴 LIQUIDATABLE' :
                   healthFactor < 1.1 ? '🟡 AT RISK' : '🟢 HEALTHY';
  console.log(`│  Health Factor:   ${hfStr.padEnd(15)} ${hfStatus.padEnd(22)} │`);

  if (isLiquidatable && isApi3Market) {
    console.log('├─────────────────────────────────────────────────────────┤');
    console.log(`│  ${('💰 Est. Profit: ' + formatUSD(estimatedLiquidationProfit)).padEnd(56)} │`);

    // Calculate optimal OEV bid
    const { bidAmount, netProfit } = estimateOptimalBid(estimatedLiquidationProfit);
    console.log(`│  ${('📊 Suggested Bid: ' + formatUSD(bidAmount)).padEnd(56)} │`);
    console.log(`│  ${('📈 Net Profit: ' + formatUSD(netProfit)).padEnd(56)} │`);

    console.log('├─────────────────────────────────────────────────────────┤');
    console.log(`│  ${'🎯 OEV AUCTION: Ready to bid on OEV Network'.padEnd(56)} │`);
    console.log(`│  ${'   Chain ID: ' + OEV_NETWORK_CHAIN_ID + ' | Bridge: oev.bridge.api3.org'.padEnd(56)} │`);
  }

  console.log('└─────────────────────────────────────────────────────────┘');
}

/**
 * Print OEV opportunity alert
 */
function printOevOpportunity(analysis: PositionAnalysis): void {
  const { position, healthFactor, estimatedLiquidationProfit } = analysis;
  const { bidAmount, netProfit } = estimateOptimalBid(estimatedLiquidationProfit);

  console.log('\n' + '═'.repeat(60));
  console.log('  🎯 OEV LIQUIDATION OPPORTUNITY DETECTED');
  console.log('═'.repeat(60));
  console.log(`  Borrower:         ${formatAddress(position.borrower)}`);
  console.log(`  Market:           ${position.collateralToken.symbol}/${position.loanToken.symbol}`);
  console.log(`  Health Factor:    ${formatNumber(healthFactor, 4)}`);
  console.log('─'.repeat(60));
  console.log(`  Est. Gross Profit: ${formatUSD(estimatedLiquidationProfit)}`);
  console.log(`  Suggested OEV Bid: ${formatUSD(bidAmount)}`);
  console.log(`  Est. Net Profit:   ${formatUSD(netProfit)}`);
  console.log('─'.repeat(60));
  console.log('  Oracle: API3 ✓ | OEV Enabled: Yes ✓');
  console.log('  Auction: Available on OEV Network (Chain 4913)');
  console.log('═'.repeat(60) + '\n');
}

// =============================================================================
// MAIN SCAN FUNCTION
// =============================================================================

async function runScan(
  config: SearcherConfig,
  tracker: PaperTradingTracker,
  scanNumber: number
): Promise<void> {
  logger.separator('═', 60);
  logger.info(`Starting OEV scan #${scanNumber}...`);
  logger.separator('═', 60);

  try {
    // Step 1: Fetch all positions from Morpho Blue
    logger.info('📊 Fetching positions from Morpho Blue...');
    let positions = await fetchAllPositions(config.maxPositions);

    if (positions.length === 0) {
      logger.warn('No positions found. API may be unavailable.');
      return;
    }

    logger.info(`Found ${positions.length} total active positions`);

    // Step 2: Filter for API3-oracle markets (OEV-enabled)
    const api3MarketIds = getKnownApi3MarketIds();
    const api3Positions = positions.filter((p) =>
      api3MarketIds.has(p.marketId.toLowerCase())
    );

    // Mark positions with API3 status
    positions = positions.map((p) => ({
      ...p,
      isApi3Oracle: api3MarketIds.has(p.marketId.toLowerCase()),
      isOevEnabled: isOevEnabledMarket(p.marketId),
    }));

    logger.info(`  📌 API3-oracle positions: ${api3Positions.length}`);
    logger.info(`  📌 Other oracle positions: ${positions.length - api3Positions.length}`);

    // Use only API3 positions if OEV-only mode is enabled
    const positionsToAnalyze = config.oevOnly ? api3Positions : positions;

    if (config.oevOnly && api3Positions.length === 0) {
      logger.info('\n✨ No positions in API3-oracle markets found.');
      logger.info('   Known OEV markets: wstETH/USDC, cbBTC/USDC');
      return;
    }

    // Step 3: Get prices for relevant tokens
    const uniqueTokens = getUniqueTokens(positionsToAnalyze);
    const tokenSymbols = Array.from(uniqueTokens.values()).map((t) => t.symbol);
    logger.info('💰 Fetching token prices...');
    const prices = await getTokenPrices(tokenSymbols);

    // Step 4: Analyze positions
    logger.info('🔍 Analyzing positions for OEV opportunities...');
    const analyzerConfig: AnalyzerConfig = {
      healthFactorThreshold: config.healthFactorThreshold,
      liquidationBonus: config.liquidationBonus,
      minProfitUSD: config.minProfitUSD,
    };

    const analyses = analyzePositions(positionsToAnalyze, prices, analyzerConfig);

    // Step 5: Print OEV-focused summary
    console.log('\n' + '═'.repeat(60));
    console.log('  OEV POSITION ANALYSIS SUMMARY');
    console.log('═'.repeat(60));

    const liquidatable = analyses.filter((a) => a.isLiquidatable);
    const atRisk = analyses.filter((a) => a.isAtRisk && !a.isLiquidatable);
    const healthy = analyses.filter((a) => !a.isAtRisk);

    console.log(`  Total positions (API3 markets): ${analyses.length}`);
    console.log(`  🔴 Liquidatable (HF < 1.0):      ${liquidatable.length}`);
    console.log(`  🟡 At risk (HF < 1.1):           ${atRisk.length}`);
    console.log(`  🟢 Healthy (HF >= 1.1):          ${healthy.length}`);

    if (liquidatable.length > 0) {
      const totalProfit = liquidatable.reduce((sum, a) => sum + a.estimatedLiquidationProfit, 0);
      console.log(`\n  💰 Total OEV Profit Available: ${formatUSD(totalProfit)}`);
    }

    console.log('═'.repeat(60));

    // Step 6: Process OEV liquidation opportunities
    const oevOpportunities = getLiquidatablePositions(analyses, config.minProfitUSD);

    if (oevOpportunities.length > 0) {
      logger.info(`\n🎯 Found ${oevOpportunities.length} OEV OPPORTUNITIES!`);

      for (const analysis of oevOpportunities) {
        const isApi3 = api3MarketIds.has(analysis.position.marketId.toLowerCase());

        // Print detailed opportunity
        printOevOpportunity(analysis);
        printOevPositionDetails(analysis, isApi3);

        // Record in paper trading
        const opportunity = tracker.recordOpportunity(analysis);
        if (opportunity) {
          tracker.executeOpportunity(opportunity.id);
        }
      }
    } else {
      logger.info('\n✨ No OEV liquidation opportunities found this scan.');
    }

    // Step 7: Show at-risk positions
    const atRiskPositions = getAtRiskPositions(analyses, config.healthFactorThreshold);

    if (atRiskPositions.length > 0) {
      logger.info(`\n⚠️  ${atRiskPositions.length} positions approaching liquidation:`);
      logger.separator('─', 60);

      for (const analysis of atRiskPositions.slice(0, 5)) {
        const isApi3 = api3MarketIds.has(analysis.position.marketId.toLowerCase());
        const oracleTag = isApi3 ? '[API3 ✓]' : '[Other]';
        const priceChange = calculateLiquidationPriceChange(analysis);

        console.log(
          `  ${oracleTag} ${formatAddress(analysis.position.borrower)} | ` +
          `HF: ${formatNumber(analysis.healthFactor, 4)} | ` +
          `${analysis.position.collateralToken.symbol}/${analysis.position.loanToken.symbol} | ` +
          `Liquidates at -${formatNumber(priceChange.collateralDropPercent, 1)}%`
        );
      }

      if (atRiskPositions.length > 5) {
        console.log(`  ... and ${atRiskPositions.length - 5} more`);
      }
    }

    // Step 8: Paper trading report
    logger.separator('═', 60);
    tracker.printReport();

  } catch (error) {
    logger.error('Scan failed', error);
    throw error;
  }
}

// =============================================================================
// STARTUP
// =============================================================================

function displayStartupInfo(config: SearcherConfig): void {
  logger.banner();

  console.log('\n📋 OEV SEARCHER CONFIGURATION');
  logger.separator('─', 50);
  console.log(`  Mode:              ${config.oevOnly ? 'OEV-Only (API3 markets)' : 'All Markets'}`);
  console.log(`  Scan Interval:     ${config.scanIntervalMs / 1000}s`);
  console.log(`  Max Positions:     ${config.maxPositions}`);
  console.log(`  Health Threshold:  ${config.healthFactorThreshold}`);
  console.log(`  Liquidation Bonus: ${config.liquidationBonus * 100}%`);
  console.log(`  Min Profit:        ${formatUSD(config.minProfitUSD)}`);
  console.log(`  Continuous Mode:   ${config.continuousMode ? 'Yes' : 'No'}`);
  logger.separator('─', 50);

  // Show known OEV markets
  console.log('\n🎯 TARGET OEV MARKETS (API3 Oracle):');
  Object.entries(API3_MORPHO_MARKETS_BASE).forEach(([id, market]) => {
    if (market.isOevEnabled) {
      console.log(`  ✓ ${market.name} (LLTV: ${(parseInt(market.lltv) / 1e16).toFixed(0)}%)`);
    }
  });

  console.log('\n📌 OEV NETWORK INFO:');
  console.log(`  Chain ID:     ${OEV_NETWORK_CHAIN_ID}`);
  console.log('  Bridge:       https://oev.bridge.api3.org/');
  console.log('  Docs:         https://docs.api3.org/oev-searchers/');

  console.log('\n⚠️  PAPER TRADING MODE:');
  console.log('  • No real transactions executed');
  console.log('  • Profits are estimates only');
  console.log('  • Press Ctrl+C to stop\n');
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
  const config = loadConfig();
  displayStartupInfo(config);

  logger.info('🔧 Checking price feed health...');
  const pricesHealthy = await checkPriceFeedHealth();
  if (!pricesHealthy) {
    logger.warn('Price feeds may be unreliable. Proceeding with caution...');
  }

  const tracker = getTracker();
  let scanNumber = 0;
  let running = true;

  process.on('SIGINT', () => {
    logger.info('\n\n🛑 Shutting down OEV Searcher...');
    running = false;
    logger.info('\n📊 FINAL PAPER TRADING REPORT');
    tracker.printReport();
    process.exit(0);
  });

  while (running) {
    scanNumber++;

    if (config.maxScans > 0 && scanNumber > config.maxScans) {
      logger.info(`\n✅ Completed ${config.maxScans} scans. Stopping.`);
      break;
    }

    try {
      await runScan(config, tracker, scanNumber);
    } catch (error) {
      logger.error(`Scan #${scanNumber} failed`, error);
    }

    if (!config.continuousMode) {
      logger.info('\n✅ Single scan completed. Exiting.');
      break;
    }

    logger.info(`\n⏳ Next OEV scan in ${config.scanIntervalMs / 1000} seconds...`);
    logger.info('   Press Ctrl+C to stop and see final report.\n');

    await new Promise((resolve) => setTimeout(resolve, config.scanIntervalMs));
  }

  logger.info('\n📊 FINAL PAPER TRADING REPORT');
  tracker.printReport();
}

export { runScan, loadConfig, SearcherConfig };

main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
