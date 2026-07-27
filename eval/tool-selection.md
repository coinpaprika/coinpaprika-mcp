# Tool-selection eval

The point of these descriptions is that a model picks the right tool from
the name + description alone. This is the regression guard: for each query,
the model should select the expected tool. Run against the built MCP and
confirm selection; iterate descriptions until it holds. Keep PL + EN, since
descriptions are matched regardless of the user's language.

| Query (EN / PL) | Expected tool |
|---|---|
| "what is the price of bitcoin" / "cena bitcoina" | getTickersById |
| "how much is ETH worth" / "ile kosztuje ethereum" | getTickersById |
| "BTC to USD right now" | getTickersById |
| "top 5 crypto by market cap" / "top 5 kryptowalut" | getTickers |
| "biggest cryptocurrencies today" / "największe kryptowaluty" | getTickers |
| "how is the crypto market doing" / "jak radzi sobie rynek" | getGlobal |
| "total crypto market cap" / "całkowita kapitalizacja" | getGlobal |
| "BTC dominance" | getGlobal |
| "bitcoin price on 2024-01-01" / "cena BTC rok temu" | getTickersHistoricalById |
| "price chart for ETH last month" | getCoinOHLCVHistorical |
| "where can I buy PEPE" / "gdzie kupić X" | getCoinMarkets |
| "price of token 0xC02aaA...756Cc2" | getTickerByContract |
| "convert 0.5 BTC to USD" / "przelicz 0.5 BTC na USD" | priceConverter |
| "tell me about the Cardano project" | getCoinById |
| "resolve AAVE to its id" | resolveId / search |

Anti-goals (must NOT be selected for a current-price query): getTickersHistoricalById, getCoinOHLCV* (those are historical/candles), getCoinById (no price).
