import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createArchive } from '../lib/archive-package.js';
import { makeEvidence } from './fixtures/archive-fixture.mjs';

const cli = fileURLToPath(new URL('../archive.mjs', import.meta.url));

async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wheelcast-archive-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(args, { preload, env = {} } = {}) {
  const child = spawn(process.execPath, [...(preload ? ['--import', preload] : []), cli, ...args], {
    env: {
      PATH: process.env.PATH,
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, stderr);
  return { code, stdout, stderr };
}

async function blockNetwork(dir) {
  const preload = path.join(dir, 'block-network.mjs');
  await writeFile(preload, 'globalThis.fetch = () => { process.stderr.write("UNEXPECTED_NETWORK\\n"); throw new Error("network disabled"); };\n');
  return preload;
}

test('CLI verifies a valid ZIP with fetch disabled and unusable export configuration', async (t) => {
  const dir = await directory(t);
  const filename = path.join(dir, 'snapshot.zip');
  await writeFile(filename, await createArchive(makeEvidence()));
  const result = await run(['verify', filename, '--json'], {
    preload: await blockNetwork(dir),
    env: { WHEELCAST_API: 'not-a-url', WHEELCAST_RPCS: 'not-a-rpc', WHEELCAST_TIMEOUT_MS: 'not-a-number' },
  });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.command, 'verify');
  assert.ok(report.summary.activeRounds > 0);
  assert.ok(report.summary.zeroRounds > 0);
  assert.ok(report.summary.unknownRounds > 0);
  assert.match(report.scope, /not an Ethereum provenance proof/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
});

test('CLI rejects a modified evidence ZIP with exit code 1', async (t) => {
  const dir = await directory(t);
  const filename = path.join(dir, 'changed.zip');
  const bytes = await createArchive(makeEvidence());
  bytes[50] ^= 1; // The first evidence file's data, after its local ZIP header.
  await writeFile(filename, bytes);
  const result = await run(['verify', filename, '--json'], { preload: await blockNetwork(dir) });
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.exitCode, 1);
  assert.match(report.error, /Archive verification failed/);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
});

test('CLI rejects non-Wheelcast input as an invalid archive', async (t) => {
  const dir = await directory(t);
  const filename = path.join(dir, 'not-an-archive.zip');
  await writeFile(filename, 'This is not a ZIP archive.');
  const result = await run(['verify', filename, '--json']);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test('CLI export preserves an existing output before attempting the network', async (t) => {
  const dir = await directory(t);
  const filename = path.join(dir, 'existing.zip');
  const original = 'keep this file exactly';
  await writeFile(filename, original);
  const result = await run(['export', filename, '--json'], {
    preload: await blockNetwork(dir), env: { WHEELCAST_API: 'http://127.0.0.1:9/v1' },
  });
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stdout).error, /already exists/);
  assert.equal(await readFile(filename, 'utf8'), original);
  assert.doesNotMatch(result.stderr, /UNEXPECTED_NETWORK/);
});

test('CLI reports missing archive input as an IO error', async (t) => {
  const dir = await directory(t);
  const result = await run(['verify', path.join(dir, 'missing.zip'), '--json']);
  assert.equal(result.code, 2);
  assert.match(JSON.parse(result.stdout).error, /Could not read the archive/);
});

test('CLI exports a fixed-block RPC archive and verifies it without network access', async (t) => {
  const dir = await directory(t);
  const evidence = makeEvidence();
  const hex = (value) => '0x' + BigInt(value).toString(16);
  const word = (value) => BigInt(value).toString(16).padStart(64, '0');
  const config = evidence.configuration;
  const ledger = evidence.state;
  const configData = '0x' + [
    config.streamId, config.genesisTimestamp, config.roundDuration, config.maxWorkPerRound,
    config.maxRoundsPerBatch, config.guardian, config.reporter, config.initialWorkPerThousandBlocks,
    config.targetBlocksPerActiveRound, config.difficultySmoothingRounds, config.blockUnitsPerBlock,
  ].map(word).join('');
  const stateData = '0x' + [
    ledger.settledThroughRound, ledger.cumulativeWork, ledger.cumulativeBlockUnits, ledger.blockHeight,
    ledger.blockProgress, ledger.workPerThousandBlocks, ledger.authorizationNonce, ledger.paused ? 1 : 0,
  ].map(word).join('');
  const block = { ...evidence.snapshot, number: hex(evidence.snapshot.number), timestamp: hex(evidence.snapshot.timestamp) };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/core') {
      res.end(JSON.stringify({ status: 'available', identities: { core: evidence.core }, chain: { deploymentBlock: evidence.deploymentBlock } }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    let result;
    if (request.method === 'eth_chainId') result = '0xaa36a7';
    if (request.method === 'eth_blockNumber') result = hex(evidence.head.number);
    if (request.method === 'eth_getBlockByNumber') result = block;
    if (request.method === 'eth_call') result = ({
      '0x6c70bee9': configData, '0xc19d93fb': stateData, '0xe5900225': '0x' + word(3),
    })[request.params[0].data];
    if (request.method === 'eth_getLogs') {
      const range = request.params[0];
      result = evidence.logs.filter((log) => BigInt(log.blockNumber) >= BigInt(range.fromBlock) && BigInt(log.blockNumber) <= BigInt(range.toBlock));
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const filename = path.join(dir, 'exported.zip');
  try {
    const exported = await run(['export', filename, '--json'], {
      env: { WHEELCAST_API: base + '/v1', WHEELCAST_RPCS: base + '/rpc@2' },
    });
    assert.equal(exported.code, 0, exported.stdout + exported.stderr);
    const exportedReport = JSON.parse(exported.stdout);
    assert.equal(exportedReport.ok, true);
    assert.equal(exportedReport.snapshot.hash, evidence.snapshot.hash);
    const verified = await run(['verify', filename, '--json'], { preload: await blockNetwork(dir) });
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout).summary, exportedReport.summary);
    assert.doesNotMatch(verified.stderr, /UNEXPECTED_NETWORK/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
