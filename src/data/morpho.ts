/**
 * Morpho Blue Subgraph Data Fetcher
 *
 * This module connects to The Graph's hosted service to fetch real-time
 * lending position data from Morpho Blue on Base.
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
 * WHAT IS A SUBGRAPH?
 * A subgraph is an indexing service that processes blockchain events and stores
 * them in a queryable database. This is much faster than reading directly from
 * the blockchain for historical or aggregated data.
 *
 * OEV OPPORTUNITY:
 * When a position's health factor drops below 1.0, it becomes liquidatable.
 * Liquidators can repay the debt and receive the collateral at a discount.
 * The "bonus" or discount is typically 5-15% depending on the protocol.
 */

import { GraphQLClient, gql } from 'graphql-request';
import logger from '../utils/logger';

// Morpho Blue subgraph endpoint on Base network
const MORPHO_SUBGRAPH_URL =
  'https://api.studio.thegraph.com/query/63379/morpho-blue-base/version/latest';

// Initialize GraphQL client
const client = new GraphQLClient(MORPHO_SUBGRAPH_URL);

/**
 * Types representing Morpho Blue data structures
 */

// Market information - defines the lending pool parameters
export interface MorphoMarket {
  id: string;                    // Unique market identifier (hash)
  loanToken: {
    id: string;                  // Token address
    symbol: string;              // e.g., "USDC"
    decimals: number;            // Token decimals (usually 6 for USDC, 18 for ETH)
  };
  collateralToken: {
    id: string;
    symbol: string;
    decimals: number;
  };
  lltv: string;                  // Liquidation LTV in basis points (e.g., 860000000000000000 = 86%)
  oracle: string;                // Oracle contract address
  totalSupply: string;           // Total assets supplied (in loan token units)
  totalBorrow: string;           // Total assets borrowed
  totalCollateral: string;       // Total collateral deposited
}

// Individual borrower position
export interface MorphoPosition {
  id: string;                    // Position ID
  borrower: string;              // Borrower's wallet address
  market: MorphoMarket;          // Market this position is in
  collateral: string;            // Collateral amount (in collateral token units)
  borrowShares: string;          // Borrow shares (not actual amount - needs conversion)
  borrowAssets: string;          // Actual borrowed amount
}

// Simplified position for our analysis
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
  collateralAmount: bigint;      // Raw collateral amount
  borrowAmount: bigint;          // Raw borrow amount
  lltv: bigint;                  // Liquidation threshold (in wei, 1e18 scale)
}

/**
 * GraphQL query to fetch active borrow positions
 *
 * We filter for:
 * - borrowAssets > 0: Position must have outstanding debt
 * - collateral > 0: Position must have collateral deposited
 *
 * We order by borrowAssets descending to prioritize larger positions
 * (larger positions = more profit potential)
 */
const POSITIONS_QUERY = gql`
  query GetBorrowPositions($first: Int!, $skip: Int!) {
    positions(
      first: $first
      skip: $skip
      where: { borrowAssets_gt: "0", collateral_gt: "0" }
      orderBy: borrowAssets
      orderDirection: desc
    ) {
      id
      borrower
      collateral
      borrowShares
      borrowAssets
      market {
        id
        lltv
        oracle
        totalSupply
        totalBorrow
        totalCollateral
        loanToken {
          id
          symbol
          decimals
        }
        collateralToken {
          id
          symbol
          decimals
        }
      }
    }
  }
`;

/**
 * GraphQL query to fetch market information
 */
const MARKETS_QUERY = gql`
  query GetMarkets($first: Int!) {
    markets(first: $first, orderBy: totalBorrow, orderDirection: desc) {
      id
      lltv
      oracle
      totalSupply
      totalBorrow
      totalCollateral
      loanToken {
        id
        symbol
        decimals
      }
      collateralToken {
        id
        symbol
        decimals
      }
    }
  }
`;

/**
 * Fetch all active markets from Morpho Blue
 *
 * Markets represent different lending pools. Each market is isolated,
 * meaning a liquidation in one market doesn't affect others.
 */
export async function fetchMarkets(limit: number = 100): Promise<MorphoMarket[]> {
  logger.debug(`Fetching top ${limit} Morpho Blue markets...`);

  try {
    const response = await client.request<{ markets: MorphoMarket[] }>(
      MARKETS_QUERY,
      { first: limit }
    );

    logger.info(`Fetched ${response.markets.length} markets`);

    // Log market summaries
    response.markets.forEach((market) => {
      const totalBorrow = BigInt(market.totalBorrow || '0');
      if (totalBorrow > 0n) {
        logger.debug(
          `Market: ${market.collateralToken.symbol}/${market.loanToken.symbol}, ` +
          `LLTV: ${(Number(market.lltv) / 1e18 * 100).toFixed(1)}%`
        );
      }
    });

    return response.markets;
  } catch (error) {
    logger.error('Failed to fetch markets', error);
    throw error;
  }
}

/**
 * Fetch borrower positions from the subgraph
 *
 * This is the core data we need for liquidation analysis.
 * We paginate through results to get all positions.
 */
export async function fetchPositions(
  first: number = 100,
  skip: number = 0
): Promise<AnalyzablePosition[]> {
  logger.debug(`Fetching positions (first: ${first}, skip: ${skip})...`);

  try {
    const response = await client.request<{ positions: MorphoPosition[] }>(
      POSITIONS_QUERY,
      { first, skip }
    );

    logger.info(`Fetched ${response.positions.length} active positions`);

    // Transform raw positions into analyzable format
    const positions: AnalyzablePosition[] = response.positions.map((pos) => ({
      id: pos.id,
      borrower: pos.borrower,
      marketId: pos.market.id,
      collateralToken: {
        address: pos.market.collateralToken.id,
        symbol: pos.market.collateralToken.symbol,
        decimals: pos.market.collateralToken.decimals,
      },
      loanToken: {
        address: pos.market.loanToken.id,
        symbol: pos.market.loanToken.symbol,
        decimals: pos.market.loanToken.decimals,
      },
      collateralAmount: BigInt(pos.collateral || '0'),
      borrowAmount: BigInt(pos.borrowAssets || '0'),
      lltv: BigInt(pos.market.lltv || '0'),
    }));

    return positions;
  } catch (error) {
    logger.error('Failed to fetch positions', error);
    throw error;
  }
}

/**
 * Fetch all positions with pagination
 *
 * The subgraph limits results to 1000 per query, so we need to
 * paginate to get all positions if there are many.
 */
export async function fetchAllPositions(
  maxPositions: number = 500
): Promise<AnalyzablePosition[]> {
  const allPositions: AnalyzablePosition[] = [];
  const pageSize = 100;
  let skip = 0;

  while (allPositions.length < maxPositions) {
    const positions = await fetchPositions(pageSize, skip);

    if (positions.length === 0) {
      break; // No more positions
    }

    allPositions.push(...positions);
    skip += pageSize;

    // Small delay to avoid rate limiting
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.info(`Total positions fetched: ${allPositions.length}`);
  return allPositions.slice(0, maxPositions);
}

/**
 * Get unique tokens from positions for price fetching
 *
 * We need prices for both collateral and loan tokens to calculate
 * health factors and liquidation profitability.
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

export default {
  fetchMarkets,
  fetchPositions,
  fetchAllPositions,
  getUniqueTokens,
};
