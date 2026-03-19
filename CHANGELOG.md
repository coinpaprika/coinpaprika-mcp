# Changelog

All notable changes to the CoinPaprika MCP Server will be documented in this file.

## [1.0.0] - 2026-03-19

### Added

- Initial release with 30 CoinPaprika MCP tools
- **Discovery & System**: `status`, `getGlobal`, `getCapabilities`
- **Coins**: `getCoins`, `getCoinById`, `getCoinEvents`, `getCoinExchanges`, `getCoinMarkets`
- **Tickers & Prices**: `getTickers`, `getTickersById`, `getCoinOHLCVLatest`, `getCoinOHLCVToday`, `priceConverter`
- **Exchanges**: `getExchanges`, `getExchangeByID`, `getExchangeMarkets`
- **Tags & People**: `getTags`, `getTagById`, `getPeopleById`
- **Contracts**: `getPlatforms`, `getContracts`, `getTickerByContract`
- **Search**: `search`, `resolveId`
- **Paid-tier**: `getCoinOHLCVHistorical`, `getTickersHistoricalById`, `getHistoricalTickerByContract`, `getChangelogIDs`, `keyInfo`, `getMappings`
- Structured error handling with error codes (`CP400_*`, `CP402_*`, `CP403_*`, `CP404_*`, `CP429_*`, `CP500_*`)
- Response metadata with rate limit info, response time, and timestamps
- Optional API key support via `COINPAPRIKA_API_KEY` environment variable for paid-tier features
- `getCapabilities` tool with workflow patterns, validation rules, and best practices
- Hosted MCP alternative documentation at [mcp.coinpaprika.com](https://mcp.coinpaprika.com)

### Notes

- Matches the hosted MCP server at `mcp.coinpaprika.com` — same tools, same schemas, same error handling
- Free-tier endpoints work without any API key
- Paid-tier endpoints require `COINPAPRIKA_API_KEY` to be set
- All responses include rate limit metadata
