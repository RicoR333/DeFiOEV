/**
 * Morpho Blue Data Fetcher
 *
 * This module fetches lending position data from Morpho Blue on Base using:
 * 1. Morpho's Official API (primary) - https://blue-api.morpho.org/graphql
 * 2. On-chain data via viem (fallback) - Direct contract reads
 *
 * WHAT IS MORPHO BLUE?
 * Morpho Blue is a minimalist, trustless lending protocol. Unlike Aave or Compound,
 * it's a primitive that allows anyone to create isolated lending markets.
 * Each market has:
 * - A collateral token (what borrowers deposit)
 * - A loan token (what borrowers receive)
 * - An oracle for price feeds
 * - A Liquidation Loan-To-Value (LLTV) ratio
 *
 * OEV OPPORTUNITY:
 * When a position's health factor drops below 1.0, it becomes liquidatable.
 * Liquidators can repay the debt and receive the collateral at a discount.
 * The "bonus" or discount is typically 5-15% depending on the protocol.
 */

import { GraphQLClient, gql } from 'graphql-request';
import { createPublicClient, http, formatUnits, parseAbi } from 'viem';
import { base } from 'viem/chains';
import logger from '../utils/logger';

// =============================================================================
// CONFIGURATION
// =============================================================================

// Morpho's Official GraphQL API endpoint
const MORPHO_API_URL = 'https://blue-api.morpho.org/graphql';

// Base chain ID for filtering
const BASE_CHAIN_ID = 8453;

// Morpho Blue contract address on Base
const MORPHO_BLUE_ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb' as const;

// Base RPC endpoint (public)
const BASE_RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

// Initialize GraphQL client for Morpho API
const graphqlClient = new GraphQLClient(MORPHO_API_URL);

// Initialize viem client for on-chain reads
const viemClient = createPublicClient({
  chain: base,
  transport: http(BASE_RPC_URL),
});

// =============================================================================
// TYPES
// =============================================================================

// Market information from API
export interface MorphoMarket {
  id: string;
  uniqueKey: string;
  lltv: string;
  collateralAsset: {
    address: string;
    symbol: string;
    decimals: number;
  };
  loanAsset: {
    address: string;
    symbol: string;
    decimals: number;
  };
  state: {
    borrowAssets: string;
    supplyAssets: string;
    collateral: string;
  } | null;
}

// Position from API
export interface MorphoAPIPosition {
  id: string;
  user: {
    address: string;
  };
  market: {
    uniqueKey: string;
    lltv: string;
    oracleAddress?: string;
    collateralAsset: {
      address: string;
      symbol: string;
      decimals: number;
    };
    loanAsset: {
      address: string;
      symbol: string;
      decimals: number;
    };
  };
  state: {
    collateral: string;
    borrowAssets: string;
    borrowShares: string;
  } | null;
}

// Simplified position for analysis
export interface AnalyzablePosition {
  id: string;
  borrower: string;
  marketId: string;
  collateralToken: {
    address: string;
    symbol: string;
    decimals: number;
  };
  loanToken: {
    address: string;
    symbol: string;
    decimals: number;
  };
  collateralAmount: bigint;
  borrowAmount: bigint;
  lltv: bigint;
  // OEV-specific fields
  oracleAddress?: string;
  isApi3Oracle?: boolean;
  isOevEnabled?: boolean;
}

// =============================================================================
// GRAPHQL QUERIES FOR MORPHO API
// =============================================================================

/**
 * Query to fetch markets on Base with active borrows
 * The Morpho API uses a different schema than The Graph subgraphs
 */
const MARKETS_QUERY = gql`
  query GetMarketsOnBase($chainId: Int!, $first: Int!) {
    markets(
      where: { chainId_in: [$chainId] }
      first: $first
      orderBy: BorrowAssets
      orderDirection: Desc
    ) {
      items {
        id
        uniqueKey
        lltv
        collateralAsset {
          address
          symbol
          decimals
        }
        loanAsset {
          address
          symbol
          decimals
        }
        state {
          borrowAssets
          supplyAssets
          collateral
        }
      }
    }
  }
`;

/**
 * Query to fetch positions with active borrows on Base
 * Includes oracle address for OEV detection
 */
const POSITIONS_QUERY = gql`
  query GetPositionsOnBase($chainId: Int!, $first: Int!, $skip: Int!) {
    marketPositions(
      where: {
        chainId_in: [$chainId],
        borrowShares_gte: "1"
      }
      first: $first
      skip: $skip
      orderBy: BorrowShares
      orderDirection: Desc
    ) {
      items {
        id
        user {
          address
        }
        market {
          uniqueKey
          lltv
          oracleAddress
          collateralAsset {
            address
            symbol
            decimals
          }
          loanAsset {
            address
            symbol
            decimals
          }
        }
        state {
          collateral
          borrowAssets
          borrowShares
        }
      }
    }
  }
`;

// =============================================================================
// API DATA FETCHING
// =============================================================================

/**
 * Fetch markets from Morpho's official API
 */
export async function fetchMarketsFromAPI(limit: number = 50): Promise<MorphoMarket[]> {
  logger.debug(`Fetching markets from Morpho API (chainId: ${BASE_CHAIN_ID})...`);

  try {
    interface MarketsResponse {
      markets: {
        items: MorphoMarket[];
      };
    }

    const response = await graphqlClient.request<MarketsResponse>(
      MARKETS_QUERY,
      { chainId: BASE_CHAIN_ID, first: limit }
    );

    const markets = response.markets?.items || [];
    logger.info(`Fetched ${markets.length} markets from Morpho API`);

    // Log active markets
    markets.forEach((market) => {
      const borrowAssets = BigInt(market.state?.borrowAssets || '0');
      if (borrowAssets > 0n) {
        logger.debug(
          `Market: ${market.collateralAsset?.symbol || 'Unknown'}/${market.loanAsset?.symbol || 'Unknown'}, ` +
          `LLTV: ${(Number(market.lltv) / 1e18 * 100).toFixed(1)}%`
        );
      }
    });

    return markets;
  } catch (error) {
    logger.error('Failed to fetch markets from API', error);
    throw error;
  }
}

/**
 * Fetch positions from Morpho's official API
 */
export async function fetchPositionsFromAPI(
  first: number = 100,
  skip: number = 0
): Promise<AnalyzablePosition[]> {
  logger.debug(`Fetching positions from Morpho API (first: ${first}, skip: ${skip})...`);

  try {
    interface PositionsResponse {
      marketPositions: {
        items: MorphoAPIPosition[];
      };
    }

    const response = await graphqlClient.request<PositionsResponse>(
      POSITIONS_QUERY,
      { chainId: BASE_CHAIN_ID, first, skip }
    );

    const rawPositions = response.marketPositions?.items || [];
    logger.info(`Fetched ${rawPositions.length} positions from Morpho API`);

    // Transform to analyzable format with OEV info
    const positions: AnalyzablePosition[] = rawPositions
      .filter((pos) => pos.state && pos.market)
      .map((pos) => ({
        id: pos.id,
        borrower: pos.user.address,
        marketId: pos.market.uniqueKey,
        collateralToken: {
          address: pos.market.collateralAsset.address,
          symbol: pos.market.collateralAsset.symbol,
          decimals: pos.market.collateralAsset.decimals,
        },
        loanToken: {
          address: pos.market.loanAsset.address,
          symbol: pos.market.loanAsset.symbol,
          decimals: pos.market.loanAsset.decimals,
        },
        collateralAmount: BigInt(pos.state?.collateral || '0'),
        borrowAmount: BigInt(pos.state?.borrowAssets || '0'),
        lltv: BigInt(pos.market.lltv || '0'),
        // OEV fields - will be populated by OEV module
        oracleAddress: pos.market.oracleAddress,
      }))
      // Filter out positions with no collateral or debt
      .filter((pos) => pos.collateralAmount > 0n && pos.borrowAmount > 0n);

    return positions;
  } catch (error) {
    logger.error('Failed to fetch positions from API', error);
    throw error;
  }
}

// =============================================================================
// ON-CHAIN DATA FETCHING (FALLBACK)
// =============================================================================

// Morpho Blue ABI (minimal for reading positions)
const MORPHO_BLUE_ABI = parseAbi([
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
]);

// ERC20 ABI for token info
const ERC20_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

/**
 * Fetch position data directly from the Morpho Blue contract
 * This is a fallback when the API is unavailable
 */
export async function fetchPositionOnChain(
  marketId: `0x${string}`,
  userAddress: `0x${string}`
): Promise<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint } | null> {
  try {
    const result = await viemClient.readContract({
      address: MORPHO_BLUE_ADDRESS,
      abi: MORPHO_BLUE_ABI,
      functionName: 'position',
      args: [marketId, userAddress],
    });

    return {
      supplyShares: result[0],
      borrowShares: BigInt(result[1]),
      collateral: BigInt(result[2]),
    };
  } catch (error) {
    logger.error(`Failed to fetch position on-chain for ${userAddress}`, error);
    return null;
  }
}

/**
 * Fetch market parameters from the Morpho Blue contract
 */
export async function fetchMarketOnChain(
  marketId: `0x${string}`
): Promise<{
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
} | null> {
  try {
    const result = await viemClient.readContract({
      address: MORPHO_BLUE_ADDRESS,
      abi: MORPHO_BLUE_ABI,
      functionName: 'idToMarketParams',
      args: [marketId],
    });

    return {
      loanToken: result[0],
      collateralToken: result[1],
      oracle: result[2],
      irm: result[3],
      lltv: result[4],
    };
  } catch (error) {
    logger.error(`Failed to fetch market on-chain for ${marketId}`, error);
    return null;
  }
}

/**
 * Fetch token info (symbol, decimals) from ERC20 contract
 */
export async function fetchTokenInfo(
  tokenAddress: `0x${string}`
): Promise<{ symbol: string; decimals: number } | null> {
  try {
    const [symbol, decimals] = await Promise.all([
      viemClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }),
      viemClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);

    return { symbol, decimals };
  } catch (error) {
    logger.debug(`Failed to fetch token info for ${tokenAddress}`, error);
    return null;
  }
}

// =============================================================================
// MAIN FETCH FUNCTIONS
// =============================================================================

/**
 * Fetch markets (tries API first, falls back to mock data for demo)
 */
export async function fetchMarkets(limit: number = 50): Promise<MorphoMarket[]> {
  try {
    return await fetchMarketsFromAPI(limit);
  } catch (error) {
    logger.warn('API fetch failed, using demo mode');
    return [];
  }
}

/**
 * Fetch positions with pagination (tries API first)
 */
export async function fetchPositions(
  first: number = 100,
  skip: number = 0
): Promise<AnalyzablePosition[]> {
  try {
    return await fetchPositionsFromAPI(first, skip);
  } catch (error) {
    logger.warn('API fetch failed for positions');
    throw error;
  }
}

/**
 * Fetch all positions with pagination
 */
export async function fetchAllPositions(
  maxPositions: number = 500
): Promise<AnalyzablePosition[]> {
  const allPositions: AnalyzablePosition[] = [];
  const pageSize = 100;
  let skip = 0;

  while (allPositions.length < maxPositions) {
    try {
      const positions = await fetchPositions(pageSize, skip);

      if (positions.length === 0) {
        break;
      }

      allPositions.push(...positions);
      skip += pageSize;

      // Respect API rate limits (5k/5min)
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      logger.warn(`Failed to fetch page at skip=${skip}, stopping pagination`);
      break;
    }
  }

  logger.info(`Total positions fetched: ${allPositions.length}`);
  return allPositions.slice(0, maxPositions);
}

/**
 * Get unique tokens from positions for price fetching
 */
export function getUniqueTokens(
  positions: AnalyzablePosition[]
): Map<string, { symbol: string; decimals: number }> {
  const tokens = new Map<string, { symbol: string; decimals: number }>();

  positions.forEach((pos) => {
    // Add collateral token
    if (!tokens.has(pos.collateralToken.address.toLowerCase())) {
      tokens.set(pos.collateralToken.address.toLowerCase(), {
        symbol: pos.collateralToken.symbol,
        decimals: pos.collateralToken.decimals,
      });
    }

    // Add loan token
    if (!tokens.has(pos.loanToken.address.toLowerCase())) {
      tokens.set(pos.loanToken.address.toLowerCase(), {
        symbol: pos.loanToken.symbol,
        decimals: pos.loanToken.decimals,
      });
    }
  });

  logger.debug(`Found ${tokens.size} unique tokens to price`);
  return tokens;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
  fetchMarkets,
  fetchPositions,
  fetchAllPositions,
  getUniqueTokens,
  // On-chain methods for direct access
  fetchPositionOnChain,
  fetchMarketOnChain,
  fetchTokenInfo,
  // Constants
  MORPHO_BLUE_ADDRESS,
  BASE_CHAIN_ID,
};
