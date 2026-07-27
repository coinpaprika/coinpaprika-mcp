# Changelog

All notable changes to the CoinPaprika MCP Server will be documented in this file.

## [1.3.0] - 2026-07-27

### Changed

- **Intent-first tool descriptions.** Every tool description was rewritten so agents select the right tool from the description alone, each leading with what the tool returns plus `Use when asked '...'` cues (e.g. `getTickers` vs `getCoinById` vs `getContracts`). Matches the descriptions now served by the hosted worker at `mcp.coinpaprika.com`, so hosted and self-host read identically.
- `getCapabilities` description aligned with the hosted worker (onboarding-first wording; clarifies it describes the MCP server itself, not crypto data).

### Added

- `server.json` manifest for publication to the official MCP Registry (`registry.modelcontextprotocol.io`).

## [1.1.1] - 2026-05-05

### Fixed
- **Authorization header format** — now sends `Authorization: <key>` (bare) instead of `Authorization: Bearer <key>`. The `Bearer` prefix was rejected by the api-pro Cloudflare WAF with HTTP 403, which silently broke every authenticated request from this MCP server.
- **Base URL routing** — when `COINPAPRIKA_API_KEY` is set, requests now route through `https://api-pro.coinpaprika.com/v1` instead of the free base. Six paid-tier tools (`getCoinOHLCVHistorical`, `getTickersHistoricalById`, `getHistoricalTickerByContract`, `getMappings`, `getChangelogIDs`, `keyInfo`) were unreachable in 1.1.0 because the free base rejected them with HTTP 402.

Combined, these two bugs meant that `@coinpaprika/mcp@1.1.0` could not authenticate against the paid API at all. Upgrading to `1.1.1` is required for any user with a `COINPAPRIKA_API_KEY` set.

## [1.1.0] - 2026-04-02

### Added
- Dockerfile for containerized deployment
- Smoke test suite (`npm test`) verifying server initialization, tool listing, and live API calls
- Test script for CI/CD integration

### Changed
- Bumped version to 1.1.0
- Updated HOSTED-MCP-SPEC.md to reflect hosted/self-hosted tool parity

### Fixed
- Hosted MCP server at mcp.coinpaprika.com now exposes `getCapabilities` tool (was missing, only available in self-hosted). Both versions now have 30 identical tools.

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
