#!/usr/bin/env node
// An id must never change which upstream path a tool calls: "..", "%2e%2e" and an encoded
// slash after ".." are all refused before any request leaves the process.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { assertPathUnchanged } from '../src/safe-path.js';

const base = 'https://api.coinpaprika.com/v1';
const BAD = ['..', '.', '../key/info', '..\\key', 'x/../../key/info', '%2e%2e', '%252e%252e', '..%2Fkey'];
const GOOD = ['btc-bitcoin', 'eth-ethereum', 'binance', 'defi', '0x2::sui::SUI', 'a.b'];

let failed = 0;
const check = (name, fn) => { try { fn(); console.log(`  PASS: ${name}`); } catch (e) { failed++; console.error(`  FAIL: ${name}: ${e.message}`); } };

for (const id of BAD) {
  check(`refuses ${JSON.stringify(id)}`, () => assert.throws(() => assertPathUnchanged(`${base}/exchanges/${encodeURIComponent(id)}`), /Invalid identifier/));
}
for (const id of GOOD) {
  check(`allows ${JSON.stringify(id)}`, () => assertPathUnchanged(`${base}/coins/${encodeURIComponent(id)}/events?x=${encodeURIComponent('../y')}`));
}

// End to end over stdio: the tool answers with the refusal, not with an upstream error.
const transport = new StdioClientTransport({
  command: 'node',
  args: [join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js')],
  env: { ...process.env, COINPAPRIKA_API_KEY: '' },
});
const client = new Client({ name: 'path-safety', version: '0' });
await client.connect(transport);
for (const [name, args] of [
  ['getExchangeByID', { exchangeId: '../key/info' }],
  ['getTagById', { tagId: '..' }],
  ['getPeopleById', { personId: '..%2Fkey' }],
]) {
  const r = await client.callTool({ name, arguments: args });
  const text = JSON.stringify(r.content);
  check(`${name} ${JSON.stringify(args)} is refused before fetch`, () => assert.match(text, /Invalid identifier/));
}
await client.close();

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
