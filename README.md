# CoinPaprika MCP Server

[![smithery badge](https://smithery.ai/badge/coinpaprika/coinpaprika)](https://smithery.ai/servers/coinpaprika/coinpaprika)

A Model Context Protocol (MCP) server that provides on-demand access to CoinPaprika's cryptocurrency market data API. Built specifically for AI assistants like Claude to programmatically fetch real-time prices, tickers, exchange data, OHLCV candles, and more with zero configuration.

## TL;DR

```bash
# Install globally
npm install -g @coinpaprika/mcp

# Start the server
coinpaprika-mcp

# Or run directly without installation
npx @coinpaprika/mcp@latest
```

CoinPaprika MCP connects Claude to live crypto market data for 8,000+ coins. No API key required for free-tier features. [Installation](#installation) | [Configuration](#claude-desktop-integration) | [API Reference](https://api.coinpaprika.com)

> **Prefer zero setup?** Use the hosted MCP server at [mcp.coinpaprika.com](https://mcp.coinpaprika.com) — no installation, no API key, same 30 tools. See [Hosted Alternative](#hosted-alternative-no-installation) for transport endpoints.

## What Can You Build?

- **Market Dashboards**: Real-time market overview with global stats, top coins, and volume trends
- **Coin Analysis Tools**: Deep-dive into any cryptocurrency — price, team, events, exchanges, and markets
- **Price Trackers**: Track prices across multiple quote currencies with historical OHLCV data
- **Exchange Comparisons**: Compare trading pairs and volumes across 200+ exchanges
- **Portfolio Valuations**: Convert an amount between currencies ('0.5 BTC in USD') and track price changes over time
- **Contract Lookup**: Find tokens by their smart contract address across multiple platforms

## Installation

### Installing via Smithery

To install CoinPaprika MCP for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@coinpaprika/coinpaprika-mcp):

```bash
npx -y @smithery/cli install @coinpaprika/coinpaprika-mcp --client claude
```

### Manual Installation
```bash
# Install globally (recommended for regular use)
npm install -g @coinpaprika/mcp

# Start the server
coinpaprika-mcp
```

## Claude Desktop Integration

Add the following to your Claude Desktop configuration file:

**macOS**: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "coinpaprika": {
      "command": "npx",
      "args": ["@coinpaprika/mcp@latest"]
    }
  }
}
```

### With API Key (for paid-tier features)

```json
{
  "mcpServers": {
    "coinpaprika": {
      "command": "npx",
      "args": ["@coinpaprika/mcp@latest"],
      "env": {
        "COINPAPRIKA_API_KEY": "your-api-key-here"
      }
    }
  }
}
```

### Claude Code Integration

```bash
# Add as MCP server in Claude Code
claude mcp add coinpaprika -- npx @coinpaprika/mcp@latest

# With API key
COINPAPRIKA_API_KEY=your-key claude mcp add coinpaprika -- npx @coinpaprika/mcp@latest
```

### Hosted Alternative (No Installation)

If you prefer zero setup, point any MCP-compatible client directly at the hosted server at [mcp.coinpaprika.com](https://mcp.coinpaprika.com). The landing page provides setup instructions and documentation. The following transport endpoints are available:

| Transport | Endpoint | Use Case |
|-----------|----------|----------|
| Streamable HTTP | `https://mcp.coinpaprika.com/streamable-http` | Recommended for most clients |
| SSE | `https://mcp.coinpaprika.com/sse` | Legacy SSE transport |
| JSON-RPC | `https://mcp.coinpaprika.com/json-rpc` | Direct JSON-RPC |

> **Note**: These are MCP protocol endpoints — they won't display anything in a browser. Visit [mcp.coinpaprika.com](https://mcp.coinpaprika.com) for the landing page.

```json
{
  "mcpServers": {
    "coinpaprika": {
      "type": "streamable-http",
      "url": "https://mcp.coinpaprika.com/streamable-http"
    }
  }
}
```

## Available Tools (30)

### Discovery & System

| Tool | Description |
|------|-------------|
| `getCapabilities` | Server capabilities, workflow patterns, validation rules, and best practices. **Start here.** |
| `status` | Server status and configuration |
| `getGlobal` | Global market overview: total market cap, 24h volume, BTC dominance ('how is the market doing') |

### Coins

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getCoins` | List all coins (id, name, symbol, rank); no prices, use getTickers for prices | — |
| `getCoinById` | Coin project details (description, team, links); no price, use getTickersById | `coinId` |
| `getCoinEvents` | Upcoming events for a coin | `coinId` |
| `getCoinExchanges` | Exchanges listing a coin | `coinId` |
| `getCoinMarkets` | Markets/exchanges trading a coin ('where to buy X', 'X price on Binance') | `coinId` |

### Tickers & Prices

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getTickers` | Current prices + market caps for top coins by market cap ('top 5 coins', market snapshot) | — |
| `getTickersById` | Current price, market cap & 24h change of one coin ('BTC price', 'how much is ETH') | `coinId` |
| `getCoinOHLCVLatest` | Latest full-day OHLC candle (not the live price) | `coinId` |
| `getCoinOHLCVToday` | Today's in-progress OHLC candle | `coinId` |
| `priceConverter` | Convert an amount between currencies ('0.5 BTC in USD') | `baseCurrencyId`, `quoteCurrencyId` |

### Exchanges

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getExchanges` | List all exchanges | — |
| `getExchangeByID` | Exchange details | `exchangeId` |
| `getExchangeMarkets` | Markets on a specific exchange | `exchangeId` |

### Tags & People

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getTags` | List all tags/categories | — |
| `getTagById` | Tag details | `tagId` |
| `getPeopleById` | Person/team member details | `personId` |

### Contracts

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `getPlatforms` | List contract platforms | — |
| `getContracts` | Contracts on a platform | `platformId` |
| `getTickerByContract` | Token price by contract address (on-chain/DeFi tokens) | `platformId`, `contractAddress` |

### Search & Resolution

| Tool | Description | Required Parameters |
|------|-------------|---------------------|
| `search` | Search coins/exchanges/people/tags by name; use FIRST to get an id | `q` |
| `resolveId` | Resolve a name/symbol to canonical id; call FIRST before price tools | `type`, `query` |

### Paid-Tier Tools

These tools require a paid CoinPaprika API plan. Without an API key, they return guidance directing you to upgrade.

| Tool | Plan Required | Description |
|------|---------------|-------------|
| `getCoinOHLCVHistorical` | Starter+ | Historical OHLCV candle data |
| `getTickersHistoricalById` | Starter+ | Historical ticker snapshots |
| `getHistoricalTickerByContract` | Starter+ | Historical ticker by contract |
| `getChangelogIDs` | Starter+ | Changelog of coin ID changes |
| `keyInfo` | Pro | Verify API key details |
| `getMappings` | Business | Cross-platform ID mappings |

## API Key Configuration

The free tier provides access to most tools without any API key. For paid-tier features (historical data, mappings, etc.), set the `COINPAPRIKA_API_KEY` environment variable:

```bash
# Set via environment variable
export COINPAPRIKA_API_KEY=your-api-key-here
coinpaprika-mcp

# Or pass inline
COINPAPRIKA_API_KEY=your-api-key-here npx @coinpaprika/mcp@latest
```

Get an API key at [coinpaprika.com/api/pricing](https://coinpaprika.com/api/pricing/).

### Example Usage

```javascript
// Start by getting capabilities for workflow guidance:
const caps = await getCapabilities();

// Get global market overview:
const global = await getGlobal();

// Find a coin by name:
const results = await search({ q: "ethereum" });

// Get detailed coin info:
const bitcoin = await getCoinById({ coinId: "btc-bitcoin" });

// Get current ticker with USD and BTC quotes:
const ticker = await getTickersById({ coinId: "eth-ethereum", quotes: "USD,BTC" });

// Get OHLCV data for today:
const ohlcv = await getCoinOHLCVToday({ coinId: "btc-bitcoin" });

// Convert 1 BTC to USD:
const conversion = await priceConverter({
  baseCurrencyId: "btc-bitcoin",
  quoteCurrencyId: "usd-us-dollars",
  amount: 1
});

// List top 10 exchanges:
const exchanges = await getExchanges({ limit: 10 });

// Resolve fuzzy query to exact coin ID:
const resolved = await resolveId({ type: "coin", query: "cardano" });
```

## Sample Prompts for Claude

- "What's the current price of Bitcoin and Ethereum? Show me 24h change."
- "Give me a comprehensive analysis of Cardano — price, team, events, and top exchanges."
- "Compare the top 5 crypto exchanges by trading volume."
- "Convert 10 ETH to USD and show the current exchange rate."
- "Find all coins tagged as 'defi' and show their market caps."
- "What exchanges list Solana and what trading pairs are available?"
- "Show me the OHLCV data for Bitcoin today."
- "Search for all coins related to 'layer-2' and rank them by market cap."
- "Look up the team behind Ethereum — who are the key people?"
- "Get the ticker for USDT by its Ethereum contract address."

## Rate Limits & Performance

- **Free Tier Limits**: 10,000 requests per day
- **Response Time**: 100-500ms for most endpoints
- **Data Coverage**: 8,000+ coins, 200+ exchanges
- **Error Handling**: Structured errors with codes, suggestions, and retry guidance
- **Rate Limit Info**: Every response includes rate limit metadata

## Troubleshooting

**Common Issues:**

- **Rate limiting**: If receiving `CP429_RATE_LIMIT` errors, wait for daily reset at midnight UTC
- **Invalid coin ID**: Coin IDs use `symbol-name` format (e.g., `btc-bitcoin`, not `bitcoin` or `BTC`). Use `search` or `resolveId` to find correct IDs
- **Paid-tier errors**: `CP402_INSUFFICIENT_PLAN` or `CP403_FORBIDDEN` mean the endpoint requires a paid plan. Set `COINPAPRIKA_API_KEY` environment variable
- **Timeout errors**: Large data requests may take longer — reduce the `limit` parameter
- **Network errors**: Check network connectivity, the service requires internet access

## Development

```bash
# Clone the repository
git clone https://github.com/coinpaprika/coinpaprika-mcp.git
cd coinpaprika-mcp

# Install dependencies
npm install

# Run in development
npm start

# Build for production
npm run build
```

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release notes.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Additional Resources

- [CoinPaprika API Documentation](https://api.coinpaprika.com)
- [API Pricing & Plans](https://coinpaprika.com/api/pricing/)
- [Hosted MCP Server](https://mcp.coinpaprika.com) — Zero-setup alternative
- [DexPaprika MCP](https://www.npmjs.com/package/dexpaprika-mcp) — DEX & DeFi data companion package
- [Model Context Protocol Specification](https://modelcontextprotocol.io)
- [CoinPaprika](https://coinpaprika.com) — Comprehensive cryptocurrency market data
- [DexPaprika](https://dexpaprika.com) — Onchain DEX analytics
