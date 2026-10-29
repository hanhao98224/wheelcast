import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const verifier = fileURLToPath(new URL('../verify.mjs', import.meta.url));
const topic0 = '0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c';
const address = '0x1111111111111111111111111111111111111111';
const word = (value) => BigInt(value).toString(16).padStart(64, '0');

// Hand-calculated one-round records, both with initial difficulty 10,000.
// Their accounting is valid; only the second exceeds the configured work cap.
const records = {
  atCap: { work: '10000', units: '1000000000000', difficulty: '18000' },
  aboveCap: { work: '10001', units: '1000100000000', difficulty: '18000' },
};

async function runVerifier(record, args = ['--json']) {
  const core = {
    status: 'available',
    identities: { core: address },
    chain: { deploymentBlock: '100', chainId: '11155111' },
    configuration: { initialWorkPerThousandBlocks: '10000', maxWorkPerRound: '10000' },
    core: {
      cumulativeWork: record.work,
      cumulativeBlockUnits: record.units,
      blockHeight: '1000',
      workPerThousandBlocks: record.difficulty,
      settledThroughRound: '1',
    },
  };
  const log = {
    address,
    topics: [topic0, '0x' + word(1)],
    data: '0x' + [record.work, record.work, record.units, record.difficulty, 1].map(word).join(''),
    blockNumber: '0x64',
    logIndex: '0x0',
    transactionHash: '0x' + word(1),
  };
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/v1/core') {
      res.end(JSON.stringify(core));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString());
    const result = {
      eth_chainId: '0xaa36a7',
      eth_blockNumber: '0x64',
      eth_getLogs: [log],
    }[request.method];
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const child = spawn(process.execPath, [verifier, ...args], {
      env: {
        ...process.env,
        WHEELCAST_API: base + '/v1',
        WHEELCAST_RPCS: base + '/rpc',
        WHEELCAST_TIMEOUT_MS: '2000',
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
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('CLI accepts correct accounting at the work cap', async () => {
  const result = await runVerifier(records.atCap);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.mismatches, []);
  assert.deepEqual(report.oversizedRounds, []);
});

test('CLI rejects an oversized round even when every arithmetic check matches', async () => {
  const result = await runVerifier(records.aboveCap);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatches, []);
  assert.ok(report.crossChecks.every((check) => check.ok));
  assert.equal(report.initialDifficulty.matches, true);
  assert.deepEqual(report.orderingProblems, []);
  assert.deepEqual(report.oversizedRounds, [1]);
});

test('CLI human-readable output reports failure for an oversized round', async () => {
  const result = await runVerifier(records.aboveCap, []);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /round size cap\s+1 round\(s\) above 10,000/);
  assert.match(result.stdout, /PARITY FAIL/);
  assert.doesNotMatch(result.stdout, /PARITY OK/);
});
