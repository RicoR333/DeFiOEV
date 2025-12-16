/**
 * Logger Utility - Formatted Console Output
 *
 * This module provides colorful, structured logging for our OEV searcher.
 * In production MEV/OEV systems, logging is crucial for:
 * - Debugging failed transactions
 * - Tracking profitability over time
 * - Understanding market dynamics
 *
 * We use chalk for terminal colors to make the output easy to scan.
 */

import chalk from 'chalk';

/**
 * Log levels help us filter what we want to see.
 * In production, you might use: DEBUG < INFO < WARN < ERROR
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// Current log level - change this to filter output
let currentLogLevel: LogLevel = LogLevel.DEBUG;

/**
 * Set the minimum log level to display
 */
export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

/**
 * Get timestamp string for log entries.
 * Timestamps are essential for correlating events with blockchain blocks.
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Format a number as currency (USD)
 */
export function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Format a number with specified decimals
 */
export function formatNumber(num: number, decimals: number = 4): string {
  return num.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Format an Ethereum address for display (shortened)
 */
export function formatAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Main logger class with different output styles
 */
export const logger = {
  /**
   * Debug messages - detailed technical info
   */
  debug: (message: string, data?: unknown): void => {
    if (currentLogLevel <= LogLevel.DEBUG) {
      console.log(
        chalk.gray(`[${getTimestamp()}]`),
        chalk.blue('DEBUG'),
        message,
        data ? chalk.gray(JSON.stringify(data, null, 2)) : ''
      );
    }
  },

  /**
   * Info messages - general status updates
   */
  info: (message: string, data?: unknown): void => {
    if (currentLogLevel <= LogLevel.INFO) {
      console.log(
        chalk.gray(`[${getTimestamp()}]`),
        chalk.green('INFO '),
        message,
        data ? chalk.white(JSON.stringify(data, null, 2)) : ''
      );
    }
  },

  /**
   * Warning messages - potential issues
   */
  warn: (message: string, data?: unknown): void => {
    if (currentLogLevel <= LogLevel.WARN) {
      console.log(
        chalk.gray(`[${getTimestamp()}]`),
        chalk.yellow('WARN '),
        message,
        data ? chalk.yellow(JSON.stringify(data, null, 2)) : ''
      );
    }
  },

  /**
   * Error messages - something went wrong
   */
  error: (message: string, error?: unknown): void => {
    if (currentLogLevel <= LogLevel.ERROR) {
      console.log(
        chalk.gray(`[${getTimestamp()}]`),
        chalk.red('ERROR'),
        message,
        error ? chalk.red(error instanceof Error ? error.message : String(error)) : ''
      );
    }
  },

  /**
   * Special: Liquidation opportunity alert
   * This is what we're looking for! Make it stand out.
   */
  opportunity: (
    borrower: string,
    healthFactor: number,
    estimatedProfit: number,
    details: string
  ): void => {
    console.log('\n' + chalk.bgYellow.black(' 🎯 LIQUIDATION OPPORTUNITY '));
    console.log(chalk.yellow('━'.repeat(50)));
    console.log(chalk.white(`  Borrower:        ${formatAddress(borrower)}`));
    console.log(chalk.red(`  Health Factor:   ${formatNumber(healthFactor, 4)}`));
    console.log(chalk.green(`  Est. Profit:     ${formatUSD(estimatedProfit)}`));
    console.log(chalk.gray(`  Details:         ${details}`));
    console.log(chalk.yellow('━'.repeat(50)) + '\n');
  },

  /**
   * Display position information in a structured way
   */
  position: (
    borrower: string,
    collateralToken: string,
    debtToken: string,
    collateralValue: number,
    debtValue: number,
    healthFactor: number
  ): void => {
    // Color code based on health factor risk
    const healthColor =
      healthFactor < 1.0 ? chalk.red :
      healthFactor < 1.1 ? chalk.yellow :
      healthFactor < 1.5 ? chalk.white :
      chalk.green;

    console.log(chalk.gray('┌─────────────────────────────────────────────────┐'));
    console.log(chalk.gray('│') + chalk.cyan(` Position: ${formatAddress(borrower)}`.padEnd(48)) + chalk.gray('│'));
    console.log(chalk.gray('├─────────────────────────────────────────────────┤'));
    console.log(chalk.gray('│') + `  Collateral (${collateralToken}): ${formatUSD(collateralValue)}`.padEnd(48) + chalk.gray('│'));
    console.log(chalk.gray('│') + `  Debt (${debtToken}):       ${formatUSD(debtValue)}`.padEnd(48) + chalk.gray('│'));
    console.log(chalk.gray('│') + healthColor(`  Health Factor:    ${formatNumber(healthFactor, 4)}`.padEnd(48)) + chalk.gray('│'));
    console.log(chalk.gray('└─────────────────────────────────────────────────┘'));
  },

  /**
   * Display paper trading P&L summary
   */
  pnlSummary: (
    totalOpportunities: number,
    totalProfit: number,
    winRate: number
  ): void => {
    console.log('\n' + chalk.bgCyan.black(' 📊 PAPER TRADING SUMMARY '));
    console.log(chalk.cyan('━'.repeat(50)));
    console.log(chalk.white(`  Total Opportunities:  ${totalOpportunities}`));
    console.log(chalk.green(`  Total Profit (Paper): ${formatUSD(totalProfit)}`));
    console.log(chalk.white(`  Win Rate:             ${formatNumber(winRate * 100, 1)}%`));
    console.log(chalk.cyan('━'.repeat(50)) + '\n');
  },

  /**
   * Display startup banner
   */
  banner: (): void => {
    console.log(chalk.cyan(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   ██████╗ ███████╗██╗   ██╗    ███████╗███████╗ █████╗ ██████╗║
║  ██╔═══██╗██╔════╝██║   ██║    ██╔════╝██╔════╝██╔══██╗██╔══██║
║  ██║   ██║█████╗  ██║   ██║    ███████╗█████╗  ███████║██████╔╝║
║  ██║   ██║██╔══╝  ╚██╗ ██╔╝    ╚════██║██╔══╝  ██╔══██║██╔══██╗║
║  ╚██████╔╝███████╗ ╚████╔╝     ███████║███████╗██║  ██║██║  ██║║
║   ╚═════╝ ╚══════╝  ╚═══╝      ╚══════╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝║
║                                                               ║
║             Oracle Extractable Value Searcher                 ║
║                  Morpho Blue on Base                          ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
    `));
  },

  /**
   * Display a separator line
   */
  separator: (char: string = '─', length: number = 60): void => {
    console.log(chalk.gray(char.repeat(length)));
  },
};

export default logger;
