/**
 * Demo Mode - Shows what the output looks like with sample data
 *
 * This file demonstrates the agent's output using mock data,
 * useful when network access is unavailable.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import logger, { formatUSD, formatNumber, formatAddress } from './utils/logger';
import { AnalyzablePosition } from './data/morpho';
import {
  analyzePositions,
  getLiquidatablePositions,
  getAtRiskPositions,
  printAnalysisSummary,
  printPositionDetails,
  calculateLiquidationPriceChange,
  AnalyzerConfig,
} from './agent/analyzer';
import { getTracker } from './agent/tracker';

// Mock positions simulating real Morpho Blue data
const MOCK_POSITIONS: AnalyzablePosition[] = [
  {
    id: 'pos-1',
    borrower: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE23',
    marketId: 'market-weth-usdc',
    collateralToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('500000000000000000'),  // 0.5 WETH
    borrowAmount: BigInt('1520000000'),              // 1520 USDC
    lltv: BigInt('860000000000000000'),              // 86% LLTV
  },
  {
    id: 'pos-2',
    borrower: '0x8ba1f109551bD432803012645Hac136c22C5F46',
    marketId: 'market-weth-usdc',
    collateralToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('2000000000000000000'), // 2.0 WETH
    borrowAmount: BigInt('5100000000'),              // 5100 USDC - at risk!
    lltv: BigInt('860000000000000000'),
  },
  {
    id: 'pos-3',
    borrower: '0x1CBd3b2770909D4e10f157caBc84C7264073C9Ec',
    marketId: 'market-cbbtc-usdc',
    collateralToken: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', decimals: 8 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('5000000'),             // 0.05 BTC
    borrowAmount: BigInt('3800000000'),              // 3800 USDC
    lltv: BigInt('800000000000000000'),              // 80% LLTV
  },
  {
    id: 'pos-4',
    borrower: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    marketId: 'market-wsteth-weth',
    collateralToken: { address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452', symbol: 'wstETH', decimals: 18 },
    loanToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    collateralAmount: BigInt('10000000000000000000'), // 10 wstETH
    borrowAmount: BigInt('9800000000000000000'),      // 9.8 WETH - LIQUIDATABLE!
    lltv: BigInt('945000000000000000'),               // 94.5% LLTV
  },
  {
    id: 'pos-5',
    borrower: '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B',
    marketId: 'market-weth-usdc',
    collateralToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('1000000000000000000'), // 1.0 WETH
    borrowAmount: BigInt('2000000000'),              // 2000 USDC - healthy
    lltv: BigInt('860000000000000000'),
  },
  {
    id: 'pos-6',
    borrower: '0xCA35b7d915458EF540aDe6068dFe2F44E8fa733c',
    marketId: 'market-cbbtc-usdc',
    collateralToken: { address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', symbol: 'cbBTC', decimals: 8 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('10000000'),            // 0.1 BTC
    borrowAmount: BigInt('7900000000'),              // 7900 USDC - LIQUIDATABLE!
    lltv: BigInt('800000000000000000'),
  },
  {
    id: 'pos-7',
    borrower: '0x14723A09ACff6D2A60DcdF7aA4AFf308FDDC160C',
    marketId: 'market-weth-usdc',
    collateralToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('3500000000000000000'), // 3.5 WETH
    borrowAmount: BigInt('8500000000'),              // 8500 USDC - at risk
    lltv: BigInt('860000000000000000'),
  },
  {
    id: 'pos-8',
    borrower: '0x4B0897b0513fdC7C541B6d9D7E929C4e5364D2dB',
    marketId: 'market-weth-usdc',
    collateralToken: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    loanToken: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
    collateralAmount: BigInt('5000000000000000000'), // 5.0 WETH
    borrowAmount: BigInt('10000000000'),             // 10000 USDC - healthy
    lltv: BigInt('860000000000000000'),
  },
];

// Mock prices
const MOCK_PRICES = new Map<string, number>([
  ['WETH', 3500],
  ['wETH', 3500],
  ['ETH', 3500],
  ['cbBTC', 100000],
  ['BTC', 100000],
  ['wstETH', 4100],
  ['USDC', 1.0],
  ['USDT', 1.0],
]);

async function runDemo(): Promise<void> {
  logger.banner();

  console.log('\n📋 DEMO MODE - Using Mock Data\n');
  logger.separator('─', 50);
  console.log('  This demonstrates output with sample positions');
  console.log('  In production, data comes from Morpho Blue subgraph');
  logger.separator('─', 50);

  // Display mock prices
  console.log('\n💰 MOCK PRICES:');
  console.log('  WETH:   $3,500');
  console.log('  cbBTC:  $100,000');
  console.log('  wstETH: $4,100');
  console.log('  USDC:   $1.00\n');

  // Analyze positions
  logger.separator('═', 60);
  logger.info('Starting demo scan...');
  logger.separator('═', 60);

  logger.info(`📊 Analyzing ${MOCK_POSITIONS.length} mock positions...`);

  const analyzerConfig: AnalyzerConfig = {
    healthFactorThreshold: 1.1,
    liquidationBonus: 0.05,
    minProfitUSD: 10,
  };

  const analyses = analyzePositions(MOCK_POSITIONS, MOCK_PRICES, analyzerConfig);

  // Print summary
  printAnalysisSummary(analyses);

  // Get liquidatable positions
  const liquidatable = getLiquidatablePositions(analyses, 10);

  if (liquidatable.length > 0) {
    logger.info(`\n🎯 Found ${liquidatable.length} LIQUIDATABLE positions!\n`);
    logger.separator('─', 60);

    const tracker = getTracker();

    for (const analysis of liquidatable) {
      printPositionDetails(analysis);

      // Record in paper trading
      const opportunity = tracker.recordOpportunity(analysis);
      if (opportunity) {
        tracker.executeOpportunity(opportunity.id);
      }
    }
  }

  // Show at-risk positions
  const atRisk = getAtRiskPositions(analyses, 1.1);

  if (atRisk.length > 0) {
    logger.info(`\n⚠️  ${atRisk.length} positions are at risk (HF < 1.1):\n`);
    logger.separator('─', 60);

    for (const analysis of atRisk) {
      const priceChange = calculateLiquidationPriceChange(analysis);
      console.log(
        `  ${formatAddress(analysis.position.borrower)} | ` +
        `HF: ${formatNumber(analysis.healthFactor, 4)} | ` +
        `${analysis.position.collateralToken.symbol}/${analysis.position.loanToken.symbol} | ` +
        `Debt: ${formatUSD(analysis.debtValueUSD)} | ` +
        `Liquidates if collateral drops ${formatNumber(priceChange.collateralDropPercent, 1)}%`
      );
    }
  }

  // Show healthy positions
  const healthy = analyses.filter(a => a.healthFactor >= 1.1);
  if (healthy.length > 0) {
    logger.info(`\n✅ ${healthy.length} healthy positions (HF >= 1.1):\n`);
    for (const analysis of healthy.slice(0, 3)) {
      console.log(
        `  ${formatAddress(analysis.position.borrower)} | ` +
        `HF: ${formatNumber(analysis.healthFactor, 4)} | ` +
        `${analysis.position.collateralToken.symbol}/${analysis.position.loanToken.symbol} | ` +
        `Collateral: ${formatUSD(analysis.collateralValueUSD)}`
      );
    }
    if (healthy.length > 3) {
      console.log(`  ... and ${healthy.length - 3} more healthy positions`);
    }
  }

  // Print final report
  logger.separator('═', 60);
  logger.info('\n📊 PAPER TRADING REPORT');
  const tracker = getTracker();
  tracker.printReport();

  console.log('\n✨ Demo complete! In production, this runs continuously');
  console.log('   monitoring real positions from Morpho Blue.\n');
}

runDemo().catch(console.error);
