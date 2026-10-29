#!/usr/bin/env node
/**
 * Wheelcast - standalone parity check for Squeekchain's SqueekCore.
 *
 * Re-derives SqueekCore's cumulative block units and difficulty from the
 * RoundRecorded logs it actually emitted, using nothing but the whitepaper's
 * integer rules, then compares the result with what the contract wrote.
 *
 * This file is deliberately self-contained. No dependencies, no ABI files, no
 * ethers/viem, and no imports from ../lib: keccak-256, hex decoding and the
 * replay all live here so the check does not share code with the thing it
 * checks.
 *
 * Rules under test (docs.squeekchain.com/whitepaper.md, "Exact rule"):
 *
 *   blockUnits += floor(w * 10^12 / D)
 *   D_next      = floor((29*D + floor(w*1000/40)) / 30)   when w >= 40
 *   D_next      = D                                        when w < 40
 *   height      = floor(blockUnits / 10^9)
 *
 * The whitepaper orders the two steps: a round is "first priced at the
 * difficulty that earlier rounds set", and only then does it move difficulty.
 * So block units use D as it stood before the round, while the
 * workPerThousandBlocks word in the event is the difficulty after it.
 *
 * Usage:
 *   node verify.mjs              # mismatches only, plus a summary
 *   node verify.mjs --all        # print every round
 *   node verify.mjs --json       # machine-readable result on stdout
 *   node verify.mjs --help
 *
 * Environment:
 *   WHEELCAST_API          API base, default https://api.squeekchain.com/v1
 *   WHEELCAST_RPCS         comma separated endpoints, "url" or "url@maxRange"
 *   WHEELCAST_TIMEOUT_MS   per-request timeout, default 30000
 *
 * Exit codes: 0 parity holds, 1 mismatch, 2 setup or network failure.
 */

import process from 'node:process';

const API_BASE = (process.env.WHEELCAST_API ?? 'https://api.squeekchain.com/v1').replace(/\/+$/, '');
const TIMEOUT_MS = Number(process.env.WHEELCAST_TIMEOUT_MS ?? 30000);

/** Public Sepolia endpoints, tried in order. maxRange is a per-request block span. */
const DEFAULT_RPCS = [
  ['https://ethereum-sepolia-rpc.publicnode.com', 5000],
  ['https://sepolia.gateway.tenderly.co', 20000],
  ['https://sepolia.drpc.org', 10000],
];

const ROUND_RECORDED_SIG = 'RoundRecorded(uint64,uint64,uint64,uint96,uint32,bytes32)';

const BLOCK_UNITS_PER_BLOCK = 10n ** 9n;
const BLOCK_UNITS_SCALE = 10n ** 12n;
const TARGET_BLOCKS_PER_ACTIVE_ROUND = 40n;
const DIFFICULTY_SMOOTHING = 30n;
const MIN_DIFFICULTY = 1000n;

// ---------------------------------------------------------------------------
// keccak-256 (Keccak-f[1600], original 0x01 padding as used by Ethereum)
// ---------------------------------------------------------------------------

const KECCAK_ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

const KECCAK_ROTATIONS = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

const MASK64 = (1n << 64n) - 1n;

function rotl64(value, shift) {
  if (shift === 0) return value;
  const n = BigInt(shift);
  return ((value << n) | (value >> (64n - n))) & MASK64;
}

function keccakF1600(state) {
  const c = new Array(5).fill(0n);
  const b = new Array(25).fill(0n);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[y + x] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y], KECCAK_ROTATIONS[x][y]);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[y + x] = b[y + x] ^ (~b[((x + 1) % 5) + y] & MASK64 & b[((x + 2) % 5) + y]);
      }
    }
    state[0] ^= KECCAK_ROUND_CONSTANTS[round];
  }
}

function keccak256(input) {
  const rate = 136; // 1088-bit rate
  const padLength = rate - (input.length % rate);
  const message = new Uint8Array(input.length + padLength);
  message.set(input);
  message[input.length] ^= 0x01;
  message[message.length - 1] ^= 0x80;

  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < message.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        word = (word << 8n) | BigInt(message[offset + lane * 8 + byte]);
      }
      state[lane] ^= word;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane];
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return out;
}

function toHex(bytes) {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function eventTopic0(signature) {
  return toHex(keccak256(new TextEncoder().encode(signature)));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function hexQuantity(n) {
  return '0x' + BigInt(n).toString(16);
}

/** 2994347019284 -> "2,994,347,019,284" (no locale, deterministic). */
function fmt(value) {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function padEnd(text, width) {
  const value = String(text);
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padStart(text, width) {
  const value = String(text);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

class SetupError extends Error {}

// ---------------------------------------------------------------------------
// HTTP / JSON-RPC
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new SetupError('GET ' + url + ' -> HTTP ' + response.status);
  }
  return response.json();
}

async function rpcCall(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const body = await response.json();
  if (body.error) {
    throw new Error((body.error.message ?? 'rpc error') + ' (code ' + (body.error.code ?? '?') + ')');
  }
  if (body.result === undefined) throw new Error('malformed JSON-RPC response');
  return body.result;
}

function parseEndpoints() {
  const raw = process.env.WHEELCAST_RPCS;
  if (!raw) return DEFAULT_RPCS.map(([url, maxRange]) => ({ url, maxRange }));
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, range] = entry.split('@');
      const parsed = Number(range);
      return { url, maxRange: Number.isFinite(parsed) && parsed > 0 ? parsed : 5000 };
    });
}

/**
 * Walk [fromBlock, toBlock] for one topic, shrinking the span and rotating
 * endpoints when a provider refuses the range or rate-limits us. Providers
 * differ wildly here: some prune history, some cap the span at 50 blocks.
 */
async function collectLogs({ endpoints, address, topic, fromBlock, toBlock, onProgress, onFallback }) {
  const logs = [];
  const servedBy = new Set();
  let endpointIndex = 0;
  let span = endpoints[0].maxRange;
  let cursor = fromBlock;
  let consecutiveFailures = 0;
  const errors = [];

  while (cursor <= toBlock) {
    const endpoint = endpoints[endpointIndex];
    const limit = Math.min(span, endpoint.maxRange);
    const end = Math.min(cursor + limit - 1, toBlock);
    try {
      const batch = await rpcCall(endpoint.url, 'eth_getLogs', [
        {
          address,
          fromBlock: hexQuantity(cursor),
          toBlock: hexQuantity(end),
          topics: [topic],
        },
      ]);
      for (const entry of batch) logs.push(entry);
      servedBy.add(endpoint.url);
      if (onProgress) onProgress(cursor, end, endpoint.url);
      cursor = end + 1;
      consecutiveFailures = 0;
      await sleep(40);
    } catch (error) {
      errors.push(endpoint.url + ': ' + error.message);
      consecutiveFailures += 1;
      if (onFallback) onFallback(endpoint.url + ': ' + error.message);
      if (consecutiveFailures > endpoints.length * 8) {
        throw new SetupError(
          'eth_getLogs kept failing around block ' + cursor + ':\n  ' + errors.slice(-4).join('\n  '),
        );
      }
      if (limit > 2000) {
        span = Math.floor(limit / 4);
      } else {
        endpointIndex = (endpointIndex + 1) % endpoints.length;
        span = endpoints[endpointIndex].maxRange;
        await sleep(250);
      }
    }
  }

  return { logs, servedBy: Array.from(servedBy) };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * RoundRecorded(uint64 indexed roundId, uint64 work, uint64 cumulativeWork,
 *               uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks,
 *               bytes32 dataHash)
 * -> 2 topics, 5 data words.
 */
function decodeRoundRecorded(log) {
  const topics = log.topics ?? [];
  if (topics.length !== 2) {
    throw new SetupError(
      'RoundRecorded log has ' + topics.length + ' topics, expected 2 (tx ' + log.transactionHash + ')',
    );
  }
  const data = (log.data ?? '').slice(2);
  if (data.length !== 5 * 64) {
    throw new SetupError(
      'RoundRecorded log has ' + data.length / 64 + ' data words, expected 5 (tx ' + log.transactionHash + ')',
    );
  }
  const word = (index) => BigInt('0x' + data.slice(index * 64, index * 64 + 64));
  return {
    roundId: BigInt(topics[1]),
    work: word(0),
    cumulativeWork: word(1),
    cumulativeBlockUnits: word(2),
    workPerThousandBlocks: word(3),
    dataHash: '0x' + data.slice(4 * 64, 5 * 64),
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex ?? '0x0')),
    transactionHash: log.transactionHash,
  };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

function nextDifficulty(difficulty, work) {
  if (work < TARGET_BLOCKS_PER_ACTIVE_ROUND) return difficulty;
  const pull = (work * 1000n) / TARGET_BLOCKS_PER_ACTIVE_ROUND;
  const next = (29n * difficulty + pull) / DIFFICULTY_SMOOTHING;
  return next < MIN_DIFFICULTY ? MIN_DIFFICULTY : next;
}

function replay(events, initialDifficulty) {
  let difficulty = initialDifficulty;
  let blockUnits = 0n;
  let cumulativeWork = 0n;
  const rows = [];

  for (const event of events) {
    const difficultyBefore = difficulty;
    blockUnits += (event.work * BLOCK_UNITS_SCALE) / difficultyBefore;
    cumulativeWork += event.work;
    difficulty = nextDifficulty(difficultyBefore, event.work);

    rows.push({
      roundId: event.roundId,
      work: event.work,
      difficultyBefore,
      difficultyAfter: difficulty,
      cumulativeWork,
      blockUnits,
      blockNumber: event.blockNumber,
      emitted: event,
      problems: [],
    });
  }

  for (const row of rows) {
    if (row.cumulativeWork !== row.emitted.cumulativeWork) {
      row.problems.push({
        field: 'cumulativeWork',
        expected: row.emitted.cumulativeWork,
        derived: row.cumulativeWork,
      });
    }
    if (row.blockUnits !== row.emitted.cumulativeBlockUnits) {
      row.problems.push({
        field: 'cumulativeBlockUnits',
        expected: row.emitted.cumulativeBlockUnits,
        derived: row.blockUnits,
      });
    }
    if (row.difficultyAfter !== row.emitted.workPerThousandBlocks) {
      row.problems.push({
        field: 'workPerThousandBlocks',
        expected: row.emitted.workPerThousandBlocks,
        derived: row.difficultyAfter,
      });
    }
  }

  return {
    rows,
    blockUnits,
    cumulativeWork,
    difficulty,
    height: blockUnits / BLOCK_UNITS_PER_BLOCK,
    mismatchCount: rows.filter((row) => row.problems.length > 0).length,
  };
}

function ceilDiv(a, b) {
  return (a + b - 1n) / b;
}

/** A recovery window that collapsed to one integer prints as that integer. */
function formatRecovered(recovered) {
  return recovered.low === recovered.high
    ? String(recovered.low)
    : recovered.low + '..' + recovered.high;
}

/**
 * The first event's emitted difficulty is the value after one update, so the
 * difficulty that round was priced at is recoverable only as an interval:
 *   target <= (29*D + pull) / 30 < target + 1
 * If the deployment's configured initial difficulty falls inside that interval
 * and reproduces the emitted value exactly, the chain has been replaying one
 * consistent difficulty since genesis.
 */
function recoverInitialDifficulty(firstEvent) {
  if (firstEvent.work < TARGET_BLOCKS_PER_ACTIVE_ROUND) {
    const same = firstEvent.workPerThousandBlocks;
    return { exact: true, low: same, high: same };
  }
  const pull = (firstEvent.work * 1000n) / TARGET_BLOCKS_PER_ACTIVE_ROUND;
  const target = firstEvent.workPerThousandBlocks;
  const low = ceilDiv(DIFFICULTY_SMOOTHING * target - pull, DIFFICULTY_SMOOTHING - 1n);
  const high =
    (DIFFICULTY_SMOOTHING * (target + 1n) - 1n - pull) / (DIFFICULTY_SMOOTHING - 1n);
  return { exact: false, low, high };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function usage() {
  return [
    'Wheelcast - Squeekchain parity check',
    '',
    '  node verify.mjs           check every RoundRecorded event, print mismatches',
    '  node verify.mjs --all     print every round, not just the latest one',
    '  node verify.mjs --json    emit a JSON report instead of a table',
    '',
    'Env: WHEELCAST_API, WHEELCAST_RPCS ("url@maxRange,url"), WHEELCAST_TIMEOUT_MS',
    'Exit: 0 parity holds, 1 mismatch, 2 setup or network failure.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return 0;
  }
  const showAll = argv.includes('--all');
  const asJson = argv.includes('--json');

  // A wrong topic hash would return zero logs and look like a quiet pass, so
  // prove the keccak implementation against a topic everyone can check.
  const topic0 = eventTopic0(ROUND_RECORDED_SIG);
  const transferTopic = eventTopic0('Transfer(address,address,uint256)');
  if (transferTopic !== '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef') {
    throw new SetupError('keccak-256 self-test failed: ' + transferTopic);
  }

  const core = await fetchJson(API_BASE + '/core');
  if (core.status !== 'available') {
    throw new SetupError(API_BASE + '/core reports status ' + JSON.stringify(core.status));
  }

  const coreAddress = core.identities.core;
  const deploymentBlock = Number(core.chain.deploymentBlock);
  const chainId = Number(core.chain.chainId);
  const initialDifficulty = BigInt(core.configuration.initialWorkPerThousandBlocks);
  const maxWorkPerRound = BigInt(core.configuration.maxWorkPerRound);
  const expected = {
    cumulativeWork: BigInt(core.core.cumulativeWork),
    cumulativeBlockUnits: BigInt(core.core.cumulativeBlockUnits),
    blockHeight: BigInt(core.core.blockHeight),
    workPerThousandBlocks: BigInt(core.core.workPerThousandBlocks),
    settledThroughRound: BigInt(core.core.settledThroughRound),
  };

  const endpoints = parseEndpoints();
  let head = null;
  let usedEndpoint = null;
  for (const endpoint of endpoints) {
    try {
      const reportedChainId = await rpcCall(endpoint.url, 'eth_chainId', []);
      if (Number(BigInt(reportedChainId)) !== chainId) {
        throw new Error('chain id ' + BigInt(reportedChainId) + ' != ' + chainId);
      }
      head = Number(BigInt(await rpcCall(endpoint.url, 'eth_blockNumber', [])));
      usedEndpoint = endpoint.url;
      break;
    } catch (error) {
      if (!asJson) console.error('! ' + endpoint.url + ': ' + error.message);
    }
  }
  if (head === null) throw new SetupError('no usable Sepolia RPC endpoint');

  const { logs: rawLogs, servedBy } = await collectLogs({
    endpoints,
    address: coreAddress,
    topic: topic0,
    fromBlock: deploymentBlock,
    toBlock: head,
    onProgress: asJson ? null : (from, to) => process.stderr.write('  scanned ' + from + '..' + to + '\n'),
    onFallback: (message) => process.stderr.write('  ! ' + message + ' - retrying with a smaller range or another endpoint\n'),
  });

  const events = rawLogs
    .map(decodeRoundRecorded)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);

  if (events.length === 0) {
    throw new SetupError(
      'no RoundRecorded events between ' + deploymentBlock + ' and ' + head + ' for ' + coreAddress,
    );
  }

  const orderingProblems = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i].roundId <= events[i - 1].roundId) {
      orderingProblems.push('round ' + events[i].roundId + ' follows ' + events[i - 1].roundId);
    }
  }
  const oversized = events.filter((event) => event.work > maxWorkPerRound);

  const result = replay(events, initialDifficulty);
  const first = events[0];
  const last = events[events.length - 1];
  const recovered = recoverInitialDifficulty(first);
  const initialMatches = recovered.exact
    ? recovered.low === initialDifficulty
    : initialDifficulty >= recovered.low && initialDifficulty <= recovered.high;

  const crossChecks = [
    ['cumulativeWork', expected.cumulativeWork, result.cumulativeWork],
    ['cumulativeBlockUnits', expected.cumulativeBlockUnits, result.blockUnits],
    ['workPerThousandBlocks', expected.workPerThousandBlocks, result.difficulty],
    ['blockHeight', expected.blockHeight, result.height],
  ];
  const failedCrossChecks = crossChecks.filter(([, want, got]) => want !== got);
  const ok =
    result.mismatchCount === 0 &&
    failedCrossChecks.length === 0 &&
    orderingProblems.length === 0 &&
    oversized.length === 0 &&
    initialMatches;
  const exitCode = ok ? 0 : 1;

  if (asJson) {
    const report = {
      ok,
      api: API_BASE,
      rpcProbe: usedEndpoint,
      rpcServedBy: servedBy,
      chainId,
      core: coreAddress,
      deploymentBlock,
      head,
      rounds: events.length,
      firstRound: Number(first.roundId),
      lastRound: Number(last.roundId),
      mismatches: result.rows
        .filter((row) => row.problems.length > 0)
        .map((row) => ({
          roundId: Number(row.roundId),
          problems: row.problems.map((problem) => ({
            field: problem.field,
            expected: problem.expected.toString(),
            derived: problem.derived.toString(),
          })),
        })),
      orderingProblems,
      oversizedRounds: oversized.map((event) => Number(event.roundId)),
      replay: {
        height: result.height.toString(),
        blockUnits: result.blockUnits.toString(),
        cumulativeWork: result.cumulativeWork.toString(),
        workPerThousandBlocks: result.difficulty.toString(),
      },
      contract: {
        height: expected.blockHeight.toString(),
        blockUnits: expected.cumulativeBlockUnits.toString(),
        cumulativeWork: expected.cumulativeWork.toString(),
        workPerThousandBlocks: expected.workPerThousandBlocks.toString(),
        settledThroughRound: expected.settledThroughRound.toString(),
      },
      initialDifficulty: {
        configured: initialDifficulty.toString(),
        recoveredLow: recovered.low.toString(),
        recoveredHigh: recovered.high.toString(),
        matches: initialMatches,
      },
      crossChecks: crossChecks.map(([field, want, got]) => ({
        field,
        contract: want.toString(),
        replay: got.toString(),
        ok: want === got,
      })),
    };
    console.log(JSON.stringify(report, null, 2));
    return exitCode;
  }

  const out = [];
  out.push('');
  out.push('Wheelcast - Squeekchain parity check');
  out.push('');
  out.push('  API             ' + API_BASE + '/core');
  out.push('  Core            ' + coreAddress + '  (deployment block ' + deploymentBlock + ')');
  out.push('  Chain           ' + chainId);
  out.push('  RPC             ' + usedEndpoint + '  (head ' + head + ')');
  if (servedBy.length > 0 && (servedBy.length > 1 || servedBy[0] !== usedEndpoint)) {
    out.push('  Logs served by  ' + servedBy.join(', '));
  }
  out.push('  Event           ' + ROUND_RECORDED_SIG);
  out.push('  Topic0          ' + topic0);
  out.push('  Rounds          ' + events.length + ' recorded, round ' + first.roundId + ' .. ' + last.roundId);
  out.push('');

  const header = [
    padEnd('round', 7),
    padStart('work', 7),
    padStart('cumWork', 10),
    padStart('D before', 11),
    padStart('D emitted', 11),
    padStart('blockUnits', 17),
    'block',
  ].join('  ');
  out.push(header);
  out.push('-'.repeat(header.length + 8));

  const rowsToPrint = showAll ? result.rows : result.rows.slice(-1);
  for (const row of rowsToPrint) {
    out.push(
      [
        padEnd(row.roundId, 7),
        padStart(fmt(row.work), 7),
        padStart(fmt(row.cumulativeWork), 10),
        padStart(fmt(row.difficultyBefore), 11),
        padStart(fmt(row.difficultyAfter), 11),
        padStart(fmt(row.blockUnits), 17),
        row.blockNumber,
      ].join('  '),
    );
  }
  if (!showAll && result.rows.length > 1) {
    out.push('(' + (result.rows.length - 1) + ' earlier rounds omitted, use --all to print them)');
  }

  const mismatches = result.rows.filter((row) => row.problems.length > 0);
  out.push('');
  if (mismatches.length === 0) {
    out.push('  mismatches      none');
  } else {
    out.push('  mismatches');
    out.push(
      ['  ' + padEnd('round', 7), padEnd('field', 22), padStart('contract', 20), padStart('derived', 20)].join('  '),
    );
    for (const row of mismatches) {
      for (const problem of row.problems) {
        out.push(
          ['  ' + padEnd(row.roundId, 7), padEnd(problem.field, 22), padStart(fmt(problem.expected), 20), padStart(fmt(problem.derived), 20)].join('  '),
        );
      }
    }
  }

  out.push('');
  out.push('  checks');
  for (const [field, want, got] of crossChecks) {
    out.push(
      '  ' +
        padEnd(field, 22) +
        'replay ' +
        padStart(fmt(got), 18) +
        '   contract ' +
        padStart(fmt(want), 18) +
        '   ' +
        (want === got ? 'ok' : 'MISMATCH'),
    );
  }
  out.push(
    '  ' +
      padEnd('initial difficulty', 22) +
      'configured ' +
      initialDifficulty +
      '   recovered from round ' +
      first.roundId +
      ': ' +
      formatRecovered(recovered) +
      '   ' +
      (initialMatches ? 'ok' : 'MISMATCH'),
  );
  out.push(
    '  ' +
      padEnd('round ordering', 22) +
      (orderingProblems.length === 0
        ? 'strictly increasing across ' + events.length + ' events   ok'
        : orderingProblems.join('; ')),
  );
  out.push(
    '  ' +
      padEnd('round size cap', 22) +
      (oversized.length === 0
        ? 'every round <= ' + fmt(maxWorkPerRound) + ' work   ok'
        : oversized.length + ' round(s) above ' + fmt(maxWorkPerRound)),
  );
  out.push(
    '  ' +
      padEnd('settled frontier', 22) +
      'contract reports round ' +
      expected.settledThroughRound +
      ', last round with work ' +
      last.roundId +
      ' (zero-work rounds emit no event)',
  );
  out.push('');

  if (ok) {
    out.push('PARITY OK ' + events.length + '/' + events.length + ' rounds, height ' + result.height);
  } else {
    out.push('PARITY FAIL ' + mismatches.length + '/' + events.length + ' rounds mismatch, height ' + result.height);
    if (failedCrossChecks.length > 0) {
      out.push(
        '            contract/replay disagreement on ' + failedCrossChecks.map(([field]) => field).join(', '),
      );
    }
  }
  console.log(out.join('\n'));
  return exitCode;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('\nverify failed: ' + error.message);
    process.exitCode = 2;
  });
