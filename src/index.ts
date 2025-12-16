/**
 * OEV Searcher Agent - Main Entry Point
 *
 * This is an educational OEV (Oracle Extractable Value) searcher that monitors
 * Morpho Blue lending positions on Base and identifies liquidation opportunities.
 *
 * WHAT THIS AGENT DOES:
 * 1. Fetches real lending positions from Morpho Blue via The Graph
 * 2. Gets real-time prices from API3 price feeds
 * 3. Calculates health factors to identify liquidatable positions
 * 4. Tracks paper trading P&L (what we would have made)
 *
 * WHAT IS OEV?
 * Oracle Extractable Value is value that can be extracted by controlling
 * oracle price updates. In traditional DeFi, liquidations happen when
 * someone notices a position is underwater after an oracle update.
 *
 * With API3's OEV Network, searchers can:
 * 1. See a position is close to liquidation
 * 2. Bid for the right to update the oracle price
 * 3. Atomically update the price and execute the liquidation
 *
 * This is more efficient because:
 * - No gas wars with other liquidators
 * - Proceeds from bids go back to the dApp
 * - More predictable profitability
 *
 * DISCLAIMER:
 * This is for EDUCATIONAL PURPOSES ONLY. Paper trading mode - no real
 * transactions are executed. Always do your own research before
 * deploying capital in DeFi.
 */

import * as dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Import our modules
import logger, { formatUSD, formatNumber, formatAddress } from './utils/logger';
import { fetchAllPositions, getUniqueTokens, fetchMarkets } from './data/morpho';
import { getTokenPrices, checkPriceFeedHealth } from './data/prices';
import {
  analyzePositions,
  getLiquidatablePositions,
  getAtRiskPositions,
  printAnalysisSummary,
  printPositionDetails,
  calculateLiquidationPriceChange,
  AnalyzerConfig,
} from './agent/analyzer';
import { getTracker, PaperTradingTracker } from './agent/tracker';

/**
 * Configuration for the OEV Searcher
 */
interface SearcherConfig {
  // How often to scan for opportunities (milliseconds)
  scanIntervalMs: number;

  // Maximum positions to analyze per scan
  maxPositions: number;

  // Health factor threshold for "at risk" alerts
  healthFactorThreshold: number;

  // Expected liquidation bonus (for profit estimation)
  liquidationBonus: number;

  // Minimum profit to consider (USD)
  minProfitUSD: number;

  // Whether to run in continuous mode
  continuousMode: boolean;

  // How many scans to run in continuous mode (0 = infinite)
  maxScans: number;
}

// Default configuration
const DEFAULT_CONFIG: SearcherConfig = {
  scanIntervalMs: 60_000,           // Scan every 60 seconds
  maxPositions: 200,                // Analyze up to 200 positions
  healthFactorThreshold: 1.1,       // Alert when health < 1.1
  liquidationBonus: 0.05,           // 5% liquidation bonus
  minProfitUSD: 10,                 // Minimum $10 profit
  continuousMode: true,             // Run continuously
  maxScans: 0,                      // Infinite scans (0 = no limit)
};

/**
 * Load configuration from environment variables
 */
function loadConfig(): SearcherConfig {
  return {
    scanIntervalMs: parseInt(process.env.SCAN_INTERVAL_MS || String(DEFAULT_CONFIG.scanIntervalMs)),
    maxPositions: parseInt(process.env.MAX_POSITIONS || String(DEFAULT_CONFIG.maxPositions)),
    healthFactorThreshold: parseFloat(process.env.HEALTH_THRESHOLD || String(DEFAULT_CONFIG.healthFactorThreshold)),
    liquidationBonus: parseFloat(process.env.LIQUIDATION_BONUS || String(DEFAULT_CONFIG.liquidationBonus)),
    minProfitUSD: parseFloat(process.env.MIN_PROFIT_USD || String(DEFAULT_CONFIG.minProfitUSD)),
    continuousMode: process.env.CONTINUOUS_MODE !== 'false',
    maxScans: parseInt(process.env.MAX_SCANS || String(DEFAULT_CONFIG.maxScans)),
  };
}

/**
 * Run a single scan for liquidation opportunities
 *
 * This is the core function that:
 * 1. Fetches positions from Morpho Blue
 * 2. Gets current prices
 * 3. Analyzes health factors
 * 4. Identifies opportunities
 * 5. Updates paper trading stats
 */
async function runScan(
  config: SearcherConfig,
  tracker: PaperTradingTracker,
  scanNumber: number
): Promise<void> {
  logger.separator('═', 60);
  logger.info(`Starting scan #${scanNumber}...`);
  logger.separator('═', 60);

  try {
    // Step 1: Fetch positions from Morpho Blue subgraph
    logger.info('📊 Fetching positions from Morpho Blue...');
    const positions = await fetchAllPositions(config.maxPositions);

    if (positions.length === 0) {
      logger.warn('No positions found. The subgraph might be empty or unavailable.');
      return;
    }

    logger.info(`Found ${positions.length} active positions`);

    // Step 2: Get unique tokens that need pricing
    const uniqueTokens = getUniqueTokens(positions);
    const tokenSymbols = Array.from(uniqueTokens.values()).map((t) => t.symbol);

    // Step 3: Fetch prices for all tokens
    logger.info('💰 Fetching token prices...');
    const prices = await getTokenPrices(tokenSymbols);

    // Step 4: Analyze all positions
    logger.info('🔍 Analyzing positions...');
    const analyzerConfig: AnalyzerConfig = {
      healthFactorThreshold: config.healthFactorThreshold,
      liquidationBonus: config.liquidationBonus,
      minProfitUSD: config.minProfitUSD,
    };

    const analyses = analyzePositions(positions, prices, analyzerConfig);

    // Step 5: Print summary
    printAnalysisSummary(analyses);

    // Step 6: Process liquidatable positions
    const liquidatable = getLiquidatablePositions(analyses, config.minProfitUSD);

    if (liquidatable.length > 0) {
      logger.info(`\n🎯 Found ${liquidatable.length} LIQUIDATABLE positions!`);
      logger.separator('─', 60);

      for (const analysis of liquidatable) {
        // Print detailed info
        printPositionDetails(analysis);

        // Record in paper trading tracker
        const opportunity = tracker.recordOpportunity(analysis);

        if (opportunity) {
          // In paper trading, we "execute" all opportunities
          tracker.executeOpportunity(opportunity.id);
        }
      }
    } else {
      logger.info('\n✨ No liquidatable positions found this scan.');
    }

    // Step 7: Show at-risk positions (for awareness)
    const atRisk = getAtRiskPositions(analyses, config.healthFactorThreshold);

    if (atRisk.length > 0) {
      logger.info(`\n⚠️  ${atRisk.length} positions are at risk (HF < ${config.healthFactorThreshold}):`);
      logger.separator('─', 60);

      // Show top 5 most at-risk positions
      const topAtRisk = atRisk.slice(0, 5);
      for (const analysis of topAtRisk) {
        const priceChange = calculateLiquidationPriceChange(analysis);
        console.log(
          `  ${formatAddress(analysis.position.borrower)} | ` +
          `HF: ${formatNumber(analysis.healthFactor, 4)} | ` +
          `${analysis.position.collateralToken.symbol}/${analysis.position.loanToken.symbol} | ` +
          `Liquidates if ${analysis.position.collateralToken.symbol} drops ${formatNumber(priceChange.collateralDropPercent, 1)}%`
        );
      }

      if (atRisk.length > 5) {
        console.log(`  ... and ${atRisk.length - 5} more at-risk positions`);
      }
    }

    // Step 8: Show paper trading stats
    logger.separator('═', 60);
    tracker.printReport();

  } catch (error) {
    logger.error('Scan failed', error);
    throw error;
  }
}

/**
 * Display startup information
 */
function displayStartupInfo(config: SearcherConfig): void {
  logger.banner();

  console.log('\n📋 CONFIGURATION');
  logger.separator('─', 40);
  console.log(`  Scan Interval:       ${config.scanIntervalMs / 1000}s`);
  console.log(`  Max Positions:       ${config.maxPositions}`);
  console.log(`  Health Threshold:    ${config.healthFactorThreshold}`);
  console.log(`  Liquidation Bonus:   ${config.liquidationBonus * 100}%`);
  console.log(`  Min Profit:          ${formatUSD(config.minProfitUSD)}`);
  console.log(`  Continuous Mode:     ${config.continuousMode ? 'Yes' : 'No'}`);
  console.log(`  Max Scans:           ${config.maxScans || 'Unlimited'}`);
  logger.separator('─', 40);

  console.log('\n📌 IMPORTANT NOTES:');
  console.log('  • This is PAPER TRADING mode - no real transactions');
  console.log('  • Profits shown are estimates assuming perfect execution');
  console.log('  • Real profits would be lower due to gas, competition, etc.');
  console.log('  • Press Ctrl+C to stop the agent\n');
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Load configuration
  const config = loadConfig();

  // Display startup info
  displayStartupInfo(config);

  // Verify price feeds are working
  logger.info('🔧 Checking price feed health...');
  const pricesHealthy = await checkPriceFeedHealth();

  if (!pricesHealthy) {
    logger.warn('Price feeds may be unreliable. Proceeding with caution...');
  }

  // Initialize paper trading tracker
  const tracker = getTracker();

  // Run scans
  let scanNumber = 0;
  let running = true;

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('\n\n🛑 Shutting down...');
    running = false;

    // Print final report
    logger.info('\n📊 FINAL PAPER TRADING REPORT');
    tracker.printReport();

    process.exit(0);
  });

  // Main loop
  while (running) {
    scanNumber++;

    // Check if we've hit max scans
    if (config.maxScans > 0 && scanNumber > config.maxScans) {
      logger.info(`\n✅ Completed ${config.maxScans} scans. Stopping.`);
      break;
    }

    try {
      await runScan(config, tracker, scanNumber);
    } catch (error) {
      logger.error(`Scan #${scanNumber} failed`, error);
      // Continue to next scan despite error
    }

    // If not continuous mode, exit after first scan
    if (!config.continuousMode) {
      logger.info('\n✅ Single scan completed. Exiting.');
      break;
    }

    // Wait for next scan
    logger.info(`\n⏳ Next scan in ${config.scanIntervalMs / 1000} seconds...`);
    logger.info('   Press Ctrl+C to stop and see final report.\n');

    await new Promise((resolve) => setTimeout(resolve, config.scanIntervalMs));
  }

  // Print final report
  logger.info('\n📊 FINAL PAPER TRADING REPORT');
  tracker.printReport();
}

// Export for testing
export {
  runScan,
  loadConfig,
  SearcherConfig,
};

// Run if this is the main module
main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
