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
  "or guess the slug — it is not derivable from the symbol (e.g. AAVE resolves " +
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
    const resetTime = new Date();
    resetTime.setUTCHours(24, 0, 0, 0);
    return buildErrorResponse(
      ErrorCodes.CP429_RATE_LIMIT,
      'Daily rate limit of 10,000 requests exceeded',
      true,
      'Wait until rate limit resets or use cached data',
      undefined,
      {
        limit: 10000,
        reset_at: resetTime.toISOString(),
        retry_after_seconds: Math.floor((resetTime.getTime() - Date.now()) / 1000)
      }
    );
  }

  if (status === 404) {
    return buildErrorResponse(
      ErrorCodes.CP404_NOT_FOUND,
      'Resource not found',
      false,
      'No resource with that id exists — it may be misspelled, retired, or for a different entity. Call search or resolveId to get the current canonical id, then retry.',
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

// Rate limit tracking
let requestCount = 0;
const RATE_LIMIT = 10000;

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

  const resetTime = new Date();
  resetTime.setUTCHours(24, 0, 0, 0);

  return {
    data,
    meta: {
      rate_limit: {
        limit: RATE_LIMIT,
        remaining: RATE_LIMIT - requestCount,
        used: requestCount,
        percentage_used: Math.round((requestCount / RATE_LIMIT) * 10000) / 100,
        reset_at: resetTime.toISOString()
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
    description: "Cryptocurrency market data for 8000+ coins",
    server: {
      name: "CoinPaprika MCP Server",
      version: SERVER_VERSION,
      description: "Cryptocurrency market data — prices, tickers, exchanges, OHLCV, and more",
      documentation_url: "https://api.coinpaprika.com",
    },
    tools: [
      {
        name: "status",
        description: "Server status and configuration",
        category: "system",
        parameters: {},
        returns: { type: "object" },
        cost: 0
      },
      {
        name: "getGlobal",
        description: "Get global cryptocurrency market statistics",
        category: "market",
        parameters: {},
        returns: { type: "object", properties: ["market_cap_usd", "volume_24h_usd", "bitcoin_dominance_percentage"] },
        cost: 1
      },
      {
        name: "getCoins",
        description: "List all available coins",
        category: "coins",
        parameters: { limit: { type: "integer", required: false, default: 50, min: 1, max: 250 } },
        returns: { type: "array", items: "Coin" },
        cost: 1
      },
      {
        name: "getTickers",
        description: "Get market data for all active cryptocurrencies",
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
        description: "Get OHLCV data for last full day",
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
        description: "Get OHLCV data for today",
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
        description: "Get historical OHLCV data (requires Starter+ plan)",
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
        description: "Get detailed information about a specific cryptocurrency",
        category: "coins",
        parameters: { coinId: { type: "string", required: true, format: "coin-id", example: "btc-bitcoin" } },
        returns: { type: "object", properties: ["id", "name", "symbol", "description", "links", "rank"] },
        cost: 1
      },
      {
        name: "getCoinEvents",
        description: "Get events for a specific coin",
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
        description: "Get exchanges where a coin is traded",
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
        description: "Get markets for a specific coin",
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
        description: "Get ticker data for a specific coin",
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
        description: "Get historical ticker data (requires Starter+ plan)",
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
        description: "Get information about a person in crypto space",
        category: "people",
        parameters: { personId: { type: "string", required: true } },
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getTags",
        description: "Get list of all tags",
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
        description: "Get details about a specific tag",
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
        description: "Get list of all exchanges",
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
        description: "Get details about a specific exchange",
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
        description: "Get markets on a specific exchange",
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
        description: "Get list of contract platforms",
        category: "contracts",
        parameters: { limit: { type: "integer", required: false, default: 50 } },
        returns: { type: "array", items: "Platform" },
        cost: 1
      },
      {
        name: "getContracts",
        description: "Get contracts for a specific platform",
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
        description: "Get ticker by contract address",
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
        description: "Get historical ticker by contract address (requires Starter+ plan)",
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
        description: "Search for currencies, exchanges, ICOs, people, and tags",
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
        description: "Resolve fuzzy query to canonical coin/exchange/people/tag IDs",
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
        description: "Convert amount from base currency to quote currency",
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
        description: "Verify API key (requires Pro plan)",
        category: "system",
        parameters: {},
        returns: { type: "object" },
        cost: 1
      },
      {
        name: "getMappings",
        description: "Get API ID mappings (requires Business plan)",
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
        description: "Get changelog IDs (requires Starter+ plan)",
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
      requests_per_day: 10000,
      burst_limit: 100
    },

    error_codes: {
      CP400_INVALID_COIN_ID: "Coin ID format invalid. Use format: symbol-name (e.g., btc-bitcoin)",
      CP400_MISSING_REQUIRED: "Required parameter is missing",
      CP400_BAD_REQUEST: "Invalid request parameters",
      CP402_INSUFFICIENT_PLAN: "This endpoint requires a paid plan",
      CP403_FORBIDDEN: "Access forbidden — check API key or plan",
      CP404_NOT_FOUND: "Resource not found. Use search to find correct IDs",
      CP429_RATE_LIMIT: "Daily rate limit exceeded. Resets at midnight UTC",
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
          "getTickerByContract - Get ticker by contract address",
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
        "Handle 402/403 errors gracefully — they indicate paid-plan requirements",
        "Retry with backoff for 429 rate limit errors",
        "Use resolveId to find correct IDs when 404 errors occur",
      ],
    },

    meta: {
      documentation: "https://api.coinpaprika.com",
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
// handler — so a ticker symbol like "BTC" gets actionable guidance to call
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
  'Server status and configuration',
  {},
  async () => {
    const statusData = {
      server: 'CoinPaprika MCP Server',
      version: SERVER_VERSION,
      api_base_url: API_BASE_URL,
      api_key_configured: !!API_KEY,
      mode: API_KEY ? 'authenticated' : 'free-tier',
      paid_features: API_KEY
        ? 'API key configured — paid-tier endpoints available'
        : 'No API key configured. For Pro/Business features, set COINPAPRIKA_API_KEY environment variable. Get a key at https://coinpaprika.com/api/pricing/',
    };
    return formatMcpResponse(statusData);
  }
);

// ─── Tool 2: getGlobal ───
server.tool(
  'getGlobal',
  'Market overview',
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
  'List coins (limit, mode)',
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
  'All tickers (quotes, limit)',
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
  'OHLCV last full day',
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
  'OHLCV today',
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
  'OHLCV historical (plan-dependent)',
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
  'Coin details (descriptive info)',
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
  'Events for a coin',
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
  'Exchanges for a coin',
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
  'Markets for a coin',
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
  'Ticker for a specific coin',
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
  'Historical ticks for a coin (plan dependent)',
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
  'Person details',
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
  'List tags',
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
  'Tag details',
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
  'List exchanges',
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
  'Exchange details',
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
  'Markets on exchange',
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
  'List contract platforms',
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
  'Contracts for a platform',
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
  'Ticker by contract address (redirect)',
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
  'Historical by contract address (plan dependent)',
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
  'Search currencies, exchanges, icos, people, tags',
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
  'Resolve fuzzy query to canonical ids',
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
  'Convert base -> quote',
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
  'Verify API key (Pro)',
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
  'API ID mappings (Business)',
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
    // Allowlist the upstream-recognized mapping params only — never forward
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
  'Changelog IDs (Starter+)',
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
  'Return server capabilities, workflow patterns, validation rules, and best-practice sequences. Use this to onboard agents quickly.',
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
      console.error('API key configured — paid-tier endpoints available.');
    } else {
      console.error('No API key configured — running in free-tier mode. Set COINPAPRIKA_API_KEY for paid features.');
    }
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
