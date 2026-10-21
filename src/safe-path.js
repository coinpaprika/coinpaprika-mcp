// Ids reach the upstream path through encodeURIComponent, which encodes "/", "?" and "#" but
// leaves "." and "..". An id of ".." would make the request, with your API key on it, go to a
// different path than the tool intended, because URL parsing resolves dot segments. And a
// character that URL parsing leaves alone can still mean "." or "/" to a server that strips
// ";" parameters, trims whitespace or folds Unicode before routing. So ids are checked against
// the characters real ids use (an allowlist, not a list of bad characters), every path segment
// is checked against the same alphabet, and a URL whose path changes when parsed is refused.

// Exchange, tag, person and platform ids: "binance", "defi", "vitalik-buterin", "eth-ethereum".
export const SLUG_ID = /^[a-z0-9-]+$/;
// Contract addresses: EVM 0x hex, Solana base58, Sui and Aptos type tags ("0x2::sui::SUI"),
// dotted forms such as NEAR or Hedera ids, TON base64url. Never only dots.
export const CONTRACT_ADDRESS = /^(?!\.+$)[A-Za-z0-9._~:-]+$/;
// Any path segment once decoded: the union of the id alphabets and the fixed route words.
const SEGMENT = CONTRACT_ADDRESS;

// The routes the tools call, relative to the base URL. "S" is one segment.
const S = '[^/]+';
const ROUTES = [
  '/global', '/coins', '/tickers', '/tags', '/exchanges', '/contracts', '/search', '/price-converter',
  '/key/info', '/changelog/ids',
  `/coins/${S}`, `/coins/${S}/(events|exchanges|markets)`, `/coins/${S}/ohlcv/(latest|today|historical)`,
  `/tickers/${S}`, `/tickers/${S}/historical`,
  `/people/${S}`, `/tags/${S}`, `/exchanges/${S}`, `/exchanges/${S}/markets`,
  `/contracts/${S}`, `/contracts/${S}/${S}`, `/contracts/${S}/${S}/historical`,
].map((r) => new RegExp(`^${r}$`));

export function assertPathUnchanged(url) {
  const afterScheme = url.indexOf('://');
  const pathStart = afterScheme === -1 ? -1 : url.indexOf('/', afterScheme + 3);
  if (pathStart === -1) return;
  const end = url.slice(pathStart).search(/[?#]/);
  const rawPath = end === -1 ? url.slice(pathStart) : url.slice(pathStart, pathStart + end);
  if (new URL(url).pathname !== rawPath) {
    throw new Error('Invalid identifier: an id may not be "." or "..".');
  }
  for (const seg of rawPath.split('/').slice(1)) {
    let decoded;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new Error('Invalid identifier.');
    }
    if (!SEGMENT.test(decoded)) {
      throw new Error('Invalid identifier.');
    }
  }
}

// Index of the route a URL under baseUrl calls, or -1 if it is not one the tools use.
export function upstreamRoute(baseUrl, url) {
  try {
    const base = new URL(baseUrl);
    const target = new URL(url);
    const basePath = base.pathname.replace(/\/$/, '');
    if (target.origin !== base.origin || !target.pathname.startsWith(`${basePath}/`)) return -1;
    const path = target.pathname.slice(basePath.length);
    return ROUTES.findIndex((re) => re.test(path));
  } catch {
    return -1;
  }
}

// Where a redirect from the API may be followed, or null when it may not. The key is on every
// request, so a hop must stay on the same origin and base path, call the same route as the
// request it answers (a redirect may change an id, not which resource is read), and pass the
// same path check as the first URL.
export function upstreamRedirectTarget(baseUrl, currentUrl, location) {
  if (!location) return null;
  try {
    const next = new URL(location, currentUrl);
    next.hash = '';
    const route = upstreamRoute(baseUrl, next.href);
    if (route === -1 || route !== upstreamRoute(baseUrl, currentUrl)) return null;
    assertPathUnchanged(next.href);
    return next.href;
  } catch {
    return null;
  }
}

// fetch with redirects handled here instead of by fetch, which would repeat the request, key
// included, to wherever Location points. Returns the final response; throws on a refused hop.
export async function fetchUpstream(fetchImpl, baseUrl, url, init, maxRedirects = 3) {
  let current = url;
  for (let hops = 0; ; hops += 1) {
    const response = await fetchImpl(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status > 399) return response;
    const next = hops < maxRedirects
      ? upstreamRedirectTarget(baseUrl, current, response.headers.get('location'))
      : null;
    try { await response.arrayBuffer(); } catch { /* body not needed */ }
    if (!next) {
      const err = new Error('The API answered with a redirect this server does not follow, so the request was not repeated.');
      err.status = response.status;
      throw err;
    }
    current = next;
  }
}
