/**
 * Position Analyzer - Health Factor Calculations
 *
 * This module is the heart of our OEV searcher. It analyzes lending positions
 * to identify those that are close to or below the liquidation threshold.
 *
 * KEY CONCEPTS:
 *
 * 1. HEALTH FACTOR
 *    A measure of how "safe" a borrowing position is.
 *    Formula: Health Factor = (Collateral Value * LLTV) / Debt Value
 *
 *    - Health Factor > 1: Position is healthy, cannot be liquidated
 *    - Health Factor = 1: Position is at the liquidation threshold
 *    - Health Factor < 1: Position can be liquidated
 *
 * 2. LLTV (Liquidation Loan-to-Value)
 *    The maximum ratio of debt to collateral before liquidation.
 *    Example: 86% LLTV means you can borrow up to 86% of your collateral value.
 *    If you exceed this, you get liquidated.
 *
 * 3. LIQUIDATION BONUS
 *    The discount liquidators receive when repaying debt.
 *    Example: If bonus is 5%, liquidator pays $100 debt and receives $105 in collateral.
 *    This is the profit opportunity!
 *
 * 4. OEV (Oracle Extractable Value)
 *    Traditional liquidation requires waiting for on-chain oracle updates.
 *    With OEV, searchers can bid to update prices and liquidate atomically.
 *    This is more profitable because you don't race other liquidators.
 */

import { AnalyzablePosition } from '../data/morpho';
import { calculateUSDValue } from '../data/prices';
import logger, { formatAddress, formatUSD, formatNumber } from '../utils/logger';

/**
 * Analysis result for a single position
 */
export interface PositionAnalysis {
  position: AnalyzablePosition;
  collateralValueUSD: number;
  debtValueUSD: number;
  healthFactor: number;
  liquidationThreshold: number;     // LLTV as a decimal (e.g., 0.86)
  maxBorrowValueUSD: number;        // Maximum debt before liquidation
  distanceToLiquidation: number;    // How much more debt would cause liquidation
  isLiquidatable: boolean;          // Health < 1.0
  isAtRisk: boolean;                // Health < 1.1 (configurable)
  estimatedLiquidationProfit: number;
}

/**
 * Configuration for the analyzer
 */
export interface AnalyzerConfig {
  healthFactorThreshold: number;    // Alert when health drops below this (default: 1.1)
  liquidationBonus: number;         // Expected liquidation bonus (default: 0.05 = 5%)
  minProfitUSD: number;             // Minimum profit to consider (default: $10)
}

const DEFAULT_CONFIG: AnalyzerConfig = {
  healthFactorThreshold: 1.1,  // Alert when health < 1.1 (10% buffer)
  liquidationBonus: 0.05,      // 5% liquidation bonus
  minProfitUSD: 10,            // Ignore tiny opportunities
};

/**
 * Calculate the health factor for a position
 *
 * Health Factor Formula:
 * HF = (Collateral Value × LLTV) / Debt Value
 *
 * Example:
 * - Collateral: 1 ETH worth $3000
 * - LLTV: 86%
 * - Debt: $2000 USDC
 *
 * HF = ($3000 × 0.86) / $2000 = $2580 / $2000 = 1.29
 *
 * This position is healthy (HF > 1). The user could borrow $580 more
 * before reaching the liquidation threshold.
 */
export function calculateHealthFactor(
  collateralValueUSD: number,
  debtValueUSD: number,
  lltv: bigint  // In 1e18 format
): number {
  // Convert LLTV from 1e18 format to decimal
  // e.g., 860000000000000000 → 0.86
  const lltvDecimal = Number(lltv) / 1e18;

  // Avoid division by zero
  if (debtValueUSD === 0) {
    return Infinity; // No debt = infinitely healthy
  }

  if (collateralValueUSD === 0) {
    return 0; // No collateral = immediately liquidatable
  }

  // Health Factor = (Collateral × LLTV) / Debt
  const healthFactor = (collateralValueUSD * lltvDecimal) / debtValueUSD;

  return healthFactor;
}

/**
 * Estimate liquidation profit
 *
 * When liquidating, you:
 * 1. Repay some or all of the borrower's debt
 * 2. Receive equivalent collateral + a bonus
 *
 * Profit = (Collateral Received × Price) - (Debt Repaid)
 *
 * In Morpho Blue, you typically liquidate up to the amount needed
 * to bring the position back to a healthy state.
 *
 * For simplicity, we estimate profit on full liquidation:
 * Profit = Debt × Liquidation Bonus
 */
export function estimateLiquidationProfit(
  debtValueUSD: number,
  collateralValueUSD: number,
  liquidationBonus: number = 0.05
): number {
  // The maximum you can liquidate is limited by available collateral
  // Profit = debt_repaid × bonus
  // But you can't get more collateral than exists

  // Calculate maximum debt that can be repaid
  // (collateral value after bonus must cover repayment)
  const maxDebtRepayable = collateralValueUSD / (1 + liquidationBonus);

  // Actual debt to repay is min of debt owed and max repayable
  const debtToRepay = Math.min(debtValueUSD, maxDebtRepayable);

  // Profit is the bonus on what we repay
  const profit = debtToRepay * liquidationBonus;

  return profit;
}

/**
 * Analyze a single position
 */
export function analyzePosition(
  position: AnalyzablePosition,
  collateralPriceUSD: number,
  loanPriceUSD: number,
  config: AnalyzerConfig = DEFAULT_CONFIG
): PositionAnalysis {
  // Calculate USD values
  const collateralValueUSD = calculateUSDValue(
    position.collateralAmount,
    position.collateralToken.decimals,
    collateralPriceUSD
  );

  const debtValueUSD = calculateUSDValue(
    position.borrowAmount,
    position.loanToken.decimals,
    loanPriceUSD
  );

  // Calculate health factor
  const healthFactor = calculateHealthFactor(
    collateralValueUSD,
    debtValueUSD,
    position.lltv
  );

  // Calculate liquidation threshold (LLTV as decimal)
  const liquidationThreshold = Number(position.lltv) / 1e18;

  // Calculate max borrow and distance to liquidation
  const maxBorrowValueUSD = collateralValueUSD * liquidationThreshold;
  const distanceToLiquidation = maxBorrowValueUSD - debtValueUSD;

  // Determine if position is at risk
  const isLiquidatable = healthFactor < 1.0;
  const isAtRisk = healthFactor < config.healthFactorThreshold;

  // Estimate potential profit
  const estimatedLiquidationProfit = isLiquidatable
    ? estimateLiquidationProfit(debtValueUSD, collateralValueUSD, config.liquidationBonus)
    : 0;

  return {
    position,
    collateralValueUSD,
    debtValueUSD,
    healthFactor,
    liquidationThreshold,
    maxBorrowValueUSD,
    distanceToLiquidation,
    isLiquidatable,
    isAtRisk,
    estimatedLiquidationProfit,
  };
}

/**
 * Analyze multiple positions and sort by risk
 */
export function analyzePositions(
  positions: AnalyzablePosition[],
  prices: Map<string, number>,
  config: AnalyzerConfig = DEFAULT_CONFIG
): PositionAnalysis[] {
  logger.info(`Analyzing ${positions.length} positions...`);

  const analyses: PositionAnalysis[] = [];

  for (const position of positions) {
    // Get prices for this position's tokens
    const collateralPrice = prices.get(position.collateralToken.symbol) ||
                           prices.get(position.collateralToken.symbol.toLowerCase()) ||
                           prices.get(position.collateralToken.symbol.toUpperCase());

    const loanPrice = prices.get(position.loanToken.symbol) ||
                     prices.get(position.loanToken.symbol.toLowerCase()) ||
                     prices.get(position.loanToken.symbol.toUpperCase());

    if (!collateralPrice || !loanPrice) {
      logger.debug(
        `Skipping position ${position.id}: missing price for ` +
        `${position.collateralToken.symbol} or ${position.loanToken.symbol}`
      );
      continue;
    }

    const analysis = analyzePosition(position, collateralPrice, loanPrice, config);
    analyses.push(analysis);
  }

  // Sort by health factor (lowest first = most at risk)
  analyses.sort((a, b) => a.healthFactor - b.healthFactor);

  return analyses;
}

/**
 * Filter for liquidatable positions (health factor < 1.0)
 */
export function getLiquidatablePositions(
  analyses: PositionAnalysis[],
  minProfitUSD: number = 10
): PositionAnalysis[] {
  return analyses.filter(
    (a) => a.isLiquidatable && a.estimatedLiquidationProfit >= minProfitUSD
  );
}

/**
 * Filter for at-risk positions (close to liquidation)
 */
export function getAtRiskPositions(
  analyses: PositionAnalysis[],
  healthThreshold: number = 1.1
): PositionAnalysis[] {
  return analyses.filter(
    (a) => a.healthFactor < healthThreshold && !a.isLiquidatable
  );
}

/**
 * Print analysis summary
 */
export function printAnalysisSummary(analyses: PositionAnalysis[]): void {
  const liquidatable = analyses.filter((a) => a.isLiquidatable);
  const atRisk = analyses.filter((a) => a.isAtRisk && !a.isLiquidatable);
  const healthy = analyses.filter((a) => !a.isAtRisk);

  logger.separator('═', 60);
  logger.info('POSITION ANALYSIS SUMMARY');
  logger.separator('═', 60);

  console.log(`  Total positions analyzed: ${analyses.length}`);
  console.log(`  🔴 Liquidatable (HF < 1.0): ${liquidatable.length}`);
  console.log(`  🟡 At risk (HF < 1.1):      ${atRisk.length}`);
  console.log(`  🟢 Healthy (HF >= 1.1):     ${healthy.length}`);

  if (liquidatable.length > 0) {
    const totalProfit = liquidatable.reduce(
      (sum, a) => sum + a.estimatedLiquidationProfit,
      0
    );
    console.log(`\n  💰 Total estimated profit: ${formatUSD(totalProfit)}`);
  }

  logger.separator('═', 60);
}

/**
 * Print detailed position info
 */
export function printPositionDetails(analysis: PositionAnalysis): void {
  const {
    position,
    collateralValueUSD,
    debtValueUSD,
    healthFactor,
    liquidationThreshold,
    distanceToLiquidation,
    isLiquidatable,
    estimatedLiquidationProfit,
  } = analysis;

  logger.position(
    position.borrower,
    position.collateralToken.symbol,
    position.loanToken.symbol,
    collateralValueUSD,
    debtValueUSD,
    healthFactor
  );

  if (isLiquidatable) {
    logger.opportunity(
      position.borrower,
      healthFactor,
      estimatedLiquidationProfit,
      `${position.collateralToken.symbol}/${position.loanToken.symbol} market`
    );
  } else if (healthFactor < 1.1) {
    console.log(
      `  ⚠️  Position at risk! Distance to liquidation: ${formatUSD(distanceToLiquidation)}`
    );
    console.log(
      `  📊 LLTV: ${formatNumber(liquidationThreshold * 100, 1)}%`
    );
  }
}

/**
 * Calculate price change needed for liquidation
 *
 * This is useful for monitoring - we can alert when a position
 * would become liquidatable with a small price move.
 */
export function calculateLiquidationPriceChange(
  analysis: PositionAnalysis
): { collateralDropPercent: number; debtRisePercent: number } {
  const { collateralValueUSD, debtValueUSD, healthFactor, liquidationThreshold } = analysis;

  // At liquidation: (Collateral × LLTV × (1 - drop)) / Debt = 1
  // Solving for drop: drop = 1 - (Debt / (Collateral × LLTV))
  // drop = 1 - 1/healthFactor

  const collateralDropPercent = healthFactor > 0
    ? (1 - 1 / healthFactor) * 100
    : 100;

  // At liquidation: (Collateral × LLTV) / (Debt × (1 + rise)) = 1
  // Solving for rise: rise = (Collateral × LLTV / Debt) - 1
  // rise = healthFactor - 1

  const debtRisePercent = (healthFactor - 1) * 100;

  return {
    collateralDropPercent: Math.max(0, collateralDropPercent),
    debtRisePercent: Math.max(0, debtRisePercent),
  };
}

export default {
  calculateHealthFactor,
  estimateLiquidationProfit,
  analyzePosition,
  analyzePositions,
  getLiquidatablePositions,
  getAtRiskPositions,
  printAnalysisSummary,
  printPositionDetails,
  calculateLiquidationPriceChange,
};
