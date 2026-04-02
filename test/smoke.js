#!/usr/bin/env node

/**
 * Smoke test for CoinPaprika MCP server.
 * Spawns the server via stdio, sends MCP JSON-RPC messages, and verifies responses.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = join(__dirname, '..', 'src', 'index.js');

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    failed++;
  }
}

async function runTests() {
  console.log('Starting CoinPaprika MCP smoke test...\n');

  const server = spawn('node', [SERVER_PATH], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let buffer = '';
  const responses = [];

  server.stdout.on('data', (data) => {
    buffer += data.toString();
    // MCP uses newline-delimited JSON
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (line.trim()) {
        try {
          responses.push(JSON.parse(line));
        } catch (e) {
          // not JSON, skip
        }
      }
    }
  });

  server.stderr.on('data', (data) => {
    // Server may log to stderr, that's fine
  });

  function send(msg) {
    server.stdin.write(JSON.stringify(msg) + '\n');
  }

  function waitForResponse(id, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const found = responses.find(r => r.id === id);
        if (found) return resolve(found);
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for response id=${id}`));
        setTimeout(check, 100);
      };
      check();
    });
  }

  try {
    // 1. Initialize
    console.log('Test: Initialize');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test', version: '1.0' },
      },
    });
    const initResp = await waitForResponse(1);
    assert(initResp.result !== undefined, 'Initialize returns result');
    assert(initResp.result.serverInfo?.name === 'coinpaprika', 'Server name is coinpaprika');
    assert(initResp.result.capabilities?.tools !== undefined, 'Server has tools capability');

    // Send initialized notification
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    // 2. List tools
    console.log('\nTest: List tools');
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const toolsResp = await waitForResponse(2);
    const tools = toolsResp.result?.tools || [];
    assert(tools.length === 30, `Expected 30 tools, got ${tools.length}`);
    const toolNames = tools.map(t => t.name);
    assert(toolNames.includes('status'), 'Has status tool');
    assert(toolNames.includes('getGlobal'), 'Has getGlobal tool');
    assert(toolNames.includes('getTickers'), 'Has getTickers tool');
    assert(toolNames.includes('search'), 'Has search tool');
    assert(toolNames.includes('getCapabilities'), 'Has getCapabilities tool');

    // 3. Call status tool
    console.log('\nTest: Call status tool');
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    });
    const statusResp = await waitForResponse(3);
    assert(statusResp.result?.content?.[0]?.type === 'text', 'Status returns text content');
    const statusData = JSON.parse(statusResp.result.content[0].text);
    assert(statusData.server !== undefined || statusData.data !== undefined, 'Status has expected structure');

    // 4. Call getCapabilities tool
    console.log('\nTest: Call getCapabilities tool');
    send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'getCapabilities', arguments: {} },
    });
    const capsResp = await waitForResponse(4);
    assert(capsResp.result?.content?.[0]?.type === 'text', 'getCapabilities returns text content');
    const capsData = JSON.parse(capsResp.result.content[0].text);
    assert(capsData.server !== undefined || capsData.tools_count !== undefined, 'Capabilities has expected structure');

    // 5. Call getTickers with limit
    console.log('\nTest: Call getTickers (live API)');
    send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'getTickers', arguments: { limit: 2 } },
    });
    const tickersResp = await waitForResponse(5, 15000);
    assert(tickersResp.result?.content?.[0]?.type === 'text', 'getTickers returns text content');
    const tickersData = JSON.parse(tickersResp.result.content[0].text);
    assert(tickersData.data !== undefined, 'Tickers has data field');

  } catch (err) {
    console.error(`\nERROR: ${err.message}`);
    failed++;
  } finally {
    server.kill();

    console.log(`\n${'='.repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(40));

    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests();
