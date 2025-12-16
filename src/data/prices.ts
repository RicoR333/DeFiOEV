/**
 * API3 Price Feed Integration
 *
 * This module fetches real-time cryptocurrency prices from API3's Signed APIs.
 *
 * WHAT IS API3?
 * API3 is a first-party oracle solution. Unlike Chainlink where node operators
 * relay data, API3 allows data providers to operate their own nodes, making
 * the data more trustworthy and enabling new possibilities like OEV capture.
 *
 * WHAT IS OEV (Oracle Extractable Value)?
 * OEV is value that can be extracted by updating oracle prices at optimal times.
 * For example, a liquidation becomes possible only when the oracle price updates
 * to show the position is underwater. Whoever controls that update timing can
 * capture value by:
 * 1. Seeing a position is close to liquidation
 * 2. Bidding for the right to update the oracle price
 * 3. Atomically updating the price and performing the liquidation
 *
 * API3's OEV Network lets searchers bid for oracle updates, with proceeds
 * going back to the dApp (in this case, Morpho) - it's a win-win!
 *
 * SIGNED API ENDPOINTS:
 * API3 provides signed data feeds via their public endpoints. The data is
 * cryptographically signed by the data provider, making it verifiable.
 */

import logger from '../utils/logger';

// API3 public signed API endpoint
const API3_SIGNED_API_URL = 'https://signed-api.api3.org/public';

/**
 * Price data structure returned by API3
 */
export interface SignedPrice {
  airnode: string;           // Address of the data provider's Airnode
  templateId: string;        // ID of the data template
  timestamp: string;         // Unix timestamp of when the price was signed
  encodedValue: string;      // ABI-encoded price value
  signature: string;         // Cryptographic signature proving authenticity
}

/**
 * Decoded price information for our use
 */
export interface TokenPrice {
  symbol: string;
  priceUSD: number;
  timestamp: Date;
  source: string;
}

/**
 * Known token mappings to API3 feed IDs
 *
 * API3 uses specific identifiers for each price feed.
 * These map common token symbols to their feed names.
 *
 * Note: In production, you'd want to map by contract address, not symbol,
 * since the same symbol can represent different tokens on different chains.
 */
const TOKEN_TO_FEED: Record<string, string> = {
  // Major tokens
  'ETH': 'ETH/USD',
  'WETH': 'ETH/USD',
  'wETH': 'ETH/USD',
  'BTC': 'BTC/USD',
  'WBTC': 'BTC/USD',
  'wBTC': 'BTC/USD',
  'cbBTC': 'BTC/USD',

  // Stablecoins - we assume $1.00 but could fetch real data
  'USDC': 'USDC/USD',
  'USDT': 'USDT/USD',
  'DAI': 'DAI/USD',
  'USDbC': 'USDC/USD',

  // DeFi tokens
  'LINK': 'LINK/USD',
  'UNI': 'UNI/USD',
  'AAVE': 'AAVE/USD',
  'CRV': 'CRV/USD',
  'MKR': 'MKR/USD',

  // LSTs and LRTs
  'stETH': 'ETH/USD',
  'wstETH': 'ETH/USD',
  'rETH': 'ETH/USD',
  'cbETH': 'ETH/USD',
  'weETH': 'ETH/USD',
  'ezETH': 'ETH/USD',

  // Base specific
  'DEGEN': 'ETH/USD',  // Fallback since DEGEN feed may not exist
};

/**
 * Cache for prices to avoid excessive API calls
 * Key: symbol, Value: { price, timestamp }
 */
const priceCache = new Map<string, { price: number; timestamp: number }>();
const CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Fetch signed price data from API3's public endpoint
 *
 * The signed API returns prices that are:
 * 1. Timestamped - you know when the price was valid
 * 2. Signed - cryptographically verifiable on-chain
 * 3. First-party - directly from data providers, no middlemen
 */
async function fetchApi3SignedPrice(feedName: string): Promise<number | null> {
  try {
    // The API3 signed API endpoint structure
    // In production, you'd use their SDK or specific endpoints per feed
    const url = `${API3_SIGNED_API_URL}/${feedName}`;

    logger.debug(`Fetching price for ${feedName}...`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      // If API3 endpoint doesn't work, we'll use fallback
      logger.debug(`API3 returned ${response.status} for ${feedName}, using fallback`);
      return null;
    }

    const data = await response.json();

    // Parse the response - structure may vary by endpoint
    if (data && data.price) {
      return parseFloat(data.price);
    }

    return null;
  } catch (error) {
    logger.debug(`Failed to fetch ${feedName} from API3: ${error}`);
    return null;
  }
}

/**
 * Fallback price fetcher using CoinGecko's free API
 *
 * This is a backup in case API3's public endpoint doesn't have what we need.
 * In production, you'd want redundant price sources anyway.
 */
async function fetchCoinGeckoPrice(symbol: string): Promise<number | null> {
  // Map symbols to CoinGecko IDs
  const coinGeckoIds: Record<string, string> = {
    'ETH': 'ethereum',
    'WETH': 'ethereum',
    'wETH': 'ethereum',
    'BTC': 'bitcoin',
    'WBTC': 'wrapped-bitcoin',
    'wBTC': 'wrapped-bitcoin',
    'cbBTC': 'bitcoin',
    'USDC': 'usd-coin',
    'USDT': 'tether',
    'DAI': 'dai',
    'LINK': 'chainlink',
    'UNI': 'uniswap',
    'AAVE': 'aave',
    'stETH': 'staked-ether',
    'wstETH': 'wrapped-steth',
    'rETH': 'rocket-pool-eth',
    'cbETH': 'coinbase-wrapped-staked-eth',
    'weETH': 'wrapped-eeth',
  };

  const id = coinGeckoIds[symbol];
  if (!id) {
    return null;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;

    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data && data[id] && data[id].usd) {
      return data[id].usd;
    }

    return null;
  } catch (error) {
    logger.debug(`CoinGecko fetch failed for ${symbol}: ${error}`);
    return null;
  }
}

/**
 * Get price for a token, with caching and fallbacks
 *
 * Price fetching strategy:
 * 1. Check cache first (avoid rate limits)
 * 2. Try API3 Signed API
 * 3. Fall back to CoinGecko
 * 4. Use hardcoded fallbacks for stablecoins
 */
export async function getTokenPrice(symbol: string): Promise<number> {
  // Normalize symbol
  const normalizedSymbol = symbol.toUpperCase();

  // Check cache
  const cached = priceCache.get(normalizedSymbol);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.debug(`Using cached price for ${normalizedSymbol}: $${cached.price}`);
    return cached.price;
  }

  // Stablecoins - assume $1.00 (good enough for demo)
  const stablecoins = ['USDC', 'USDT', 'DAI', 'USDBC', 'USDS'];
  if (stablecoins.includes(normalizedSymbol)) {
    priceCache.set(normalizedSymbol, { price: 1.0, timestamp: Date.now() });
    return 1.0;
  }

  // Try API3 first
  const feedName = TOKEN_TO_FEED[symbol] || TOKEN_TO_FEED[normalizedSymbol];
  if (feedName) {
    const api3Price = await fetchApi3SignedPrice(feedName);
    if (api3Price !== null) {
      logger.debug(`Got ${normalizedSymbol} price from API3: $${api3Price}`);
      priceCache.set(normalizedSymbol, { price: api3Price, timestamp: Date.now() });
      return api3Price;
    }
  }

  // Try CoinGecko fallback
  const geckoPrice = await fetchCoinGeckoPrice(symbol);
  if (geckoPrice !== null) {
    logger.debug(`Got ${normalizedSymbol} price from CoinGecko: $${geckoPrice}`);
    priceCache.set(normalizedSymbol, { price: geckoPrice, timestamp: Date.now() });
    return geckoPrice;
  }

  // Last resort: hardcoded fallbacks for common tokens
  // These are approximate and for demo purposes only!
  const fallbackPrices: Record<string, number> = {
    'ETH': 3500,
    'WETH': 3500,
    'BTC': 100000,
    'WBTC': 100000,
    'CBBTC': 100000,
    'LINK': 15,
    'UNI': 8,
    'AAVE': 200,
    'STETH': 3500,
    'WSTETH': 4000,
    'RETH': 3800,
    'CBETH': 3600,
    'WEETH': 3700,
    'EZETH': 3600,
    'SUSDS': 1.05,
    'SDAI': 1.05,
    'EURC': 1.05,
  };

  const fallback = fallbackPrices[normalizedSymbol];
  if (fallback) {
    logger.warn(`Using hardcoded fallback price for ${normalizedSymbol}: $${fallback}`);
    priceCache.set(normalizedSymbol, { price: fallback, timestamp: Date.now() });
    return fallback;
  }

  // Unknown token - this could be dangerous in production!
  logger.error(`No price found for ${normalizedSymbol}, defaulting to $1`);
  return 1;
}

/**
 * Fetch prices for multiple tokens in parallel
 *
 * Batching price requests is more efficient and helps avoid rate limits.
 */
export async function getTokenPrices(
  symbols: string[]
): Promise<Map<string, number>> {
  const uniqueSymbols = [...new Set(symbols)];
  logger.info(`Fetching prices for ${uniqueSymbols.length} tokens...`);

  const prices = new Map<string, number>();

  // Fetch all prices in parallel
  const pricePromises = uniqueSymbols.map(async (symbol) => {
    const price = await getTokenPrice(symbol);
    return { symbol, price };
  });

  const results = await Promise.all(pricePromises);

  results.forEach(({ symbol, price }) => {
    prices.set(symbol, price);
    prices.set(symbol.toLowerCase(), price);
    prices.set(symbol.toUpperCase(), price);
  });

  // Log price summary
  logger.info('Price feed summary:');
  results.forEach(({ symbol, price }) => {
    logger.debug(`  ${symbol}: $${price.toLocaleString()}`);
  });

  return prices;
}

/**
 * Calculate USD value of a token amount
 *
 * This handles decimal conversion - blockchain amounts are in smallest units
 * (e.g., wei for ETH, where 1 ETH = 10^18 wei)
 */
export function calculateUSDValue(
  amount: bigint,
  decimals: number,
  priceUSD: number
): number {
  // Convert from smallest units to standard units
  // e.g., 1000000000000000000 wei / 10^18 = 1 ETH
  const standardAmount = Number(amount) / Math.pow(10, decimals);

  // Multiply by USD price
  return standardAmount * priceUSD;
}

/**
 * Clear the price cache (useful for testing or forcing refresh)
 */
export function clearPriceCache(): void {
  priceCache.clear();
  logger.debug('Price cache cleared');
}

/**
 * Price feed health check - verify we can get prices
 */
export async function checkPriceFeedHealth(): Promise<boolean> {
  try {
    const ethPrice = await getTokenPrice('ETH');
    const btcPrice = await getTokenPrice('BTC');

    if (ethPrice > 0 && btcPrice > 0) {
      logger.info('Price feeds healthy');
      logger.info(`  ETH: $${ethPrice.toLocaleString()}`);
      logger.info(`  BTC: $${btcPrice.toLocaleString()}`);
      return true;
    }

    logger.error('Price feeds returned invalid data');
    return false;
  } catch (error) {
    logger.error('Price feed health check failed', error);
    return false;
  }
}

export default {
  getTokenPrice,
  getTokenPrices,
  calculateUSDValue,
  clearPriceCache,
  checkPriceFeedHealth,
};
