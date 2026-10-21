// Ids reach the upstream path through encodeURIComponent, which encodes "/", "?" and "#" but
// leaves "." and "..". An id of ".." would make the request, with your API key on it, go to a
// different path than the tool intended, because URL parsing resolves dot segments. And an id
// of "../key/info" encodes to "..%2Fkey%2Finfo", which URL parsing leaves alone but a server
// that decodes before routing might not. So refuse any URL whose path changes when parsed, and
// any path segment that, decoded once, is "." or ".." or holds "/", "\" or "%". No real coin,
// exchange, tag, person, platform or contract id contains any of these.
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
    if (decoded === '.' || decoded === '..' || /[\\/%]/.test(decoded)) {
      throw new Error('Invalid identifier.');
    }
  }
}
