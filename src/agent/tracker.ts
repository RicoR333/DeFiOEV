/**
 * Paper Trading P&L Tracker
 *
 * This module tracks "paper" (simulated) profits from liquidation opportunities.
 * Paper trading allows us to:
 * 1. Validate our strategy without risking real money
 * 2. Track what we would have made with perfect execution
 * 3. Identify patterns in profitable opportunities
 *
 * WHY PAPER TRADING?
 *
 * Before deploying real capital:
 * - Test that our health factor calculations are correct
 * - Verify our price feeds are accurate
 * - Understand the frequency and size of opportunities
 * - Estimate realistic returns after gas and competition
 *
 * IMPORTANT LIMITATIONS:
 *
 * Paper trading overestimates real profits because:
 * 1. Gas costs - actual liquidations cost $5-50+ in gas
 * 2. Competition - other searchers may front-run you
 * 3. Slippage - large liquidations can move prices
 * 4. MEV - block builders extract value from liquidators
 * 5. Latency - opportunities disappear in milliseconds
 *
 * With OEV, some of these issues are mitigated because you bid for
 * the right to liquidate, reducing competition uncertainty.
 */

import { PositionAnalysis } from './analyzer';
import logger, { formatUSD, formatNumber, formatAddress } from '../utils/logger';

/**
 * Record of a single liquidation opportunity
 */
export interface LiquidationOpportunity {
  id: string;                      // Unique ID for this opportunity
  timestamp: Date;                 // When we detected it
  borrower: string;                // Borrower's address
  marketId: string;                // Morpho market ID
  collateralToken: string;         // e.g., "WETH"
  loanToken: string;               // e.g., "USDC"
  collateralValueUSD: number;      // Total collateral value
  debtValueUSD: number;            // Total debt value
  healthFactor: number;            // Health factor when detected
  estimatedProfitUSD: number;      // Estimated profit
  status: 'detected' | 'executed' | 'missed' | 'expired';
}

/**
 * Aggregate P&L statistics
 */
export interface PnLStats {
  totalOpportunities: number;
  executedCount: number;
  missedCount: number;
  expiredCount: number;
  totalEstimatedProfit: number;
  totalRealizedProfit: number;     // What we "captured" in paper trading
  averageProfit: number;
  largestProfit: number;
  smallestProfit: number;
  winRate: number;                 // executed / (executed + missed)
  profitByToken: Map<string, number>;
  profitByHour: Map<number, number>;
}

/**
 * Paper Trading Tracker Class
 *
 * Maintains state across multiple analysis runs to track
 * cumulative P&L and avoid double-counting opportunities.
 */
export class PaperTradingTracker {
  private opportunities: Map<string, LiquidationOpportunity> = new Map();
  private stats: PnLStats;
  private seenPositions: Set<string> = new Set(); // Track to avoid duplicates

  constructor() {
    this.stats = this.initializeStats();
  }

  /**
   * Initialize empty statistics
   */
  private initializeStats(): PnLStats {
    return {
      totalOpportunities: 0,
      executedCount: 0,
      missedCount: 0,
      expiredCount: 0,
      totalEstimatedProfit: 0,
      totalRealizedProfit: 0,
      averageProfit: 0,
      largestProfit: 0,
      smallestProfit: Infinity,
      winRate: 0,
      profitByToken: new Map(),
      profitByHour: new Map(),
    };
  }

  /**
   * Generate unique ID for an opportunity
   *
   * We use borrower + market to identify unique positions.
   * This prevents counting the same position multiple times.
   */
  private generateOpportunityId(
    borrower: string,
    marketId: string,
    timestamp: Date
  ): string {
    // Round to nearest minute to group rapid detections
    const minuteTimestamp = Math.floor(timestamp.getTime() / 60000) * 60000;
    return `${borrower}-${marketId}-${minuteTimestamp}`;
  }

  /**
   * Record a new liquidation opportunity
   *
   * Called when we detect a position with health factor < 1.0
   */
  recordOpportunity(analysis: PositionAnalysis): LiquidationOpportunity | null {
    const timestamp = new Date();
    const id = this.generateOpportunityId(
      analysis.position.borrower,
      analysis.position.marketId,
      timestamp
    );

    // Check if we've already recorded this opportunity recently
    if (this.seenPositions.has(id)) {
      logger.debug(`Skipping duplicate opportunity: ${id}`);
      return null;
    }

    // Create opportunity record
    const opportunity: LiquidationOpportunity = {
      id,
      timestamp,
      borrower: analysis.position.borrower,
      marketId: analysis.position.marketId,
      collateralToken: analysis.position.collateralToken.symbol,
      loanToken: analysis.position.loanToken.symbol,
      collateralValueUSD: analysis.collateralValueUSD,
      debtValueUSD: analysis.debtValueUSD,
      healthFactor: analysis.healthFactor,
      estimatedProfitUSD: analysis.estimatedLiquidationProfit,
      status: 'detected',
    };

    // Store it
    this.opportunities.set(id, opportunity);
    this.seenPositions.add(id);

    // Update statistics
    this.stats.totalOpportunities++;
    this.stats.totalEstimatedProfit += opportunity.estimatedProfitUSD;

    // Track by token
    const currentTokenProfit = this.stats.profitByToken.get(opportunity.collateralToken) || 0;
    this.stats.profitByToken.set(
      opportunity.collateralToken,
      currentTokenProfit + opportunity.estimatedProfitUSD
    );

    // Track by hour
    const hour = timestamp.getHours();
    const currentHourProfit = this.stats.profitByHour.get(hour) || 0;
    this.stats.profitByHour.set(hour, currentHourProfit + opportunity.estimatedProfitUSD);

    // Update min/max
    if (opportunity.estimatedProfitUSD > this.stats.largestProfit) {
      this.stats.largestProfit = opportunity.estimatedProfitUSD;
    }
    if (opportunity.estimatedProfitUSD < this.stats.smallestProfit) {
      this.stats.smallestProfit = opportunity.estimatedProfitUSD;
    }

    // Calculate average
    this.stats.averageProfit =
      this.stats.totalEstimatedProfit / this.stats.totalOpportunities;

    // Log the opportunity
    logger.info(
      `📝 Recorded opportunity: ${formatAddress(opportunity.borrower)} ` +
      `| Profit: ${formatUSD(opportunity.estimatedProfitUSD)}`
    );

    return opportunity;
  }

  /**
   * Mark an opportunity as "executed" (paper trade)
   *
   * In paper trading, we assume perfect execution - we would have
   * captured this liquidation with no competition.
   */
  executeOpportunity(id: string): boolean {
    const opportunity = this.opportunities.get(id);
    if (!opportunity) {
      logger.warn(`Opportunity not found: ${id}`);
      return false;
    }

    if (opportunity.status !== 'detected') {
      logger.warn(`Opportunity already processed: ${id} (${opportunity.status})`);
      return false;
    }

    opportunity.status = 'executed';
    this.stats.executedCount++;
    this.stats.totalRealizedProfit += opportunity.estimatedProfitUSD;

    // Update win rate
    const totalProcessed = this.stats.executedCount + this.stats.missedCount;
    this.stats.winRate = totalProcessed > 0
      ? this.stats.executedCount / totalProcessed
      : 0;

    logger.info(
      `✅ Executed (paper): ${formatAddress(opportunity.borrower)} ` +
      `| Realized: ${formatUSD(opportunity.estimatedProfitUSD)}`
    );

    return true;
  }

  /**
   * Mark an opportunity as missed
   *
   * This would happen if another liquidator got there first,
   * or if we decided not to liquidate for some reason.
   */
  missOpportunity(id: string, reason: string = 'unknown'): boolean {
    const opportunity = this.opportunities.get(id);
    if (!opportunity) {
      return false;
    }

    if (opportunity.status !== 'detected') {
      return false;
    }

    opportunity.status = 'missed';
    this.stats.missedCount++;

    // Update win rate
    const totalProcessed = this.stats.executedCount + this.stats.missedCount;
    this.stats.winRate = totalProcessed > 0
      ? this.stats.executedCount / totalProcessed
      : 0;

    logger.warn(
      `❌ Missed opportunity: ${formatAddress(opportunity.borrower)} ` +
      `| Reason: ${reason}`
    );

    return true;
  }

  /**
   * Mark old opportunities as expired
   *
   * Positions that are no longer liquidatable (maybe someone else
   * liquidated them, or the price moved favorably for the borrower).
   */
  expireOldOpportunities(maxAgeMs: number = 300000): number {
    const now = Date.now();
    let expiredCount = 0;

    this.opportunities.forEach((opportunity, id) => {
      if (opportunity.status !== 'detected') {
        return; // Only expire unprocessed opportunities
      }

      const age = now - opportunity.timestamp.getTime();
      if (age > maxAgeMs) {
        opportunity.status = 'expired';
        this.stats.expiredCount++;
        expiredCount++;
        logger.debug(`Expired opportunity: ${id} (age: ${age}ms)`);
      }
    });

    return expiredCount;
  }

  /**
   * Simulate execution of all pending opportunities
   *
   * For paper trading, we assume we would have captured everything.
   * This gives us the "best case" scenario profit.
   */
  executeAllPending(): number {
    let executedCount = 0;

    this.opportunities.forEach((opportunity, id) => {
      if (opportunity.status === 'detected') {
        if (this.executeOpportunity(id)) {
          executedCount++;
        }
      }
    });

    return executedCount;
  }

  /**
   * Get current P&L statistics
   */
  getStats(): PnLStats {
    return { ...this.stats };
  }

  /**
   * Get all opportunities (for analysis)
   */
  getOpportunities(): LiquidationOpportunity[] {
    return Array.from(this.opportunities.values());
  }

  /**
   * Get opportunities by status
   */
  getOpportunitiesByStatus(status: LiquidationOpportunity['status']): LiquidationOpportunity[] {
    return this.getOpportunities().filter((o) => o.status === status);
  }

  /**
   * Print detailed P&L report
   */
  printReport(): void {
    const stats = this.getStats();

    logger.pnlSummary(
      stats.totalOpportunities,
      stats.totalRealizedProfit,
      stats.winRate
    );

    console.log('\n📈 DETAILED P&L REPORT\n');

    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│                    OVERALL STATISTICS                   │');
    console.log('├─────────────────────────────────────────────────────────┤');
    console.log(`│  Total Opportunities Detected:     ${String(stats.totalOpportunities).padStart(18)} │`);
    console.log(`│  Successfully Executed (Paper):    ${String(stats.executedCount).padStart(18)} │`);
    console.log(`│  Missed Opportunities:             ${String(stats.missedCount).padStart(18)} │`);
    console.log(`│  Expired (Unprocessed):            ${String(stats.expiredCount).padStart(18)} │`);
    console.log('├─────────────────────────────────────────────────────────┤');
    console.log(`│  Total Estimated Profit:           ${formatUSD(stats.totalEstimatedProfit).padStart(18)} │`);
    console.log(`│  Total Realized Profit (Paper):    ${formatUSD(stats.totalRealizedProfit).padStart(18)} │`);
    console.log(`│  Average Profit per Opportunity:   ${formatUSD(stats.averageProfit).padStart(18)} │`);
    console.log(`│  Largest Single Profit:            ${formatUSD(stats.largestProfit).padStart(18)} │`);
    if (stats.smallestProfit !== Infinity) {
      console.log(`│  Smallest Single Profit:           ${formatUSD(stats.smallestProfit).padStart(18)} │`);
    }
    console.log(`│  Win Rate:                         ${(formatNumber(stats.winRate * 100, 1) + '%').padStart(18)} │`);
    console.log('└─────────────────────────────────────────────────────────┘');

    // Profit by token
    if (stats.profitByToken.size > 0) {
      console.log('\n┌─────────────────────────────────────────────────────────┐');
      console.log('│                    PROFIT BY TOKEN                      │');
      console.log('├─────────────────────────────────────────────────────────┤');
      stats.profitByToken.forEach((profit, token) => {
        console.log(`│  ${token.padEnd(35)} ${formatUSD(profit).padStart(18)} │`);
      });
      console.log('└─────────────────────────────────────────────────────────┘');
    }

    // Profit by hour (if we have enough data)
    if (stats.profitByHour.size >= 3) {
      console.log('\n┌─────────────────────────────────────────────────────────┐');
      console.log('│                    PROFIT BY HOUR (UTC)                 │');
      console.log('├─────────────────────────────────────────────────────────┤');
      const sortedHours = Array.from(stats.profitByHour.entries()).sort((a, b) => b[1] - a[1]);
      sortedHours.slice(0, 5).forEach(([hour, profit]) => {
        console.log(`│  ${String(hour).padStart(2)}:00 - ${String(hour).padStart(2)}:59              ${formatUSD(profit).padStart(18)} │`);
      });
      console.log('└─────────────────────────────────────────────────────────┘');
    }

    // Recent opportunities
    const recentOps = this.getOpportunities()
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
      .slice(0, 5);

    if (recentOps.length > 0) {
      console.log('\n┌─────────────────────────────────────────────────────────┐');
      console.log('│                    RECENT OPPORTUNITIES                 │');
      console.log('├─────────────────────────────────────────────────────────┤');
      recentOps.forEach((op) => {
        const status = op.status === 'executed' ? '✅' :
                      op.status === 'missed' ? '❌' :
                      op.status === 'expired' ? '⏰' : '🔍';
        console.log(
          `│  ${status} ${formatAddress(op.borrower)} ${op.collateralToken}/${op.loanToken} ` +
          `${formatUSD(op.estimatedProfitUSD).padStart(12)} │`
        );
      });
      console.log('└─────────────────────────────────────────────────────────┘');
    }
  }

  /**
   * Reset all tracking data
   */
  reset(): void {
    this.opportunities.clear();
    this.seenPositions.clear();
    this.stats = this.initializeStats();
    logger.info('Paper trading tracker reset');
  }

  /**
   * Export data for analysis (e.g., to CSV or JSON)
   */
  exportData(): {
    opportunities: LiquidationOpportunity[];
    stats: PnLStats;
    exportedAt: Date;
  } {
    return {
      opportunities: this.getOpportunities(),
      stats: this.getStats(),
      exportedAt: new Date(),
    };
  }
}

// Singleton instance for easy access
let trackerInstance: PaperTradingTracker | null = null;

/**
 * Get the global tracker instance
 */
export function getTracker(): PaperTradingTracker {
  if (!trackerInstance) {
    trackerInstance = new PaperTradingTracker();
  }
  return trackerInstance;
}

/**
 * Reset the global tracker
 */
export function resetTracker(): void {
  trackerInstance = new PaperTradingTracker();
}

export default {
  PaperTradingTracker,
  getTracker,
  resetTracker,
};
