import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'module';
import fetch from 'node-fetch';
import { z } from 'zod';

// Server version, read from package.json so the banner, capabilities
// document, and status tool always report the published version.
const SERVER_VERSION = createRequire(import.meta.url)('../package.json').version;

// Optional API key from environment
const API_KEY = process.env.COINPAPRIKA_API_KEY || '';

// Base URL for CoinPaprika API.
// Free tier uses api.coinpaprika.com; paid plans use api-pro.coinpaprika.com.
// Same key, different host. Hitting the free host with a paid key still
// returns data but applies free-tier limits and omits paid-tier fields.
const API_FREE_URL = 'https://api.coinpaprika.com/v1';
const API_PRO_URL = 'https://api-pro.coinpaprika.com/v1';
const API_BASE_URL = API_KEY ? API_PRO_URL : API_FREE_URL;

// Error code constants
const ErrorCodes = {
  CP400_INVALID_COIN_ID: "CP400_INVALID_COIN_ID",
  CP400_BAD_REQUEST: "CP400_BAD_REQUEST",
  CP402_INSUFFICIENT_PLAN: "CP402_INSUFFICIENT_PLAN",
  CP403_FORBIDDEN: "CP403_FORBIDDEN",
  CP404_NOT_FOUND: "CP404_NOT_FOUND",
  CP429_RATE_LIMIT: "CP429_RATE_LIMIT",
  CP500_SERVER_ERROR: "CP500_SERVER_ERROR",
  CP_UNKNOWN_ERROR: "CP_UNKNOWN_ERROR",
};

// Coin ID validation regex
const COIN_ID_REGEX = /^[a-z0-9]+-[a-z0-9-]+$/;

// Canonical-slug guidance shared by every tool that takes a coin id. Agents
// kept passing ticker symbols ("BTC") or guessing slugs, then retry-looping on
// "resource not found" (devrel#5). The slug is NOT derivable from the symbol,
// so steer them to search / resolveId first.
const COIN_ID_DESCRIPTION =
  "Canonical CoinPaprika coin slug in 'symbol-name' format, e.g. 'btc-bitcoin', " +
  "'eth-ethereum', 'ada-cardano'. Do NOT pass ticker symbols ('BTC', 'AAVE') " +
  "or guess the slug; it is not derivable from the symbol (e.g. AAVE resolves " +
  "to 'aave-new', which you could not guess). Call search or resolveId first to " +
  "resolve a symbol or name to its canonical id.";

// Known misspellings, surfaced in getCapabilities so MCP catalogs / tool
// routers / agent frameworks can match fuzzy references back to us (devrel#6).
const SERVER_ALIASES = ["coinparika", "coinpapika", "coinaprika", "coin-paprika", "coin paprika"];

// Structured error response builder
function buildErrorResponse(code, message, retryable, suggestion, correctedExample, metadata) {
  const error = {
    error: {
      code,
      message,
      retryable,
      suggestion,
    }
  };
  if (correctedExample) {
    error.error.corrected_example = correctedExample;
  }
  if (metadata) {
    error.error.metadata = metadata;
  }
  return error;
}

// Parse API error response and convert to structured format
function parseAPIError(status, statusText, endpoint) {
  if (status === 403) {
    return buildErrorResponse(
      ErrorCodes.CP403_FORBIDDEN,
      'This endpoint is not available on the free tier',
      false,
      'Upgrade your API plan at https://coinpaprika.com/api/pricing/',
      undefined,
      { endpoint }
    );
  }

  if (status === 402) {
    return buildErrorResponse(
      ErrorCodes.CP402_INSUFFICIENT_PLAN,
      'This endpoint requires a paid plan',
      false,
      'Upgrade your API plan at https://coinpaprika.com/api/pricing/',
      undefined,
      { required_plan: 'Pro or higher', endpoint }
    );
  }

  if (status === 429) {
    return buildErrorResponse(
      ErrorCodes.CP429_RATE_LIMIT,
      'Rate limit exceeded',
      true,
      'Back off and retry. The free-tier quota is 20,000 calls per month, not a daily allowance, so a sustained 429 means the monthly allowance is spent. See https://coinpaprika.com/api/pricing/',
      undefined,
      {
        free_tier_calls_per_month: 20000,
        pricing_url: 'https://coinpaprika.com/api/pricing/'
      }
    );
  }

  if (status === 404) {
    return buildErrorResponse(
      ErrorCodes.CP404_NOT_FOUND,
      'Resource not found',
      false,
      'No resource with that id exists. It may be misspelled, retired, or for a different entity. Call search or resolveId to get the current canonical id, then retry.',
      undefined,
      { endpoint }
    );
  }

  if (status === 400) {
    return buildErrorResponse(
      ErrorCodes.CP400_BAD_REQUEST,
      `Invalid request parameters: ${statusText}`,
      false,
      'Check the parameter formats and values',
      undefined,
      { endpoint }
    );
  }

  if (status >= 500) {
    return buildErrorResponse(
      ErrorCodes.CP500_SERVER_ERROR,
      'Internal server error. Please try again later',
      true,
      'The API server encountered an error. Wait a moment and retry',
      undefined,
      { status }
    );
  }

  return buildErrorResponse(
    ErrorCodes.CP_UNKNOWN_ERROR,
    `Unexpected upstream error ${status} ${statusText}`,
    false,
    'An unexpected error occurred. Check API documentation or try again later',
    undefined,
    { endpoint, status }
  );
}

// Validate coin ID format
function validateCoinId(coinId) {
  if (!COIN_ID_REGEX.test(coinId)) {
    return buildErrorResponse(
      ErrorCodes.CP400_INVALID_COIN_ID,
      `Coin ID '${coinId}' is invalid`,
      false,
      "Use correct coin ID format: symbol-name. Try search(q: coinId) to find the correct ID.",
      "getCoinById({ coinId: 'btc-bitcoin' })",
      {
        provided: coinId,
        correct_format: "symbol-name",
        examples: ["btc-bitcoin", "eth-ethereum", "ada-cardano"]
      }
    );
  }
  return null;
}

// Quota tracking. The CoinPaprika free tier is a MONTHLY allowance (20,000
// calls), not a daily one. This counter only sees calls made by this process
// since it started, so `remaining` is a local upper bound, not the account's
// real balance. Use the keyInfo tool with a paid key for the authoritative
// figure.
let requestCount = 0;
const FREE_TIER_CALLS_PER_MONTH = 20000;

// Build request headers (with optional API key)
function buildHeaders() {
  const headers = { 'content-type': 'application/json' };
  if (API_KEY) {
    // CoinPaprika expects the bare API key. The "Bearer" prefix triggers a
    // Cloudflare WAF block on api-pro and returns HTTP 403.
    headers['Authorization'] = API_KEY;
  }
  return headers;
}

// Clamp utility
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Helper function to fetch data from CoinPaprika API with structured error handling
async function fetchFromAPI(endpoint) {
  const startTime = Date.now();
  const response = await fetch(`${API_BASE_URL}${endpoint}`, { headers: buildHeaders() });

  if (!response.ok) {
    const structuredError = parseAPIError(response.status, response.statusText, endpoint);
    throw structuredError;
  }

  const data = await response.json();
  requestCount++;
  const responseTime = Date.now() - startTime;

  return {
    data,
    meta: {
      quota: {
        free_tier_calls_per_month: FREE_TIER_CALLS_PER_MONTH,
        used_this_process: requestCount,
        scope: 'this process since start, not the account balance',
        pricing_url: 'https://coinpaprika.com/api/pricing/'
      },
      response_time_ms: responseTime,
      cached: false,
      timestamp: new Date().toISOString()
    }
  };
}

// Helper to format response for MCP
function formatMcpResponse(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

// Helper to format MCP error response
function formatMcpError(error) {
  if (error && typeof error === 'object' && 'error' in error) {
    return formatMcpResponse(error);
  }
  return formatMcpResponse({
    error: {
      code: ErrorCodes.CP_UNKNOWN_ERROR,
      message: error instanceof Error ? error.message : 'Unknown error',
      retryable: false,
      suggestion: "Please try again later or check API documentation"
    }
  });
}

// Helper for paid-tier tools with error guidance
async function withGuidance(exec, hint) {
  try {
    const response = await exec();
    return formatMcpResponse(response);
  } catch (e) {
    if (e && typeof e === 'object' && 'error' in e) {
      return formatMcpResponse(e);
    }
    const message = e instanceof Error ? e.message : String(e);
    return formatMcpError({
      error: {
        code: ErrorCodes.CP_UNKNOWN_ERROR,
        message,
        retryable: false,
        suggestion: hint || 'This endpoint may require a paid plan. Get an API key at https://coinpaprika.com/api/pricing/'
      }
    });
  }
}

// Build capabilities document
function buildCapabilitiesDocument() {
  return {
    service: "coinpaprika",
    aliases: SERVER_ALIASES,
    version: SERVER_VERSION,
    description: "Real-time cryptocurrency prices and market data for 12,000+ coins",
    server: {
      name: "CoinPaprika MCP Server",
      version: SERVER_VERSION,
      description: "Real-time cryptocurrency prices, market caps, 24h changes and volumes for 12,000+ coins (Bitcoin, Ethereum, Solana, and more) and 350+ exchanges. Use for how much a crypto is worth, top coins by market cap, or live market data.",
      documentation_url: "https://docs.coinpaprika.com",
    },
    tools: [
      {
        name: "status",
        description: "Get the CoinPaprika MCP server's status and configuration (uptime, mode, enabled features). Use when asked 'is the server up', 'what mode am I in', 'server status'. This reports the MCP server itself, not the crypto market; for market health use getGlobal.",
        category: "system",
        parameters: {},
        returns: { type: "object" },
        cost: 0
      },
      {
        name: "getGlobal",
        description: "Get a global crypto market overview: total market cap, total 24h volume, Bitcoin dominance, and market-wide 24h change. Use for 'how is the crypto market doing', 'total market cap', 'BTC dominance'. For a single coin's price use getTickersById.",
        category: "market",
        parameters: {},
        returns: { type: "object", properties: ["market_cap_usd", "volume_24h_usd", "bitcoin_dominance_percentage"] },
        cost: 1
      },
      {
        name: "getCoins",
        description: "List available coins (id, name, symbol, rank). Use to discover coins or map a name to an id. Does NOT include prices; for prices use getTickers or getTickersById.",
        category: "coins",
        parameters: { limit: { type: "integer", required: false, default: 50, min: 1, max: 250 } },
        returns: { type: "array", items: "Coin" },
        cost: 1
      },
      {
        name: "getTickers",
        description: "Get current prices, market caps and 24h changes for the top cryptocurrencies ranked by market cap. Use for 'top 5 coins', 'top crypto today', 'biggest cryptocurrencies', or a market snapshot. For one specific coin use getTickersById.",
        category: "market",
        parameters: {
          quotes: { type: "string", required: false, default: "USD", description: "Comma-separated quote currencies" },
          limit: { type: "integer", required: false, default: 50, min: 1, max: 250 }
        },
        returns: { type: "array", items: "Ticker" },
        cost: 1
      },
      {
        name: "getCoinOHLCVLatest",
        description: "Get the latest full-day OHLC candle (open/high/low/close plus volume) for a coin. For the live spot price use getTickersById.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id", example: "btc-bitcoin" },
          quote: { type: "string", required: false, default: "usd" }
        },
        returns: { type: "array", items: "OHLCV" },
        cost: 1
      },
      {
        name: "getCoinOHLCVToday",
        description: "Get today's in-progress OHLC candle for a coin. For the current spot price use getTickersById; for past candles use getCoinOHLCVHistorical.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          quote: { type: "string", required: false, default: "usd" }
        },
        returns: { type: "array", items: "OHLCV" },
        cost: 1
      },
      {
        name: "getCoinOHLCVHistorical",
        description: "Get OHLC candles (open/high/low/close plus volume) for a coin over a date range, for price charts, backtests and technical analysis. Use for 'daily chart for the last month', 'hourly candles since Jan 1'. For a single past date's spot value use getTickersHistoricalById; not for the current price. Requires Starter+ plan.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          start: { type: "string", required: true },
          end: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 },
          interval: { type: "string", required: false, default: "24h", enum: ["5m", "15m", "30m", "1h", "6h", "12h", "24h"] },
          quote: { type: "string", required: false, default: "usd" }
        },
        returns: { type: "array", items: "OHLCV" },
        cost: 10
      },
      {
        name: "getCoinById",
        description: "Get descriptive project information about a coin (description, links, team, tags). Does NOT include price; for price/market cap use getTickersById.",
        category: "coins",
        parameters: { coinId: { type: "string", required: true, format: "coin-id", example: "btc-bitcoin" } },
        returns: { type: "object", properties: ["id", "name", "symbol", "description", "links", "rank"] },
        cost: 1
      },
      {
        name: "getCoinEvents",
        description: "Get the timeline of events for a coin (launches, partnerships, hard forks, conference talks) with dates and descriptions. Use when asked 'what is happening with X', 'upcoming events for Ethereum', 'X roadmap events'. For prices or market data use getTickersById.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Event" },
        cost: 1
      },
      {
        name: "getCoinExchanges",
        description: "List the exchanges that LIST a specific coin (venue names only). Use for 'which exchanges list X', 'is X on Coinbase', 'where is X listed'. For where to BUY with per-market price and volume use getCoinMarkets; for the coin's live price use getTickersById.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Exchange" },
        cost: 1
      },
      {
        name: "getCoinMarkets",
        description: "Get the specific markets and trading pairs where a coin trades, with per-market price and 24h volume. Use for 'where can I buy X', 'X price on Binance', 'best market for X'. For just the list of exchange names use getCoinExchanges.",
        category: "coins",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          quotes: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Market" },
        cost: 1
      },
      {
        name: "getTickersById",
        description: "Get the current price, market cap, 24h change and volume of a specific cryptocurrency in USD (or another quote currency). Use when asked 'what is the price of X', 'how much is Bitcoin worth', 'BTC to USD', 'ETH price now'. For past prices use getTickersHistoricalById.",
        category: "market",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          quotes: { type: "string", required: false }
        },
        returns: { type: "object", properties: ["price", "volume_24h", "market_cap"] },
        cost: 1
      },
      {
        name: "getTickersHistoricalById",
        description: "Get a coin's price and market cap at a single past date or time (a point-in-time value). Use for 'price of BTC last Tuesday', 'ETH market cap on 2024-01-01'. For OHLC chart candles over a range use getCoinOHLCVHistorical, not this. Not for the current price (use getTickersById). Requires Starter+ plan.",
        category: "market",
        parameters: {
          coinId: { type: "string", required: true, format: "coin-id" },
          start: { type: "string", required: true },
          end: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 },
          quote: { type: "string", required: false, default: "usd" },
          interval: { type: "string", required: false, default: "5m" }
        },
        returns: { type: "array", items: "HistoricalTicker" },
        cost: 10
      },
      {
        name: "getPeopleById",
        description: "Get profile information about a person in crypto (bio, roles, linked projects and accounts). Use when asked 'who is Vitalik Buterin', 'background on X founder', 'projects tied to this person'. Look up the person id first with search.",
        category: "people",
        parameters: { personId: { type: "string", required: true } },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getTags",
        description: "List all CoinPaprika tags (categories such as defi, stablecoin, memecoin, ai) used to group coins. Use when asked 'what categories exist', 'list crypto sectors', or to find a tag id before calling getTagById.",
        category: "tags",
        parameters: {
          additionalFields: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Tag" },
        cost: 1
      },
      {
        name: "getTagById",
        description: "Get details for a specific tag: its description and the coins and ICOs grouped under it. Use when asked 'what coins are in the defi tag', 'show the stablecoin category', 'tokens tagged X'. Get the tag id first from getTags.",
        category: "tags",
        parameters: {
          tagId: { type: "string", required: true },
          additionalFields: { type: "string", required: false }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getExchanges",
        description: "List all exchanges tracked by CoinPaprika with rank, trust score and volume. Use when asked 'top exchanges', 'biggest crypto exchanges', 'list exchanges by volume', or to find an exchange id before calling getExchangeByID.",
        category: "exchanges",
        parameters: {
          quotes: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Exchange" },
        cost: 1
      },
      {
        name: "getExchangeByID",
        description: "Get details for a specific exchange (volume, market count, trust score, links, fiat support). Use when asked 'tell me about Binance', 'Coinbase exchange stats', 'is X a trustworthy exchange'. For the pairs traded there use getExchangeMarkets; find the exchange id first with search or getExchanges.",
        category: "exchanges",
        parameters: {
          exchangeId: { type: "string", required: true },
          quotes: { type: "string", required: false }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getExchangeMarkets",
        description: "List the trading pairs (markets) on a specific exchange with price and 24h volume per pair. Use when asked 'what pairs trade on Binance', 'markets on Kraken', 'BTC pairs on X exchange'. For exchange-level stats use getExchangeByID.",
        category: "exchanges",
        parameters: {
          exchangeId: { type: "string", required: true },
          quotes: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Market" },
        cost: 1
      },
      {
        name: "getPlatforms",
        description: "List the smart-contract platforms (blockchains such as ethereum, bnb, polygon) for which CoinPaprika indexes token contracts. Use when asked 'which chains are supported for contract lookups', 'list contract platforms', or to pick a platform id before calling getContracts.",
        category: "contracts",
        parameters: { limit: { type: "integer", required: false, default: 50 } },
        returns: { type: "array", items: "Platform" },
        cost: 1
      },
      {
        name: "getContracts",
        description: "List the token contract addresses tracked on a specific platform, mapping each contract to its CoinPaprika coin id. Use when asked 'contracts on ethereum', 'what tokens does X chain have', or to map a contract address to a coin id. Get the platform id first from getPlatforms; for a single contract's price use getTickerByContract.",
        category: "contracts",
        parameters: {
          platformId: { type: "string", required: true },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array", items: "Contract" },
        cost: 1
      },
      {
        name: "getTickerByContract",
        description: "Get the current price and market data of a token by its contract address (for on-chain and DeFi tokens). Use when you have a 0x... or contract address rather than a name. For history use getHistoricalTickerByContract.",
        category: "contracts",
        parameters: {
          platformId: { type: "string", required: true },
          contractAddress: { type: "string", required: true }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getHistoricalTickerByContract",
        description: "Get historical price and market data of a token by its contract address. Not for the current price (use getTickerByContract). Requires Starter+ plan.",
        category: "contracts",
        parameters: {
          platformId: { type: "string", required: true },
          contractAddress: { type: "string", required: true },
          start: { type: "string", required: true },
          end: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 },
          quote: { type: "string", required: false, default: "usd" },
          interval: { type: "string", required: false, default: "5m" }
        },
        returns: { type: "array" },
        cost: 10
      },
      {
        name: "search",
        description: "Broadly search CoinPaprika across coins, exchanges, ICOs, people and tags by name or symbol when the entity type is unknown or you are exploring. Use for 'find anything called X'. If you specifically need a coin's canonical id to fetch its price, prefer resolveId.",
        category: "search",
        parameters: {
          q: { type: "string", required: true },
          categories: { type: "string", required: false },
          modifier: { type: "string", required: false },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "resolveId",
        description: "Resolve a coin name or symbol ('bitcoin', 'BTC', 'AAVE') to its single canonical CoinPaprika id ('btc-bitcoin', 'aave-new'). Call this FIRST whenever you have a bare symbol or name and want the coin's price, since ids are not derivable from symbols; then pass the id to getTickersById.",
        category: "search",
        parameters: {
          type: { type: "string", required: true, enum: ["coin", "exchange", "people", "tags"] },
          query: { type: "string", required: true },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array" },
        cost: 1
      },
      {
        name: "priceConverter",
        description: "Convert an amount from one crypto or fiat to another at the current rate ('how much is 0.5 BTC in USD', 'convert 100 USDC to EUR'). For a plain coin price without an amount, use getTickersById.",
        category: "tools",
        parameters: {
          baseCurrencyId: { type: "string", required: true },
          quoteCurrencyId: { type: "string", required: true },
          amount: { type: "number", required: false, default: 0 }
        },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "keyInfo",
        description: "Get details and usage for the current CoinPaprika API key (plan, quota, requests remaining, expiry). Use when asked 'what plan am I on', 'how many requests are left', 'is my API key valid'. Requires a Pro plan.",
        category: "system",
        parameters: {},
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getMappings",
        description: "Get mappings between CoinPaprika ids and external or legacy identifiers so you can reconcile ids across systems. Use when asked 'map CoinPaprika ids to X', 'id crosswalk', 'external id mapping'. Requires a Business plan.",
        category: "system",
        parameters: {
          coinpaprika: { type: "string", required: false },
          coinmarketcap: { type: "string", required: false },
          coingecko: { type: "string", required: false },
          cryptocompare: { type: "string", required: false },
          isin: { type: "string", required: false },
          dti: { type: "string", required: false }
        },
        returns: { type: "array" },
        cost: 1
      },
      {
        name: "getChangelogIDs",
        description: "Get the ids of recent changes to CoinPaprika's coin and exchange listings (additions, renames, delistings) for syncing a local dataset. Use when asked 'what changed recently', 'new or delisted coins', 'listing changelog'. Requires a Starter+ plan.",
        category: "system",
        parameters: {
          page: { type: "integer", required: false, default: 1 },
          limit: { type: "integer", required: false, default: 50 }
        },
        returns: { type: "array" },
        cost: 1
      }
    ],

    validation_rules: {
      coin_id_format: "^[a-z0-9]+-[a-z0-9-]+$",
      examples: {
        valid_coin_ids: ["btc-bitcoin", "eth-ethereum", "ada-cardano", "bnb-binance-coin"],
        invalid_coin_ids: ["bitcoin", "BTC", "Ethereum", "btc"]
      }
    },

    rate_limits: {
      free_tier_calls_per_month: 20000,
      note: "Free tier allowance. Paid plans start at 400,000 calls per month; see https://coinpaprika.com/api/pricing/",
      documentation_url: "https://docs.coinpaprika.com",
      pricing_url: "https://coinpaprika.com/api/pricing/"
    },

    error_codes: {
      CP400_INVALID_COIN_ID: "Coin ID format invalid. Use format: symbol-name (e.g., btc-bitcoin)",
      CP400_MISSING_REQUIRED: "Required parameter is missing",
      CP400_BAD_REQUEST: "Invalid request parameters",
      CP402_INSUFFICIENT_PLAN: "This endpoint requires a paid plan",
      CP403_FORBIDDEN: "Access forbidden. Check API key or plan",
      CP404_NOT_FOUND: "Resource not found. Use search to find correct IDs",
      CP429_RATE_LIMIT: "Rate limit exceeded. The free-tier quota is monthly, not daily",
      CP500_SERVER_ERROR: "Internal server error. Please try again later"
    },

    workflow_patterns: {
      coin_analysis: {
        description: "Analyze a specific cryptocurrency",
        steps: [
          "search - Find coin by name or symbol to get coin_id",
          "getCoinById - Get detailed coin info (description, team, links)",
          "getTickersById - Get current price, volume, market cap",
          "getCoinOHLCVLatest - Get latest OHLCV data",
          "getCoinMarkets - Find trading pairs and exchanges",
        ],
        example_use_case: "Comprehensive analysis of Bitcoin's current state",
      },
      market_overview: {
        description: "Get a high-level market overview",
        steps: [
          "getGlobal - Get total market cap, volume, BTC dominance",
          "getTickers - Get top coins by market cap",
          "getExchanges - See top exchanges by volume",
        ],
        example_use_case: "Daily crypto market summary report",
      },
      price_comparison: {
        description: "Compare prices across exchanges",
        steps: [
          "resolveId - Find canonical coin ID",
          "getCoinExchanges - List exchanges trading the coin",
          "getCoinMarkets - Get trading pairs with prices",
          "priceConverter - Convert between currencies",
        ],
        example_use_case: "Finding best price for a coin across exchanges",
      },
      token_by_contract: {
        description: "Look up a token by its contract address",
        steps: [
          "getPlatforms - List available contract platforms",
          "getContracts - List contracts on a platform",
          "getTickerByContract - Get the current price and market data of a token by its contract address (for on-chain/DeFi tokens). Use when you have a 0x.../contract address rather than a name. For history use getHistoricalTickerByContract.",
        ],
        example_use_case: "Looking up an ERC-20 token by its Ethereum contract",
      },
      historical_analysis: {
        description: "Historical price analysis (requires paid plan)",
        steps: [
          "resolveId - Find canonical coin ID",
          "getCoinOHLCVHistorical - Get historical OHLCV candles",
          "getTickersHistoricalById - Get historical ticker snapshots",
        ],
        example_use_case: "Analyzing price trends over a specific period",
        note: "Historical endpoints require Starter+ plan",
      },
    },

    parameter_examples: {
      getCoinById: {
        basic: { description: "Get Bitcoin details", params: { coinId: "btc-bitcoin" } },
      },
      getTickers: {
        multi_quote: { description: "Get tickers in USD and BTC", params: { quotes: "USD,BTC", limit: 20 } },
      },
      search: {
        by_name: { description: "Search by coin name", params: { q: "bitcoin" } },
        by_symbol: { description: "Search by ticker symbol", params: { q: "ETH" } },
        filtered: { description: "Search only exchanges", params: { q: "binance", categories: "exchanges" } },
      },
      priceConverter: {
        btc_to_usd: { description: "Convert 1 BTC to USD", params: { baseCurrencyId: "btc-bitcoin", quoteCurrencyId: "usd-us-dollars", amount: 1 } },
      },
    },

    best_practices: {
      workflow: [
        "Call getCapabilities first to understand available tools and workflows",
        "Use search or resolveId to find correct coin IDs before other calls",
        "Coin IDs use format: symbol-name (e.g., btc-bitcoin, eth-ethereum)",
        "Start with small limit values and increase if needed",
        "Use getGlobal for quick market overview before diving into specifics",
      ],
      performance: [
        "Use getTickers with limit for batch price queries",
        "Cache getCoins and getExchanges responses (they change infrequently)",
        "Use quotes parameter to get multiple currency conversions in one call",
      ],
      error_handling: [
        "Always validate coin ID format before API calls",
        "Handle 402/403 errors gracefully; they indicate paid-plan requirements",
        "Retry with backoff for 429 rate limit errors",
        "Use resolveId to find correct IDs when 404 errors occur",
      ],
    },

    meta: {
      documentation: "https://docs.coinpaprika.com",
      pricing: "https://coinpaprika.com/api/pricing/",
      support: "https://github.com/coinpaprika/coinpaprika-mcp"
    }
  };
}

// MCP server instance
const server = new McpServer({
  name: 'coinpaprika',
  version: SERVER_VERSION,
  description: 'MCP server for accessing CoinPaprika cryptocurrency market data',
});

// devrel#5 parity: validate coin/currency id format BEFORE the handler runs,
// returning the structured CP400_INVALID_COIN_ID guidance (matches the hosted
// MCP). Wrapping server.tool centralizes this for every id-bearing tool
// (coinId / baseCurrencyId / quoteCurrencyId) instead of repeating it in each
// handler, so a ticker symbol like "BTC" gets actionable guidance to call
// search/resolveId instead of a bare upstream 404.
const _registerTool = server.tool.bind(server);
server.tool = (...regArgs) => {
  const handler = regArgs[regArgs.length - 1];
  const schema = regArgs.length >= 4 && regArgs[2] && typeof regArgs[2] === 'object' ? regArgs[2] : null;
  if (typeof handler === 'function' && schema) {
    const idFields = ['coinId', 'baseCurrencyId', 'quoteCurrencyId'].filter((f) => f in schema);
    if (idFields.length > 0) {
      regArgs[regArgs.length - 1] = async (args, ...rest) => {
        for (const f of idFields) {
          const v = args && args[f];
          if (typeof v === 'string') {
            const err = validateCoinId(v);
            if (err) return formatMcpError(err);
          }
        }
        return handler(args, ...rest);
      };
    }
  }
  return _registerTool(...regArgs);
};

// ─── Tool 1: status ───
server.tool(
  'status',
  "Get the CoinPaprika MCP server's status and configuration (uptime, mode, enabled features). Use when asked 'is the server up', 'what mode am I in', 'server status'. This reports the MCP server itself, not the crypto market; for market health use getGlobal. Read-only; takes no parameters and needs no API key.",
  {},
  async () => {
    const statusData = {
      server: 'CoinPaprika MCP Server',
      version: SERVER_VERSION,
      api_base_url: API_BASE_URL,
      api_key_configured: !!API_KEY,
      mode: API_KEY ? 'authenticated' : 'free-tier',
      paid_features: API_KEY
        ? 'API key configured, paid-tier endpoints available'
        : 'No API key configured. For Pro/Business features, set COINPAPRIKA_API_KEY environment variable. Get a key at https://coinpaprika.com/api/pricing/',
    };
    return formatMcpResponse(statusData);
  }
);

// ─── Tool 2: getGlobal ───
server.tool(
  'getGlobal',
  "Get a global crypto market overview: total market cap, total 24h volume, Bitcoin dominance, and market-wide 24h change. Use for 'how is the crypto market doing', 'total market cap', 'BTC dominance'. For a single coin's price use getTickersById. Read-only; takes no parameters and needs no API key.",
  {},
  async () => {
    try {
      const response = await fetchFromAPI('/global');
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 3: getCoins ───
server.tool(
  'getCoins',
  "List all available coins with id, name, symbol and rank. Use to discover coins or map a name to an id. Does NOT include prices; for prices use getTickers or getTickersById. Read-only; limit caps the number of coins returned. No API key required.",
  { limit: z.number().optional().default(50).describe("Number of coins to return (default: 50, max: 250)") },
  async ({ limit = 50 }) => {
    try {
      const response = await fetchFromAPI('/coins');
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 4: getTickers ───
server.tool(
  'getTickers',
  "Get current prices, market caps and 24h changes for the top cryptocurrencies ranked by market cap. Use for 'top 5 coins', 'top crypto today', 'biggest cryptocurrencies', or a market snapshot. For one specific coin use getTickersById. Read-only; quotes sets the quote currencies (default USD), limit caps results. No API key required.",
  {
    quotes: z.string().optional().describe("Comma-separated quote currencies (e.g., USD,BTC,ETH)"),
    limit: z.number().optional().default(50).describe("Number of tickers to return (default: 50, max: 250)")
  },
  async ({ quotes, limit = 50 }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/tickers${qs}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 5: getCoinOHLCVLatest ───
server.tool(
  'getCoinOHLCVLatest',
  "Get the latest full-day OHLC candle (open, high, low, close and volume) for a coin. Use for 'yesterday's candle for BTC'. For the live spot price use getTickersById. Read-only; coinId must be a canonical id (resolve a bare symbol with resolveId first), quote defaults to usd. No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    quote: z.string().optional().default('usd').describe("Quote currency (default: usd)")
  },
  async ({ coinId, quote = 'usd' }) => {
    try {
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/ohlcv/latest?quote=${encodeURIComponent(quote)}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 6: getCoinOHLCVToday ───
server.tool(
  'getCoinOHLCVToday',
  "Get today's in-progress OHLC candle for a coin. Use for 'today's high and low for ETH'. For the current spot price use getTickersById; for past candles use getCoinOHLCVHistorical. Read-only; coinId is a canonical id (resolve with resolveId). No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    quote: z.string().optional().default('usd').describe("Quote currency (default: usd)")
  },
  async ({ coinId, quote = 'usd' }) => {
    try {
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/ohlcv/today?quote=${encodeURIComponent(quote)}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 7: getCoinOHLCVHistorical (paid: Starter+) ───
server.tool(
  'getCoinOHLCVHistorical',
  "Get OHLC candles (open, high, low, close, volume) for a coin. Use for 'daily chart last month', 'hourly candles since Jan 1'. For one past price use getTickersHistoricalById; for the latest candle use getCoinOHLCVLatest. Read-only. Params: coinId (required) canonical id like 'btc-bitcoin' (resolve via resolveId); start (required) and end (optional, default now) accept 'yyyy-mm-dd' or ISO 8601; interval (optional, default '24h'): one of '5m', '15m', '30m', '1h', '6h', '12h', '24h'; quote (optional, default 'usd'); limit (optional, default 50, max 250) caps candles. Requires a Starter+ plan (COINPAPRIKA_API_KEY).",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    start: z.string().describe("Start date (ISO 8601 or yyyy-mm-dd)"),
    end: z.string().optional().describe("End date (ISO 8601 or yyyy-mm-dd)"),
    limit: z.number().optional().default(50).describe("Number of data points (default: 50, max: 250)"),
    interval: z.enum(['5m', '15m', '30m', '1h', '6h', '12h', '24h']).optional().default('24h').describe("Interval (default: 24h)"),
    quote: z.string().optional().default('usd').describe("Quote currency (default: usd)")
  },
  async ({ coinId, start, end, limit = 50, interval = '24h', quote = 'usd' }) => {
    const params = new URLSearchParams({ start, limit: String(clamp(limit, 1, 250)), interval, quote });
    if (end) params.set('end', end);
    return withGuidance(
      () => fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/ohlcv/historical?${params.toString()}`),
      'Historical OHLCV requires a Starter+ plan.'
    );
  }
);

// ─── Tool 8: getCoinById ───
server.tool(
  'getCoinById',
  "Get descriptive project information about a coin: description, links, team and tags. Use for 'tell me about Uniswap', 'what is this project'. Does NOT include price; for price and market cap use getTickersById. Read-only; coinId is a canonical id (resolve with resolveId). No API key required.",
  { coinId: z.string().describe(COIN_ID_DESCRIPTION) },
  async ({ coinId }) => {
    try {
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 9: getCoinEvents ───
server.tool(
  'getCoinEvents',
  "Get the timeline of events for a coin (launches, partnerships, hard forks, conference talks) with dates and descriptions. Use for 'what is happening with X', 'upcoming events for Ethereum', 'X roadmap events'. For prices use getTickersById. Read-only; coinId is a canonical id, limit caps results. No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    limit: z.number().optional().default(50).describe("Number of events to return (default: 50, max: 250)")
  },
  async ({ coinId, limit = 50 }) => {
    try {
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/events`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 10: getCoinExchanges ───
server.tool(
  'getCoinExchanges',
  "List the exchanges that LIST a specific coin (venue names only). Use for 'which exchanges list X', 'is X on Coinbase', 'where is X listed'. For where to BUY with per-market price and volume use getCoinMarkets; for the live price use getTickersById. Read-only; coinId is a canonical id, limit caps results. No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    limit: z.number().optional().default(50).describe("Number of exchanges to return (default: 50, max: 250)")
  },
  async ({ coinId, limit = 50 }) => {
    try {
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/exchanges`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 11: getCoinMarkets ───
server.tool(
  'getCoinMarkets',
  "Get the specific markets and trading pairs where a coin trades, with per-market price and 24h volume. Use for 'where can I buy X', 'X price on Binance', 'best market for X'. For just the list of exchange names use getCoinExchanges. Read-only; coinId is a canonical id, quotes sets quote currencies, limit caps results. No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    quotes: z.string().optional().describe("Comma-separated quote currencies"),
    limit: z.number().optional().default(50).describe("Number of markets to return (default: 50, max: 250)")
  },
  async ({ coinId, quotes, limit = 50 }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/coins/${encodeURIComponent(coinId)}/markets${qs}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 12: getTickersById ───
server.tool(
  'getTickersById',
  "Get the current price, market cap, 24h change and volume of one cryptocurrency in USD or another quote currency. Use for 'what is the price of X', 'how much is Bitcoin worth', 'BTC to USD', 'ETH price now'. For past prices use getTickersHistoricalById. Read-only; coinId is a canonical id (resolve a bare symbol with resolveId first), quotes sets the quote currency (default USD). No API key required.",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    quotes: z.string().optional().describe("Comma-separated quote currencies")
  },
  async ({ coinId, quotes }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/tickers/${encodeURIComponent(coinId)}${qs}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 13: getTickersHistoricalById (paid: Starter+) ───
server.tool(
  'getTickersHistoricalById',
  "Get a coin's price, market cap and volume at past times as point-in-time snapshots (not OHLC candles). Use for 'price of BTC last Tuesday', 'ETH market cap on 2024-01-01'. For OHLC chart candles use getCoinOHLCVHistorical; for the current price use getTickersById. Read-only. Params: coinId (required) canonical id like 'btc-bitcoin' (resolve via resolveId); start (required) and end (optional, default now) accept 'yyyy-mm-dd' or ISO 8601; interval (optional, default '5m'); quote (optional, default 'usd'); limit (optional, default 50, max 250) caps points. Requires a Starter+ plan (COINPAPRIKA_API_KEY).",
  {
    coinId: z.string().describe(COIN_ID_DESCRIPTION),
    start: z.string().describe("Start date (ISO 8601 or yyyy-mm-dd)"),
    end: z.string().optional().describe("End date"),
    limit: z.number().optional().default(50).describe("Number of data points (default: 50, max: 250)"),
    quote: z.string().optional().default('usd').describe("Quote currency (default: usd)"),
    interval: z.string().optional().default('5m').describe("Interval (default: 5m)")
  },
  async ({ coinId, start, end, limit = 50, quote = 'usd', interval = '5m' }) => {
    const params = new URLSearchParams({ start, limit: String(clamp(limit, 1, 250)), quote, interval });
    if (end) params.set('end', end);
    return withGuidance(
      () => fetchFromAPI(`/tickers/${encodeURIComponent(coinId)}/historical?${params.toString()}`),
      'Historical tickers require a Starter+ plan.'
    );
  }
);

// ─── Tool 14: getPeopleById ───
server.tool(
  'getPeopleById',
  "Get the profile of one person in crypto by id: name, description or bio, teams_count, positions held, and linked projects plus social and code accounts. Use for 'who is Vitalik Buterin', 'background on Charlie Lee', 'projects tied to this founder'. Find the personId first with search or resolveId using type 'people'; this tool needs the exact id, not a name. Read-only. Params: personId (required) is a canonical person id such as 'vitalik-buterin' or 'satoshi-nakamoto'; an unknown id returns not found. No API key required.",
  { personId: z.string().describe("Person ID (e.g., vitalik-buterin)") },
  async ({ personId }) => {
    try {
      const response = await fetchFromAPI(`/people/${encodeURIComponent(personId)}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 15: getTags ───
server.tool(
  'getTags',
  "List all CoinPaprika tags (categories such as 'defi', 'stablecoin', 'memecoin', 'ai') used to group coins, returned as a list with each tag's id, name, coin_counter and ico_counter. Use for 'what crypto categories exist', 'list market sectors', or to find a tagId before calling getTagById. For the coins inside one tag use getTagById. Read-only. Params: additionalFields (optional, default none) is a comma-separated list of extra sections per tag, valid values 'coins' and 'icos' (example 'coins,icos'; omit for just summaries); limit (optional, default 50, max 250) caps how many tags return. No API key required.",
  {
    additionalFields: z.string().optional().describe("Comma-separated additional fields (e.g., coins,icos)"),
    limit: z.number().optional().default(50).describe("Number of tags to return (default: 50, max: 250)")
  },
  async ({ additionalFields, limit = 50 }) => {
    try {
      const qs = additionalFields ? `?additional_fields=${encodeURIComponent(additionalFields)}` : '';
      const response = await fetchFromAPI(`/tags${qs}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 16: getTagById ───
server.tool(
  'getTagById',
  "Get details for one CoinPaprika tag (a category such as 'defi' or 'stablecoin'): its id, name, description, coin_counter, ico_counter, and optionally the coins and ICOs grouped under it. Use for 'what coins are in the defi tag', 'show the stablecoin category', 'tokens tagged ai'. To list every tag or find a tagId first use getTags. Read-only. Params: tagId (required) is a tag id from getTags such as 'defi'; additionalFields (optional, default none) is a comma-separated list of extra sections, valid values 'coins' and 'icos' (example 'coins,icos'). An unknown tagId returns an error. No API key required.",
  {
    tagId: z.string().describe("Tag ID (e.g., blockchain-service)"),
    additionalFields: z.string().optional().describe("Comma-separated additional fields (e.g., coins,icos)")
  },
  async ({ tagId, additionalFields }) => {
    try {
      const qs = additionalFields ? `?additional_fields=${encodeURIComponent(additionalFields)}` : '';
      const response = await fetchFromAPI(`/tags/${encodeURIComponent(tagId)}${qs}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 17: getExchanges ───
server.tool(
  'getExchanges',
  "List exchanges tracked by CoinPaprika as a list ranked by rank, each with id, name, trust score, active market count and 24h volume. Use for 'top exchanges by volume', 'biggest crypto exchanges', or to find an exchangeId before calling getExchangeByID. For one exchange's full stats use getExchangeByID; for its trading pairs use getExchangeMarkets. Read-only. Params: quotes (optional, default 'usd') is a comma-separated list of quote currencies for the volume figures, for example 'usd,btc'; limit (optional, default 50, max 250) caps how many exchanges return. No API key required.",
  {
    quotes: z.string().optional().describe("Comma-separated quote currencies"),
    limit: z.number().optional().default(50).describe("Number of exchanges to return (default: 50, max: 250)")
  },
  async ({ quotes, limit = 50 }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/exchanges${qs}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 18: getExchangeByID ───
server.tool(
  'getExchangeByID',
  "Get details for a specific exchange: 24h volume, market count, trust score, links and fiat support. Use for 'tell me about Binance', 'Coinbase exchange stats', 'is X a trustworthy exchange'. For the pairs traded there use getExchangeMarkets; find the exchange id first with search or getExchanges. Read-only; exchangeId is an exchange id such as binance. No API key required.",
  {
    exchangeId: z.string().describe("Exchange ID (e.g., binance)"),
    quotes: z.string().optional().describe("Comma-separated quote currencies")
  },
  async ({ exchangeId, quotes }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/exchanges/${encodeURIComponent(exchangeId)}${qs}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 19: getExchangeMarkets ───
server.tool(
  'getExchangeMarkets',
  "List the trading pairs (markets) on one exchange as a list, each with the pair, base and quote coin ids, latest price, 24h volume and category. Use for 'what pairs trade on Binance', 'markets on Kraken', 'BTC pairs on Coinbase'. For exchange-level stats such as trust score use getExchangeByID; find the exchangeId first with getExchanges. Read-only. Params: exchangeId (required) is an exchange id such as 'binance'; quotes (optional, default 'usd') is a comma-separated list of quote currencies for the figures, e.g. 'usd,btc'; limit (optional, default 50, max 250) caps how many markets return. No API key required.",
  {
    exchangeId: z.string().describe("Exchange ID (e.g., binance)"),
    quotes: z.string().optional().describe("Comma-separated quote currencies"),
    limit: z.number().optional().default(50).describe("Number of markets to return (default: 50, max: 250)")
  },
  async ({ exchangeId, quotes, limit = 50 }) => {
    try {
      const qs = quotes ? `?quotes=${encodeURIComponent(quotes)}` : '';
      const response = await fetchFromAPI(`/exchanges/${encodeURIComponent(exchangeId)}/markets${qs}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 20: getPlatforms ───
server.tool(
  'getPlatforms',
  "List the smart-contract platforms (blockchains such as ethereum, bnb, polygon) for which CoinPaprika indexes token contracts. Use for 'which chains are supported for contract lookups', 'list contract platforms', or to pick a platform id before calling getContracts. Read-only; limit caps results. No API key required.",
  { limit: z.number().optional().default(50).describe("Number of platforms to return (default: 50, max: 250)") },
  async ({ limit = 50 }) => {
    try {
      const response = await fetchFromAPI('/contracts');
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 21: getContracts ───
server.tool(
  'getContracts',
  "List the token contract addresses tracked on one platform as a list, mapping each contract to its CoinPaprika coin id. Use for 'contracts on ethereum', 'what tokens does BSC have', or to map a contract address to a coin id. Find the platformId first with getPlatforms; for one contract's live price use getTickerByContract, and for its history use getHistoricalTickerByContract. Read-only. Params: platformId (required) is a platform id such as 'eth-ethereum' or 'bsc-binance-smart-chain'; limit (optional, default 50, max 250) caps how many contracts return. An unknown platformId returns an error. No API key required.",
  {
    platformId: z.string().describe("Platform ID (e.g., eth-ethereum)"),
    limit: z.number().optional().default(50).describe("Number of contracts to return (default: 50, max: 250)")
  },
  async ({ platformId, limit = 50 }) => {
    try {
      const response = await fetchFromAPI(`/contracts/${encodeURIComponent(platformId)}`);
      if (Array.isArray(response.data)) {
        response.data = response.data.slice(0, clamp(limit, 1, 250));
      }
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 22: getTickerByContract ───
server.tool(
  'getTickerByContract',
  "Get the current price and market data of a token by its contract address (for on-chain and DeFi tokens). Use when you have a contract address (0x...) rather than a name. For history use getHistoricalTickerByContract. Read-only; platformId is the chain (e.g. eth-ethereum) and contractAddress the token address. No API key required.",
  {
    platformId: z.string().describe("Platform ID (e.g., eth-ethereum)"),
    contractAddress: z.string().describe("Contract address")
  },
  async ({ platformId, contractAddress }) => {
    try {
      const response = await fetchFromAPI(`/contracts/${encodeURIComponent(platformId)}/${encodeURIComponent(contractAddress)}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 23: getHistoricalTickerByContract (paid: Starter+) ───
server.tool(
  'getHistoricalTickerByContract',
  "Get a token's price and market history by its contract address, as a time series. Use for 'token price on 2024-01-01 by address', 'hourly history for a contract'. For its current price use getTickerByContract; by coin id use getTickersHistoricalById. Read-only. Params: platformId (required) chain id like 'eth-ethereum'; contractAddress (required) token address; start (required) and end (optional, default now) accept 'yyyy-mm-dd' or ISO 8601; interval (optional, default '5m'); quote (optional, default 'usd'); limit (optional, default 50, max 250) caps points. Requires a Starter+ plan (COINPAPRIKA_API_KEY).",
  {
    platformId: z.string().describe("Platform ID (e.g., eth-ethereum)"),
    contractAddress: z.string().describe("Contract address"),
    start: z.string().describe("Start date (ISO 8601 or yyyy-mm-dd)"),
    end: z.string().optional().describe("End date"),
    limit: z.number().optional().default(50).describe("Number of data points (default: 50, max: 250)"),
    quote: z.string().optional().default('usd').describe("Quote currency (default: usd)"),
    interval: z.string().optional().default('5m').describe("Interval (default: 5m)")
  },
  async ({ platformId, contractAddress, start, end, limit = 50, quote = 'usd', interval = '5m' }) => {
    const params = new URLSearchParams({ start, limit: String(clamp(limit, 1, 250)), quote, interval });
    if (end) params.set('end', end);
    return withGuidance(
      () => fetchFromAPI(`/contracts/${encodeURIComponent(platformId)}/${encodeURIComponent(contractAddress)}/historical?${params.toString()}`),
      'Historical contract tickers require a Starter+ plan.'
    );
  }
);

// ─── Tool 24: search ───
server.tool(
  'search',
  "Broadly search CoinPaprika across coins, exchanges, ICOs, people and tags by name or symbol when the entity type is unknown or you are exploring. Use for 'find anything called X'. If you specifically need a coin's canonical id to fetch its price, prefer resolveId. Read-only; q is the query, categories filters entity types, limit caps results. No API key required.",
  {
    q: z.string().describe("Search query"),
    categories: z.string().optional().describe("Comma-separated categories to search (e.g., currencies,exchanges,icos,people,tags)"),
    modifier: z.string().optional().describe("Search modifier"),
    limit: z.number().optional().default(50).describe("Number of results per category (default: 50, max: 250)")
  },
  async ({ q, categories, modifier, limit = 50 }) => {
    try {
      const params = new URLSearchParams({ q });
      if (categories) params.set('c', categories);
      if (modifier) params.set('modifier', modifier);
      params.set('limit', String(clamp(limit, 1, 250)));
      const response = await fetchFromAPI(`/search?${params.toString()}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 25: resolveId ───
server.tool(
  'resolveId',
  "Resolve a fuzzy coin, exchange, person or tag name or symbol to a ranked list of candidate CoinPaprika ids, best first (take the top one). Call FIRST when you have a bare name or symbol but need an id, since ids are not derivable, then pass the id to getTickersById for price. Returns candidates with id, name, symbol, type and rank; an empty list means no match. Read-only. Params: type (required; one of 'coin', 'exchange', 'people', 'tags') sets entity kind; query (required) is the fuzzy text; limit (optional, default 50, max 250) caps candidates. Answers 'id for AAVE', 'resolve Vitalik'. No API key required.",
  {
    type: z.enum(['coin', 'exchange', 'people', 'tags']).describe("Resource type to resolve"),
    query: z.string().describe("Fuzzy search query"),
    limit: z.number().optional().default(50).describe("Number of results (default: 50, max: 250)")
  },
  async ({ type, query, limit = 50 }) => {
    try {
      const categoryMap = { coin: 'currencies', exchange: 'exchanges', people: 'people', tags: 'tags' };
      const c = categoryMap[type] || 'currencies';
      const response = await fetchFromAPI(`/search?${new URLSearchParams({ q: query, c }).toString()}`);
      const key = type === 'coin' ? 'currencies' : type;
      const arr = response.data?.[key] || [];
      response.data = Array.isArray(arr) ? arr.slice(0, clamp(limit, 1, 250)) : arr;
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 26: priceConverter ───
server.tool(
  'priceConverter',
  "Convert an amount from one crypto or fiat to another at the current rate, e.g. 'how much is 0.5 BTC in USD', 'convert 100 USDC to EUR'. For a plain coin price without an amount, use getTickersById. Read-only; baseCurrencyId and quoteCurrencyId are canonical ids and amount is the quantity to convert. No API key required.",
  {
    baseCurrencyId: z.string().describe("Required. Source CoinPaprika coin slug (e.g., 'btc-bitcoin'). Full slugs only; ticker symbols like 'BTC' are rejected upstream. Call search or resolveId first."),
    quoteCurrencyId: z.string().describe("Required. Target CoinPaprika coin slug (e.g., 'usd-us-dollars', 'eth-ethereum'). Full slugs only; ticker symbols like 'USD' are rejected upstream."),
    amount: z.number().optional().default(0).describe("Amount to convert (default: 0)")
  },
  async ({ baseCurrencyId, quoteCurrencyId, amount = 0 }) => {
    try {
      const params = new URLSearchParams({
        base_currency_id: baseCurrencyId,
        quote_currency_id: quoteCurrencyId,
        amount: String(amount)
      });
      const response = await fetchFromAPI(`/price-converter?${params.toString()}`);
      return formatMcpResponse(response);
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// ─── Tool 27: keyInfo (paid: Pro) ───
server.tool(
  'keyInfo',
  "Get details and usage for the current CoinPaprika API key: plan, quota, requests remaining and expiry. Use for 'what plan am I on', 'how many requests are left', 'is my API key valid'. Read-only; takes no parameters. Requires a configured COINPAPRIKA_API_KEY (Pro plan); without a key the call is rejected.",
  {},
  async () => {
    if (!API_KEY) {
      return formatMcpResponse({
        message: 'No API key configured. Set COINPAPRIKA_API_KEY environment variable.',
        pricing: 'https://coinpaprika.com/api/pricing/'
      });
    }
    return withGuidance(
      () => fetchFromAPI('/key/info'),
      'keyInfo requires a Pro plan API key.'
    );
  }
);

// ─── Tool 28: getMappings (paid: Business) ───
server.tool(
  'getMappings',
  "Cross-reference CoinPaprika ids with external or legacy identifiers. Returns crosswalk rows linking a CoinPaprika id to its external ids; only matching rows return and no match returns an empty list. Use for 'map CoinPaprika id to CoinGecko', 'which coin is this CoinMarketCap id', 'find id for an ISIN'. Read-only. All params are optional string filters; provide at least one, extra filters narrow further: coinpaprika (a CoinPaprika id), coinmarketcap, coingecko, cryptocompare (each that provider's id), isin (an ISIN code), dti (a Digital Token Identifier). Requires a Business plan (COINPAPRIKA_API_KEY).",
  {
    coinpaprika: z.string().optional().describe("CoinPaprika ID to look up"),
    coinmarketcap: z.string().optional().describe("CoinMarketCap ID to look up"),
    coingecko: z.string().optional().describe("CoinGecko ID to look up"),
    cryptocompare: z.string().optional().describe("CryptoCompare ID to look up"),
    isin: z.string().optional().describe("ISIN to look up"),
    dti: z.string().optional().describe("DTI to look up")
  },
  async (params) => {
    const qs = new URLSearchParams();
    // Allowlist the upstream-recognized mapping params only, never forward
    // MCP-only or unexpected fields, which the upstream rejects with a 400.
    for (const k of ['coinpaprika', 'coinmarketcap', 'coingecko', 'cryptocompare', 'isin', 'dti']) {
      const v = params[k];
      if (v) qs.set(k, String(v));
    }
    return withGuidance(
      () => fetchFromAPI(`/coins/mappings?${qs.toString()}`),
      'getMappings requires a Business plan.'
    );
  }
);

// ─── Tool 29: getChangelogIDs (paid: Starter+) ───
server.tool(
  'getChangelogIDs',
  "List ids of recent changes to CoinPaprika's coin and exchange listings (additions, renames, delistings) as a paginated feed, newest first, so you can sync or reconcile a local dataset. Returns change records, each with the affected id and change type; an empty page means no more changes. Use for 'what listings changed recently', 'new or delisted coins', 'listing changelog'. For the current full coin list use getCoins instead. Read-only. Params: page (optional, default 1) selects the page; limit (optional, default 50) sets records per page. Requires a Starter+ plan (COINPAPRIKA_API_KEY).",
  {
    page: z.number().optional().default(1).describe("Page number (default: 1)"),
    limit: z.number().optional().default(50).describe("Number of results per page (default: 50)")
  },
  async ({ page = 1, limit = 50 }) => {
    return withGuidance(
      () => fetchFromAPI(`/changelog/ids?page=${page}`),
      'getChangelogIDs requires a Starter+ plan.'
    );
  }
);

// ─── Tool 30: getCapabilities ───
server.tool(
  'getCapabilities',
  "Get the server's capabilities, supported workflow patterns, validation rules and recommended tool sequences. Use FIRST to onboard as an agent, or when asked 'what can this server do', 'how should I chain these tools', 'what are the parameter rules'. This describes the MCP server itself, not crypto data.",
  {},
  async () => {
    try {
      const doc = buildCapabilitiesDocument();
      return { content: [{ type: "text", text: JSON.stringify(doc, null, 2) }] };
    } catch (error) {
      return formatMcpError(error);
    }
  }
);

// Start the server
async function main() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`CoinPaprika MCP server v${SERVER_VERSION} is running...`);
    if (API_KEY) {
      console.error('API key configured, paid-tier endpoints available.');
    } else {
      console.error('No API key configured, running in free-tier mode. Set COINPAPRIKA_API_KEY for paid features.');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
