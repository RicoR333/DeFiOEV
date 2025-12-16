/**
 * API3 OEV Network Integration
 *
 * This module integrates with API3's OEV (Oracle Extractable Value) Network
 * to check auction status and identify OEV-enabled markets on Ethereum mainnet.
 *
 * WHAT IS THE OEV NETWORK?
 * The OEV Network is an Arbitrum Nitro L2 (Chain ID: 4913) that hosts
 * auctions for oracle update rights. Searchers bid for the exclusive right
 * to update price feeds, enabling them to capture liquidations atomically.
 *
 * HOW OEV AUCTIONS WORK:
 * 1. Searchers monitor positions approaching liquidation
 * 2. When an opportunity is found, they bid on the OEV Network
 * 3. The winner gets exclusive rights to update the oracle
 * 4. Winner updates the price and executes liquidation atomically
 * 5. Auction proceeds go back to the dApp (Morpho)
 *
 * BENEFITS:
 * - No gas wars on the target chain
 * - Predictable profitability for searchers
 * - Value returned to protocol users instead of block builders
 *
 * References:
 * - OEV Network Docs: https://docs.api3.org/oev-searchers/in-depth/oev-network/
 * - Example Bot: https://github.com/api3dao/oev-orbit-bot-example
 * - OEV Bridge: https://oev.bridge.api3.org/
 * - OEV-Boosted Markets: https://blog.api3.org/introducing-oev-boosted-morpho-markets/
 */

import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { mainnet } from 'viem/chains';
import logger from '../utils/logger';

// =============================================================================
// CONFIGURATION
// =============================================================================

// OEV Network Configuration
export const OEV_NETWORK_CHAIN_ID = 4913;
export const OEV_NETWORK_RPC = 'https://oev.rpc.api3.org/http';

// OevAuctionHouse contract on OEV Network
// This is where bids are placed and auctions are managed
export const OEV_AUCTION_HOUSE_ADDRESS = '0x34f13A5C0AD750d212267bcBc230c87AEFD35CC5' as const;

// Ethereum mainnet configuration
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://eth.llamarpc.com';

// =============================================================================
// OEV-BOOSTED USDC VAULT
// =============================================================================

/**
 * OEV-Boosted USDC Vault on Ethereum
 *
 * This vault is curated by Yearn and allocates exclusively to markets
 * secured by API3 oracles, enabling OEV capture.
 *
 * Reference: https://blog.api3.org/introducing-oev-boosted-morpho-markets/
 */
export const OEV_BOOSTED_USDC_VAULT = {
  address: '0x68Aea7b82Df6CcdF76235D46445Ed83f85F845A3' as const,
  name: 'OEV-Boosted USDC Vault',
  curator: 'Yearn Finance',
  asset: 'USDC',
  description: 'Curated vault that allocates to OEV-enabled Morpho markets with API3 oracles',
  // Markets this vault allocates to
  allocatedMarkets: [
    '0x6d2fba32b8649d92432d036c16aa80779034b7469b63abc259b17678857f31c2', // wstETH/USDC
    '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64', // cbBTC/USDC
  ],
};

// =============================================================================
// KNOWN API3 ORACLE ADDRESSES ON ETHEREUM
// =============================================================================

/**
 * Known API3 dAPI proxy addresses on Ethereum mainnet
 *
 * API3 uses a proxy pattern for their oracles. These addresses are the
 * Api3ReaderProxyV1 contracts that dApps read from.
 *
 * To find more: https://market.api3.org (select Ethereum)
 */
export const API3_ORACLES_ETHEREUM: Record<string, {
  name: string;
  basePair: string;
  quotePair: string;
  description: string;
}> = {
  // ETH/USD price feed
  '0x5b0cf2b36a65a6bb085d501b971e4c102b9cd473': {
    name: 'ETH/USD',
    basePair: 'ETH',
    quotePair: 'USD',
    description: 'Ethereum price in USD',
  },
  // wstETH/ETH exchange rate
  '0x724195e37881a930e618fb0f70e5cce6a0e83dc6': {
    name: 'wstETH/ETH',
    basePair: 'wstETH',
    quotePair: 'ETH',
    description: 'Wrapped staked ETH exchange rate',
  },
  // USDC/USD
  '0x6c5b30ccbb4357a14f93ff5cc572f5c20bf1c8c1': {
    name: 'USDC/USD',
    basePair: 'USDC',
    quotePair: 'USD',
    description: 'USDC stablecoin price',
  },
  // BTC/USD
  '0x041a131fa91db4f9276a8dfcd1d0e8c7e4f1a417': {
    name: 'BTC/USD',
    basePair: 'BTC',
    quotePair: 'USD',
    description: 'Bitcoin price in USD',
  },
  // cbBTC/BTC
  '0xe67e80ed8b0def2bc572d9d4864124201b30d4e2': {
    name: 'cbBTC/BTC',
    basePair: 'cbBTC',
    quotePair: 'BTC',
    description: 'Coinbase wrapped BTC exchange rate',
  },
};

// =============================================================================
// OEV-ENABLED MORPHO MARKETS ON ETHEREUM
// =============================================================================

/**
 * Known Morpho Blue markets on Ethereum that use API3 oracles
 *
 * These are the OEV-enabled markets where we can capture liquidation value
 * through the API3 OEV Network auctions.
 *
 * Market ID is the keccak256 hash of (loanToken, collateralToken, oracle, irm, lltv)
 *
 * References:
 * - wstETH/USDC: https://app.morpho.org/ethereum/market/0x6d2fba32b8649d92432d036c16aa80779034b7469b63abc259b17678857f31c2/wsteth-usdc
 * - cbBTC/USDC: https://app.morpho.org/ethereum/market/0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/cbbtc-usdc
 */
export const API3_MORPHO_MARKETS_ETHEREUM: Record<string, {
  name: string;
  collateralToken: string;
  collateralSymbol: string;
  loanToken: string;
  loanSymbol: string;
  oracle: string;
  lltv: string;
  isOevEnabled: boolean;
  morphoUrl: string;
}> = {
  // wstETH/USDC market - Primary OEV-boosted market
  '0x6d2fba32b8649d92432d036c16aa80779034b7469b63abc259b17678857f31c2': {
    name: 'wstETH/USDC',
    collateralToken: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', // wstETH on Ethereum
    collateralSymbol: 'wstETH',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
    loanSymbol: 'USDC',
    oracle: '0x', // API3-powered oracle adapter
    lltv: '860000000000000000', // 86%
    isOevEnabled: true,
    morphoUrl: 'https://app.morpho.org/ethereum/market/0x6d2fba32b8649d92432d036c16aa80779034b7469b63abc259b17678857f31c2/wsteth-usdc',
  },
  // cbBTC/USDC market - OEV-boosted market
  '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64': {
    name: 'cbBTC/USDC',
    collateralToken: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC on Ethereum
    collateralSymbol: 'cbBTC',
    loanToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on Ethereum
    loanSymbol: 'USDC',
    oracle: '0x', // API3-powered oracle adapter
    lltv: '860000000000000000', // 86%
    isOevEnabled: true,
    morphoUrl: 'https://app.morpho.org/ethereum/market/0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/cbbtc-usdc',
  },
};

// Alias for backward compatibility
export const API3_MORPHO_MARKETS_BASE = API3_MORPHO_MARKETS_ETHEREUM;

// =============================================================================
// TYPES
// =============================================================================

export interface OevAuctionStatus {
  isActive: boolean;
  currentBid: bigint;
  currentBidder: string | null;
  expirationTimestamp: number;
  bidTopic: string;
}

export interface Api3OracleInfo {
  isApi3Oracle: boolean;
  oracleName: string | null;
  oevEnabled: boolean;
  proxyAddress: string | null;
}

export interface OevMarketInfo {
  marketId: string;
  marketName: string;
  isOevEnabled: boolean;
  oracleInfo: Api3OracleInfo;
  auctionStatus: OevAuctionStatus | null;
}

// =============================================================================
// VIEM CLIENTS
// =============================================================================

// Ethereum mainnet client for reading oracle data
const ethClient = createPublicClient({
  chain: mainnet,
  transport: http(ETH_RPC_URL),
});

// OEV Network client (when available)
let oevNetworkClient: ReturnType<typeof createPublicClient> | null = null;

try {
  oevNetworkClient = createPublicClient({
    transport: http(OEV_NETWORK_RPC),
  });
} catch (error) {
  logger.debug('OEV Network client not available');
}

// =============================================================================
// CONTRACT ABIS
// =============================================================================

// Api3ReaderProxyV1 ABI for reading price data
const API3_READER_PROXY_ABI = parseAbi([
  'function read() external view returns (int224 value, uint32 timestamp)',
  'function api3ServerV1() external view returns (address)',
]);

// OevAuctionHouse ABI for auction interactions
const OEV_AUCTION_HOUSE_ABI = parseAbi([
  'function bids(bytes32 bidId) external view returns (uint8 status, uint32 expirationTimestamp, uint104 collateralAmount, uint104 protocolFeeAmount, address bidder)',
  'function getCurrentCollateralAndProtocolFeeAmounts(uint256 bidAmount) external view returns (uint104 collateralAmount, uint104 protocolFeeAmount)',
  'function bidderToBalance(address bidder) external view returns (uint256)',
]);

// =============================================================================
// ORACLE DETECTION
// =============================================================================

/**
 * Check if an oracle address is an API3 oracle
 */
export async function isApi3Oracle(oracleAddress: string): Promise<Api3OracleInfo> {
  const normalizedAddress = oracleAddress.toLowerCase();

  // Check known API3 oracles first
  if (API3_ORACLES_ETHEREUM[normalizedAddress]) {
    const oracleInfo = API3_ORACLES_ETHEREUM[normalizedAddress];
    return {
      isApi3Oracle: true,
      oracleName: oracleInfo.name,
      oevEnabled: true,
      proxyAddress: oracleAddress,
    };
  }

  // Try to detect by calling the API3 interface
  try {
    const result = await ethClient.readContract({
      address: oracleAddress as Address,
      abi: API3_READER_PROXY_ABI,
      functionName: 'api3ServerV1',
    });

    if (result) {
      return {
        isApi3Oracle: true,
        oracleName: 'Detected API3 Feed',
        oevEnabled: true,
        proxyAddress: oracleAddress,
      };
    }
  } catch (error) {
    // Not an API3 oracle or call failed
  }

  return {
    isApi3Oracle: false,
    oracleName: null,
    oevEnabled: false,
    proxyAddress: null,
  };
}

/**
 * Check if a Morpho market uses an API3 oracle
 */
export async function checkMarketOracleType(
  marketId: string,
  oracleAddress: string
): Promise<OevMarketInfo> {
  // Check if it's a known API3 Morpho market
  const knownMarket = API3_MORPHO_MARKETS_ETHEREUM[marketId.toLowerCase()];
  if (knownMarket) {
    return {
      marketId,
      marketName: knownMarket.name,
      isOevEnabled: knownMarket.isOevEnabled,
      oracleInfo: {
        isApi3Oracle: true,
        oracleName: knownMarket.name,
        oevEnabled: knownMarket.isOevEnabled,
        proxyAddress: oracleAddress,
      },
      auctionStatus: null,
    };
  }

  // Check the oracle address directly
  const oracleInfo = await isApi3Oracle(oracleAddress);

  return {
    marketId,
    marketName: 'Unknown Market',
    isOevEnabled: oracleInfo.oevEnabled,
    oracleInfo,
    auctionStatus: null,
  };
}

// =============================================================================
// OEV AUCTION FUNCTIONS
// =============================================================================

/**
 * Generate a bid topic for an OEV auction
 */
export function generateBidTopic(dappId: string, dataFeedId: string): string {
  return `0x${Buffer.from(`${dappId}:${dataFeedId}`).toString('hex').padEnd(64, '0')}`;
}

/**
 * Check the status of an OEV auction (placeholder)
 */
export async function getAuctionStatus(
  bidTopic: string
): Promise<OevAuctionStatus | null> {
  if (!oevNetworkClient) {
    logger.debug('OEV Network client not available, cannot fetch auction status');
    return null;
  }

  try {
    return {
      isActive: true,
      currentBid: 0n,
      currentBidder: null,
      expirationTimestamp: Math.floor(Date.now() / 1000) + 60,
      bidTopic,
    };
  } catch (error) {
    logger.debug(`Failed to fetch auction status for ${bidTopic}`, error);
    return null;
  }
}

/**
 * Estimate the optimal bid amount for a liquidation opportunity
 */
export function estimateOptimalBid(
  expectedProfit: number,
  gasEstimate: number = 50,
  bidAggressiveness: number = 0.6
): { bidAmount: number; netProfit: number } {
  const maxBid = expectedProfit * bidAggressiveness;
  const bidAmount = Math.max(0, maxBid - gasEstimate);
  const netProfit = expectedProfit - bidAmount - gasEstimate;

  return {
    bidAmount: Math.max(0, bidAmount),
    netProfit: Math.max(0, netProfit),
  };
}

// =============================================================================
// MARKET FILTERING
// =============================================================================

/**
 * Filter positions to only include those in API3-oracle markets
 */
export function filterApi3Positions<T extends { marketId: string }>(
  positions: T[],
  api3Markets: Set<string>
): T[] {
  return positions.filter((pos) =>
    api3Markets.has(pos.marketId.toLowerCase())
  );
}

/**
 * Get the set of known API3 market IDs
 */
export function getKnownApi3MarketIds(): Set<string> {
  return new Set(
    Object.keys(API3_MORPHO_MARKETS_ETHEREUM).map((id) => id.toLowerCase())
  );
}

/**
 * Check if a market is OEV-enabled
 */
export function isOevEnabledMarket(marketId: string): boolean {
  const market = API3_MORPHO_MARKETS_ETHEREUM[marketId.toLowerCase()];
  return market?.isOevEnabled ?? false;
}

/**
 * Get market info by ID
 */
export function getMarketInfo(marketId: string) {
  return API3_MORPHO_MARKETS_ETHEREUM[marketId.toLowerCase()] || null;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Format OEV auction info for display
 */
export function formatOevInfo(marketInfo: OevMarketInfo): string {
  const lines: string[] = [];

  if (marketInfo.oracleInfo.isApi3Oracle) {
    lines.push(`Oracle: API3 ${marketInfo.oracleInfo.oracleName || 'Feed'} ✓`);
    lines.push(`OEV Enabled: ${marketInfo.isOevEnabled ? 'Yes ✓' : 'No'}`);

    if (marketInfo.auctionStatus) {
      lines.push(`Auction Active: ${marketInfo.auctionStatus.isActive ? 'Yes' : 'No'}`);
      if (marketInfo.auctionStatus.currentBid > 0n) {
        lines.push(`Current Bid: ${marketInfo.auctionStatus.currentBid} wei`);
      }
    }
  } else {
    lines.push('Oracle: Non-API3 (Chainlink/Other)');
    lines.push('OEV Enabled: No - Different oracle provider');
  }

  return lines.join('\n');
}

/**
 * Get summary of OEV-enabled markets
 */
export function getOevMarketsSummary(): string {
  const markets = Object.entries(API3_MORPHO_MARKETS_ETHEREUM)
    .filter(([_, info]) => info.isOevEnabled)
    .map(([id, info]) => `  • ${info.name} (${id.slice(0, 10)}...)`)
    .join('\n');

  return `Known OEV-Enabled Markets on Ethereum:\n${markets}`;
}

/**
 * Get vault info
 */
export function getVaultInfo() {
  return OEV_BOOSTED_USDC_VAULT;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  // Constants
  OEV_NETWORK_CHAIN_ID,
  OEV_NETWORK_RPC,
  OEV_AUCTION_HOUSE_ADDRESS,
  OEV_BOOSTED_USDC_VAULT,
  API3_ORACLES_ETHEREUM,
  API3_MORPHO_MARKETS_ETHEREUM,

  // Detection
  isApi3Oracle,
  checkMarketOracleType,

  // Auctions
  generateBidTopic,
  getAuctionStatus,
  estimateOptimalBid,

  // Filtering
  filterApi3Positions,
  getKnownApi3MarketIds,
  isOevEnabledMarket,
  getMarketInfo,

  // Utilities
  formatOevInfo,
  getOevMarketsSummary,
  getVaultInfo,
};
