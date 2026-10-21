#!/usr/bin/env node
// An id must never change which upstream path a tool calls: "..", "%2e%2e" and an encoded
// slash after ".." are all refused before any request leaves the process.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertPathUnchanged, CONTRACT_ADDRESS, fetchUpstream, SLUG_ID } from '../src/safe-path.js';
import { pickKeyInfo } from '../src/key-info.js';

const base = 'https://api.coinpaprika.com/v1';
const BAD = ['..', '.', '../key/info', '..\\key', 'x/../../key/info', '%2e%2e', '%252e%252e', '..%2Fkey',
  // Left alone by URL parsing, but "..", "/" or a separator to a server that strips ";"
  // parameters, trims whitespace, drops soft hyphens or folds Unicode before routing.
  '\uFF0E\uFF0E\uFF0Fkey\uFF0Finfo', '\u2025', '\uFE52\uFE52', '\u2024\u2024', 'x\u2215y',
  '..\u0000', '.. ', '..\t', '..\u00AD', '..;x', '..?', 'x;y=1', '...'];
const GOOD = ['btc-bitcoin', 'eth-ethereum', 'binance', 'defi', '0x2::sui::SUI', 'a.b'];

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`  PASS: ${name}`); } catch (e) { failed++; console.error(`  FAIL: ${name}: ${e.message}`); } };
const checkAsync = async (name, fn) => { try { await fn(); console.log(`  PASS: ${name}`); } catch (e) { failed++; console.error(`  FAIL: ${name}: ${e.message}`); } };

for (const id of BAD) {
  check(`refuses ${JSON.stringify(id)}`, () => assert.throws(() => assertPathUnchanged(`${base}/exchanges/${encodeURIComponent(id)}`), /Invalid identifier/));
}
// Every id argument has its own alphabet; none of the payloads above fits either.
for (const id of BAD) {
  check(`slug ids refuse ${JSON.stringify(id)}`, () => assert.equal(SLUG_ID.test(id), false));
  check(`contract addresses refuse ${JSON.stringify(id)}`, () => assert.equal(CONTRACT_ADDRESS.test(id), false));
}
for (const id of ['binance', 'defi', 'vitalik-buterin', 'eth-ethereum', 'xch-chia-']) {
  check(`slug ids allow ${JSON.stringify(id)}`, () => assert.ok(SLUG_ID.test(id)));
}
for (const id of ['0xdac17f958d2ee523a2206206994597c13d831ec7', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '0x2::sui::SUI', '0x1::aptos_coin::AptosCoin', 'usdt.tether-token.near', '0.0.456858', 'EQCFd_1lGNp8l6BA17IULZM-s_6yWYDz2RdRwSqbt35eXA9I']) {
  check(`contract addresses allow ${JSON.stringify(id)}`, () => assert.ok(CONTRACT_ADDRESS.test(id)));
}

for (const id of GOOD) {
  check(`allows ${JSON.stringify(id)}`, () => assertPathUnchanged(`${base}/coins/${encodeURIComponent(id)}/events?x=${encodeURIComponent('../y')}`));
}

// Redirects: followed only on the same origin, to the same route, and never off the API.
const redirecting = (locations) => {
  const seen = [];
  const impl = async (url, init) => {
    seen.push({ url, redirect: init.redirect, authorization: init.headers.Authorization });
    const location = locations[seen.length - 1];
    if (location === undefined) return new Response('{}', { status: 200 });
    return new Response(null, { status: 302, headers: { location } });
  };
  return { seen, impl };
};
const from = `${base}/coins/btc-bitcoin`;
for (const location of ['/v1/key/info', '/v1/global', '/outside/target', '../key/info', '/v1/coins/..;',
  'https://elsewhere.example.test/v1/coins/btc-bitcoin', 'http://api.coinpaprika.com/v1/coins/btc-bitcoin']) {
  await checkAsync(`refuses a redirect to ${location}`, async () => {
    const { seen, impl } = redirecting([location]);
    await assert.rejects(fetchUpstream(impl, base, from, { headers: { Authorization: 'k' } }), /redirect/);
    assert.deepEqual(seen.map((r) => r.url), [from]);
    assert.equal(seen[0].redirect, 'manual');
  });
}
await checkAsync('follows a same-route redirect to another id', async () => {
  const { seen, impl } = redirecting(['/v1/coins/btc-bitcoin-new']);
  const r = await fetchUpstream(impl, base, from, { headers: { Authorization: 'k' } });
  assert.equal(r.status, 200);
  assert.deepEqual(seen.map((x) => x.url), [from, `${base}/coins/btc-bitcoin-new`]);
});

// keyInfo passes only the documented, non-secret fields to the model.
check('keyInfo keeps the plan and the monthly counters', () => {
  const body = {
    plan: 'pro', plan_status: 'active', plan_started_at: '2022-09-16T10:17:24Z',
    portal_url: 'https://billing.example.test/session/abc', api_key: 'secret-key', customer_id: 'cus_1',
    note: 'secret-key', usage: { message: 'limited plan', key: 'secret-key', current_month: { requests_made: 18, requests_left: 499982, owner: 'x' } },
  };
  assert.deepEqual(pickKeyInfo(body, 'secret-key'), {
    plan: 'pro', plan_status: 'active', plan_started_at: '2022-09-16T10:17:24Z',
    usage: { message: 'limited plan', current_month: { requests_made: 18, requests_left: 499982 } },
  });
  assert.equal(pickKeyInfo({ plan: 'pro secret-key' }, 'secret-key').plan, undefined);
});

// End to end over stdio: the tool answers with the refusal, not with an upstream error. The
// server runs with the network disabled, so an id that slips through fails here, offline.
const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({
  command: 'node',
  args: ['--import', join(here, 'no-network.mjs'), join(here, '..', 'src', 'index.js')],
  env: { ...process.env, COINPAPRIKA_API_KEY: '' },
});
const client = new Client({ name: 'path-safety', version: '0' });
await client.connect(transport);
for (const [name, args] of [
  ['getExchangeByID', { exchangeId: '../key/info' }],
  ['getTagById', { tagId: '..' }],
  ['getPeopleById', { personId: '..%2Fkey' }],
  ['getPeopleById', { personId: '\uFF0E\uFF0E\uFF0Fkey\uFF0Finfo' }],
  ['getExchangeByID', { exchangeId: '..;' }],
  ['getTagById', { tagId: '\u2025' }],
  ['getContracts', { platformId: '.. ' }],
  ['getTickerByContract', { platformId: 'eth-ethereum', contractAddress: '..\u00AD' }],
  ['getTickerByContract', { platformId: '\uFE52\uFE52', contractAddress: '\uFE52\uFE52' }],
]) {
  const r = await client.callTool({ name, arguments: args });
  const text = JSON.stringify(r.content);
  check(`${name} ${JSON.stringify(args)} is refused before fetch`, () => assert.match(text, /Invalid identifier/));
}
await client.close();

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
