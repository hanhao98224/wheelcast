/** Capture one complete, confirmed Core snapshot using public read-only RPCs. */
import { ARCHIVE_TOPICS, validateEvidence } from "./archive-core.js";

export const DEFAULT_ARCHIVE_RPCS = [
  "https://sepolia.gateway.tenderly.co",
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
];

// First four bytes of Ethereum keccak256 of the published V3 function signatures.
const SELECTORS = {
  configuration: "0x6c70bee9", // configuration()
  state: "0xc19d93fb", // state()
  version: "0xe5900225", // implementationCodeVersion()
};
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const MAX_LOGS = 100000;
const MAX_BLOCK_SPAN = 2000000n;
const TIMEOUT_MS = 12000;

function quantity(value, label) {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("RPC returned an invalid " + label);
  return BigInt(value);
}

function decimal(value, label) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("Missing or invalid " + label);
  return value;
}

function hex(value) { return "0x" + value.toString(16); }

function decodeWords(data, count, label) {
  if (typeof data !== "string" || !new RegExp("^0x[0-9a-f]{" + count * 64 + "}$", "i").test(data)) {
    throw new Error("RPC returned an unsupported " + label + " response");
  }
  return Array.from({ length: count }, (_, index) => data.slice(2 + index * 64, 66 + index * 64));
}

function uint(word, bits, label) {
  const value = BigInt("0x" + word);
  if (value >= 1n << BigInt(bits)) throw new Error("RPC returned an out-of-range " + label);
  return value.toString();
}

function addressWord(word, label) {
  if (!/^0{24}[0-9a-f]{40}$/i.test(word)) throw new Error("RPC returned an invalid " + label);
  return "0x" + word.slice(24).toLowerCase();
}

function configuration(data) {
  const w = decodeWords(data, 11, "Core V3 configuration");
  const result = {
    streamId: "0x" + w[0].toLowerCase(),
    genesisTimestamp: uint(w[1], 64, "genesis timestamp"),
    roundDuration: uint(w[2], 64, "round duration"),
    maxWorkPerRound: uint(w[3], 64, "work cap"),
    maxRoundsPerBatch: uint(w[4], 16, "batch cap"),
    guardian: addressWord(w[5], "guardian"),
    reporter: addressWord(w[6], "reporter"),
    initialWorkPerThousandBlocks: uint(w[7], 32, "initial difficulty"),
    targetBlocksPerActiveRound: uint(w[8], 64, "target block count"),
    difficultySmoothingRounds: uint(w[9], 64, "difficulty smoothing"),
    blockUnitsPerBlock: uint(w[10], 96, "block units per block"),
  };
  if (result.roundDuration !== "600" || result.targetBlocksPerActiveRound !== "40" ||
      result.difficultySmoothingRounds !== "30" || result.blockUnitsPerBlock !== "1000000000") {
    throw new Error("This archive reader does not support the deployment's Core rules");
  }
  return result;
}

function state(data) {
  const w = decodeWords(data, 8, "Core V3 state");
  const paused = uint(w[7], 8, "paused flag");
  if (paused !== "0" && paused !== "1") throw new Error("RPC returned an invalid paused flag");
  return {
    settledThroughRound: uint(w[0], 64, "certified frontier"),
    cumulativeWork: uint(w[1], 64, "cumulative work"),
    cumulativeBlockUnits: uint(w[2], 96, "cumulative block units"),
    blockHeight: uint(w[3], 64, "block height"),
    blockProgress: uint(w[4], 96, "block progress"),
    workPerThousandBlocks: uint(w[5], 32, "difficulty"),
    authorizationNonce: uint(w[6], 256, "authorization nonce"),
    paused: paused === "1",
  };
}

async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("RPC request failed with HTTP " + response.status);
  const body = await response.json();
  if (!body || body.error || body.result == null) {
    const error = new Error(body?.error?.message || "RPC returned no result for " + method);
    error.pruned = body?.error?.code === 4444 || /prun|historical.*unavailable|archive.*required/i.test(error.message);
    throw error;
  }
  return body.result;
}

function blockHeader(raw, expected) {
  if (!raw || quantity(raw.number, "block number") !== expected || !HASH.test(raw.hash) || !HASH.test(raw.parentHash)) {
    throw new Error("RPC returned an invalid snapshot block header");
  }
  return {
    number: expected.toString(),
    hash: raw.hash.toLowerCase(),
    parentHash: raw.parentHash.toLowerCase(),
    timestamp: quantity(raw.timestamp, "block timestamp").toString(),
  };
}

function endpoint(entry) {
  if (typeof entry !== "string") throw new Error("RPC endpoints must be URLs");
  const match = entry.match(/^(.*)@(\d+)$/);
  const url = match ? match[1] : entry;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Unsupported RPC URL protocol");
  const maxRange = match ? Number(match[2]) : 5000;
  if (!Number.isSafeInteger(maxRange) || maxRange < 1 || maxRange > 20000) throw new Error("Invalid RPC block range");
  return { url, maxRange };
}

function compareLogs(a, b) {
  for (const key of ["blockNumber", "transactionIndex", "logIndex"]) {
    const av = quantity(a[key], key);
    const bv = quantity(b[key], key);
    if (av !== bv) return av < bv ? -1 : 1;
  }
  return 0;
}

/**
 * Discovery uses the public API's address and deployment block only. Configuration,
 * state and event history all come from one RPC and the same confirmed block.
 * A failed page, unsupported ABI or changed snapshot rejects the whole capture.
 */
export async function captureEvidence({ coreRecord, rpcUrls = DEFAULT_ARCHIVE_RPCS, confirmations = 12, onProgress = () => {} }) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 12 || confirmations > 2048) {
    throw new Error("Archive snapshots require at least 12 confirmations (maximum 2048)");
  }
  const core = coreRecord?.identities?.core;
  if (typeof core !== "string" || !ADDRESS.test(core) || /^0x0{40}$/i.test(core)) throw new Error("The API did not identify a Core contract");
  const deploymentBlock = decimal(coreRecord?.chain?.deploymentBlock, "Core deployment block");
  if (!Array.isArray(rpcUrls) || rpcUrls.length === 0 || rpcUrls.length > 10) throw new Error("Provide between one and ten public RPC endpoints");
  const endpoints = rpcUrls.map(endpoint);
  const errors = [];
  for (let index = 0; index < endpoints.length; index++) {
    const { url, maxRange } = endpoints[index];
    try {
      onProgress({ stage: "snapshot", message: "Reading a confirmed Core snapshot (RPC " + (index + 1) + "/" + endpoints.length + ")…" });
      if (quantity(await rpc(url, "eth_chainId", []), "chain ID") !== 11155111n) throw new Error("RPC is not on the Sepolia network");
      const head = quantity(await rpc(url, "eth_blockNumber", []), "chain head");
      const snapshotNumber = head - BigInt(confirmations);
      const fromBlock = BigInt(deploymentBlock);
      if (snapshotNumber < fromBlock) throw new Error("The Core deployment does not yet have enough confirmations");
      if (snapshotNumber - fromBlock > MAX_BLOCK_SPAN) throw new Error("The deployment history exceeds this archive reader's supported block span");
      const block = hex(snapshotNumber);
      const snapshot = blockHeader(await rpc(url, "eth_getBlockByNumber", [block, false]), snapshotNumber);
      const read = (data) => rpc(url, "eth_call", [{ to: core.toLowerCase(), data }, block]);
      const [configData, stateData, versionData] = await Promise.all([
        read(SELECTORS.configuration), read(SELECTORS.state), read(SELECTORS.version),
      ]);
      const version = uint(decodeWords(versionData, 1, "Core version")[0], 64, "Core version");
      if (version !== "3") throw new Error("Only the published Core V3 ABI is supported");
      const config = configuration(configData);
      const ledger = state(stateData);
      const logs = [];
      let step = BigInt(maxRange);
      let cursor = fromBlock;
      while (cursor <= snapshotNumber) {
        const end = cursor + step - 1n < snapshotNumber ? cursor + step - 1n : snapshotNumber;
        let page;
        try {
          page = await rpc(url, "eth_getLogs", [{
            address: core.toLowerCase(), fromBlock: hex(cursor), toBlock: hex(end),
            topics: [[ARCHIVE_TOPICS.initialized, ARCHIVE_TOPICS.round, ARCHIVE_TOPICS.batch]],
          }]);
        } catch (error) {
          if (error.pruned || step === 1n) throw error;
          step = step / 2n || 1n;
          continue;
        }
        if (!Array.isArray(page) || page.length > MAX_LOGS || logs.length + page.length > MAX_LOGS) throw new Error("RPC returned an invalid or oversized event page");
        for (const log of page) {
          // A server must not satisfy a range request with records outside it.
          const number = quantity(log?.blockNumber, "event block number");
          if (number < cursor || number > end) throw new Error("RPC returned an event outside the requested block range");
        }
        logs.push(...page);
        onProgress({ stage: "logs", fromBlock: cursor.toString(), toBlock: end.toString(), found: logs.length,
          message: "Read blocks " + cursor + "–" + end + ": " + logs.length + " Core records" });
        cursor = end + 1n;
      }
      logs.sort(compareLogs);
      const finalHeader = blockHeader(await rpc(url, "eth_getBlockByNumber", [block, false]), snapshotNumber);
      if (JSON.stringify(finalHeader) !== JSON.stringify(snapshot)) throw new Error("The snapshot block changed during capture; retry after the chain stabilizes");
      const evidence = {
        schemaVersion: 1, chainId: "11155111", core: core.toLowerCase(), deploymentBlock,
        head: { number: head.toString() }, snapshot, confirmations, configuration: config, state: ledger, logs,
      };
      validateEvidence(evidence);
      onProgress({ stage: "complete", message: "Complete confirmed Core history captured and checked" });
      return evidence;
    } catch (error) {
      errors.push(error?.message || String(error));
      if (index + 1 < endpoints.length) onProgress({ stage: "retry", message: "This RPC could not provide a complete snapshot; trying another public RPC…" });
    }
  }
  throw new Error("Could not capture a complete confirmed Core history. No partial archive was produced. " + errors.at(-1));
}
