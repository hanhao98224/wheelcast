/**
 * Replays the Core evidence contained in a Wheelcast archive. This module has
 * no network or filesystem access; it checks the supplied record, not Ethereum
 * consensus, receipt inclusion, Reporter signatures or physical measurements.
 */

export const ARCHIVE_TOPICS = Object.freeze({
  initialized: "0xac8b1a3b6325873fc2af5d6ca51d91e754518132f7876ac6d37efa2298d0e042",
  round: "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c",
  batch: "0x66d3b3a53f97d0ca9c3e3df2d021d50358ee2110678472c2dd7ebd9e2834634d",
});

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO_HASH = "0x" + "0".repeat(64);
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const MAX_ROUNDS = 100_000n;
const MAX_LOGS = 100_000;
const BLOCK_SCALE = 1_000_000_000_000n;
const BLOCK_UNITS = 1_000_000_000n;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function uint(value, bits, label) {
  requireValue(typeof value === "string" && value.length <= 78 && DECIMAL.test(value), `${label} must be an unsigned decimal string`);
  const parsed = BigInt(value);
  requireValue(parsed < (1n << BigInt(bits)), `${label} exceeds uint${bits}`);
  return parsed;
}

function quantity(value, bits, label) {
  requireValue(typeof value === "string" && value.length <= 66 && QUANTITY.test(value), `${label} must be a canonical RPC quantity`);
  const parsed = BigInt(value);
  requireValue(parsed < (1n << BigInt(bits)), `${label} exceeds uint${bits}`);
  return parsed;
}

function hash(value, label, allowZero = false) {
  requireValue(typeof value === "string" && HASH.test(value), `${label} must be a 32-byte hash`);
  const normalized = value.toLowerCase();
  requireValue(allowZero || normalized !== ZERO_HASH, `${label} must not be zero`);
  return normalized;
}

function address(value, label) {
  requireValue(typeof value === "string" && ADDRESS.test(value), `${label} must be an address`);
  const normalized = value.toLowerCase();
  requireValue(normalized !== ZERO_ADDRESS, `${label} must not be zero`);
  return normalized;
}

function wordUint(word, bits, label) {
  const parsed = BigInt("0x" + word);
  requireValue(parsed < (1n << BigInt(bits)), `${label} exceeds uint${bits}`);
  return parsed;
}

function topicUint(topic, bits, label) {
  return wordUint(topic.slice(2), bits, label);
}

function topicAddress(topic, label) {
  requireValue(/^0x0{24}[0-9a-fA-F]{40}$/.test(topic), `${label} has invalid address padding`);
  return address("0x" + topic.slice(-40), label);
}

function eventWords(log, topicCount, wordCount, label) {
  requireValue(log.topics.length === topicCount, `${label} has the wrong topic count`);
  requireValue(typeof log.data === "string" && log.data.length === 2 + 64 * wordCount && /^0x[0-9a-fA-F]+$/.test(log.data), `${label} has invalid ABI data`);
  return Array.from({ length: wordCount }, (_, i) => log.data.slice(2 + i * 64, 2 + (i + 1) * 64));
}

function same(actual, expected, label) {
  requireValue(actual === expected, `${label} mismatch: expected ${expected}, got ${actual}`);
}

/**
 * Validate a version-1 evidence object and expand rounds 1..the open round at
 * the fixed snapshot. Only BatchSettled certifies an omitted round as zero.
 * Uncertified rounds have null data, including already elapsed unknown rounds.
 */
export function validateEvidence(evidence) {
  requireValue(evidence && typeof evidence === "object", "Evidence must be an object");
  same(evidence.schemaVersion, 1, "Evidence schema version");
  same(uint(evidence.chainId, 256, "chainId"), 11155111n, "Sepolia chain ID");
  const core = address(evidence.core, "core");
  const deploymentBlock = uint(evidence.deploymentBlock, 64, "deploymentBlock");
  const headNumber = uint(evidence.head?.number, 64, "head.number");
  const snapshotNumber = uint(evidence.snapshot?.number, 64, "snapshot.number");
  const snapshotHash = hash(evidence.snapshot?.hash, "snapshot.hash");
  hash(evidence.snapshot?.parentHash, "snapshot.parentHash", snapshotNumber === 0n);
  const timestamp = uint(evidence.snapshot?.timestamp, 64, "snapshot.timestamp");
  requireValue(Number.isSafeInteger(evidence.confirmations) && evidence.confirmations >= 12 && evidence.confirmations <= 1_000_000, "At least 12 confirmations are required");
  requireValue(snapshotNumber >= deploymentBlock && headNumber >= snapshotNumber + BigInt(evidence.confirmations), "Snapshot block is outside the confirmed deployment range");

  const cfg = evidence.configuration;
  requireValue(cfg && typeof cfg === "object", "Missing Core configuration");
  const streamId = hash(cfg.streamId, "configuration.streamId");
  const genesis = uint(cfg.genesisTimestamp, 64, "configuration.genesisTimestamp");
  const duration = uint(cfg.roundDuration, 64, "configuration.roundDuration");
  const cap = uint(cfg.maxWorkPerRound, 64, "configuration.maxWorkPerRound");
  const maxBatch = uint(cfg.maxRoundsPerBatch, 16, "configuration.maxRoundsPerBatch");
  const initial = uint(cfg.initialWorkPerThousandBlocks, 32, "configuration.initialWorkPerThousandBlocks");
  address(cfg.guardian, "configuration.guardian");
  address(cfg.reporter, "configuration.reporter");
  same(duration, 600n, "Supported round duration");
  same(uint(cfg.targetBlocksPerActiveRound, 64, "configuration.targetBlocksPerActiveRound"), 40n, "Supported difficulty target");
  same(uint(cfg.difficultySmoothingRounds, 64, "configuration.difficultySmoothingRounds"), 30n, "Supported difficulty smoothing");
  same(uint(cfg.blockUnitsPerBlock, 96, "configuration.blockUnitsPerBlock"), BLOCK_UNITS, "Supported block units");
  requireValue(genesis > 0n && initial >= 1000n && cap > 0n && cap <= 10000n && maxBatch > 0n && maxBatch <= 16n, "Unsupported Core launch configuration");

  const state = evidence.state;
  requireValue(state && typeof state === "object", "Missing Core state");
  const stateFrontier = uint(state.settledThroughRound, 64, "state.settledThroughRound");
  const stateWork = uint(state.cumulativeWork, 64, "state.cumulativeWork");
  const stateUnits = uint(state.cumulativeBlockUnits, 96, "state.cumulativeBlockUnits");
  const stateHeight = uint(state.blockHeight, 64, "state.blockHeight");
  const stateProgress = uint(state.blockProgress, 96, "state.blockProgress");
  const stateDifficulty = uint(state.workPerThousandBlocks, 32, "state.workPerThousandBlocks");
  const stateNonce = uint(state.authorizationNonce, 256, "state.authorizationNonce");
  requireValue(typeof state.paused === "boolean", "state.paused must be boolean");
  const elapsed = timestamp >= genesis ? (timestamp - genesis) / duration : 0n;
  const observed = timestamp >= genesis ? elapsed + 1n : 0n;
  requireValue(observed <= MAX_ROUNDS, `Archive exceeds the ${MAX_ROUNDS}-round expansion limit`);
  requireValue(stateFrontier <= elapsed, "The certified frontier includes an unfinished round");
  requireValue(Array.isArray(evidence.logs) && evidence.logs.length <= MAX_LOGS, `Evidence must contain at most ${MAX_LOGS} logs`);

  let initialized = false;
  let frontier = 0n;
  let cumulativeWork = 0n;
  let units = 0n;
  let difficulty = initial;
  let lastNonce = null;
  let previous = null;
  let pending = [];
  const active = new Map();
  const batches = [];
  const blockHashes = new Map();
  const transactionHashes = new Map();
  const transactionLocations = new Map();
  const occurrences = new Set();

  for (const [index, log] of evidence.logs.entries()) {
    const label = `Log ${index}`;
    requireValue(log && typeof log === "object", `${label} must be an object`);
    same(address(log.address, `${label}.address`), core, `${label} emitter`);
    requireValue(log.removed === false, `${label} must explicitly be canonical (removed=false)`);
    requireValue(Array.isArray(log.topics) && log.topics.length > 0 && log.topics.length <= 4, `${label} has invalid topics`);
    const topics = log.topics.map((topic, i) => hash(topic, `${label}.topics[${i}]`, true));
    const block = quantity(log.blockNumber, 64, `${label}.blockNumber`);
    const transaction = quantity(log.transactionIndex, 32, `${label}.transactionIndex`);
    const logIndex = quantity(log.logIndex, 32, `${label}.logIndex`);
    const blockHash = hash(log.blockHash, `${label}.blockHash`);
    const transactionHash = hash(log.transactionHash, `${label}.transactionHash`);
    requireValue(block >= deploymentBlock && block <= snapshotNumber, `${label} is outside the captured block range`);
    if (block === snapshotNumber) same(blockHash, snapshotHash, `${label} snapshot block hash`);
    const blockKey = block.toString();
    if (blockHashes.has(blockKey)) same(blockHashes.get(blockKey), blockHash, `${label} block hash`);
    blockHashes.set(blockKey, blockHash);
    const transactionKey = `${block}:${transaction}`;
    if (transactionHashes.has(transactionKey)) same(transactionHashes.get(transactionKey), transactionHash, `${label} transaction hash`);
    transactionHashes.set(transactionKey, transactionHash);
    if (transactionLocations.has(transactionHash)) same(transactionLocations.get(transactionHash), transactionKey, `${label} transaction location`);
    transactionLocations.set(transactionHash, transactionKey);
    const occurrence = `${blockHash}:${transactionHash}:${logIndex}`;
    requireValue(!occurrences.has(occurrence), `${label} duplicates a log occurrence`);
    occurrences.add(occurrence);
    if (previous) {
      requireValue(block > previous.block || (block === previous.block && transaction >= previous.transaction && logIndex > previous.logIndex), `${label} is out of block/transaction/log order`);
    }
    previous = { block, transaction, logIndex };

    if (topics[0] === ARCHIVE_TOPICS.initialized) {
      requireValue(!initialized && index === 0, "CoreInitialized must occur exactly once, before settlement logs");
      same(block, deploymentBlock, "CoreInitialized deployment block");
      const words = eventWords(log, 4, 3, "CoreInitialized");
      same(topics[1], streamId, "Initialized stream");
      topicAddress(topics[2], "Initialized Guardian");
      topicAddress(topics[3], "Initialized Reporter");
      same(wordUint(words[0], 64, "Initialized genesis"), genesis, "Initialized genesis");
      same(wordUint(words[1], 32, "Initialized difficulty"), initial, "Initialized difficulty");
      same(wordUint(words[2], 64, "Initialized work cap"), cap, "Initialized work cap");
      initialized = true;
      continue;
    }

    requireValue(initialized, "Settlement evidence is missing CoreInitialized");
    if (topics[0] === ARCHIVE_TOPICS.round) {
      const words = eventWords(log, 2, 5, "RoundRecorded");
      const roundId = topicUint(topics[1], 64, "RoundRecorded round ID");
      const work = wordUint(words[0], 64, "RoundRecorded work");
      const emittedWork = wordUint(words[1], 64, "RoundRecorded cumulative work");
      const emittedUnits = wordUint(words[2], 96, "RoundRecorded block units");
      const emittedDifficulty = wordUint(words[3], 32, "RoundRecorded difficulty");
      const dataHash = hash("0x" + words[4], "RoundRecorded data hash");
      requireValue(work > 0n && work <= cap, `Round ${roundId} work exceeds the cap or is zero`);
      requireValue(roundId > frontier && roundId <= elapsed, `Round ${roundId} is already settled or unfinished`);
      if (pending.length) {
        same(pending[0].transactionKey, transactionKey, "Unclosed settlement transaction");
        requireValue(roundId > pending[pending.length - 1].roundId, "Round IDs must increase within a batch");
      }
      requireValue(!active.has(roundId.toString()), `Round ${roundId} is duplicated`);
      requireValue(BigInt(pending.length) < maxBatch, "Settlement exceeds its active-round limit");
      cumulativeWork += work;
      units += work * BLOCK_SCALE / difficulty;
      if (work >= 40n) difficulty = (29n * difficulty + work * 1000n / 40n) / 30n;
      same(emittedWork, cumulativeWork, `Round ${roundId} cumulative work`);
      same(emittedUnits, units, `Round ${roundId} block units`);
      same(emittedDifficulty, difficulty, `Round ${roundId} difficulty`);
      const record = { roundId, transactionKey, work: work.toString(), cumulativeWork: cumulativeWork.toString(), cumulativeBlockUnits: units.toString(), difficulty: difficulty.toString(), dataHash, batchTransactionHash: null };
      pending.push(record);
      active.set(roundId.toString(), record);
      continue;
    }

    requireValue(topics[0] === ARCHIVE_TOPICS.batch, `${label} is not a supported Core evidence event`);
    const words = eventWords(log, 4, 5, "BatchSettled");
    hash(topics[1], "BatchSettled digest");
    topicAddress(topics[2], "BatchSettled Reporter");
    const through = topicUint(topics[3], 64, "BatchSettled frontier");
    const nonce = wordUint(words[0], 256, "BatchSettled nonce");
    const before = wordUint(words[1], 64, "BatchSettled previous frontier");
    const count = wordUint(words[2], 16, "BatchSettled active count");
    const emittedWork = wordUint(words[3], 64, "BatchSettled cumulative work");
    const emittedUnits = wordUint(words[4], 96, "BatchSettled block units");
    same(before, frontier, "BatchSettled previous frontier");
    requireValue(through > frontier && through <= elapsed, "BatchSettled must advance to an ended round");
    same(count, BigInt(pending.length), "BatchSettled active-round count");
    requireValue(count <= maxBatch, "BatchSettled exceeds its active-round limit");
    requireValue(lastNonce === null || nonce > lastNonce, "BatchSettled nonces must increase");
    for (const record of pending) {
      same(record.transactionKey, transactionKey, "BatchSettled transaction");
      requireValue(record.roundId <= through, "Recorded round lies past its BatchSettled frontier");
      record.batchTransactionHash = transactionHash;
    }
    same(emittedWork, cumulativeWork, "BatchSettled cumulative work");
    same(emittedUnits, units, "BatchSettled block units");
    batches.push({ before: frontier, through, transactionHash });
    frontier = through;
    lastNonce = nonce;
    pending = [];
  }

  requireValue(initialized, "Evidence is missing CoreInitialized");
  requireValue(pending.length === 0, "Recorded rounds are missing their trailing BatchSettled");
  same(frontier, stateFrontier, "Final certified frontier");
  same(cumulativeWork, stateWork, "Final cumulative work");
  same(units, stateUnits, "Final block units");
  same(difficulty, stateDifficulty, "Final difficulty");
  same(units / BLOCK_UNITS, stateHeight, "Final block height");
  same(units % BLOCK_UNITS, stateProgress, "Final block progress");
  requireValue(lastNonce === null || stateNonce > lastNonce, "State nonce has not consumed the final settlement");

  const rows = [];
  let batchIndex = 0;
  let rowWork = "0";
  let rowUnits = "0";
  let rowDifficulty = initial.toString();
  for (let roundId = 1n; roundId <= observed; roundId++) {
    const id = roundId.toString();
    if (roundId > frontier) {
      rows.push({ roundId: id, status: "unknown", work: null, cumulativeWork: null, cumulativeBlockUnits: null, difficulty: null, dataHash: null, batchTransactionHash: null });
      continue;
    }
    while (batches[batchIndex].through < roundId) batchIndex++;
    const record = active.get(id);
    if (record) {
      rowWork = record.cumulativeWork;
      rowUnits = record.cumulativeBlockUnits;
      rowDifficulty = record.difficulty;
      rows.push({ roundId: id, status: "active", work: record.work, cumulativeWork: rowWork, cumulativeBlockUnits: rowUnits, difficulty: rowDifficulty, dataHash: record.dataHash, batchTransactionHash: record.batchTransactionHash });
    } else {
      rows.push({ roundId: id, status: "zero", work: "0", cumulativeWork: rowWork, cumulativeBlockUnits: rowUnits, difficulty: rowDifficulty, dataHash: null, batchTransactionHash: batches[batchIndex].transactionHash });
    }
  }

  return {
    rows,
    summary: {
      activeRounds: active.size,
      zeroRounds: Number(frontier) - active.size,
      unknownRounds: Number(observed - frontier),
      settledThroughRound: frontier.toString(),
      observedThroughRound: observed.toString(),
      batches: batches.length,
      blockHeight: stateHeight.toString(),
      cumulativeWork: cumulativeWork.toString(),
      cumulativeBlockUnits: units.toString(),
      difficulty: difficulty.toString(),
    },
  };
}
