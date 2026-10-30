/**
 * Wheelcast - data access.
 *
 * Two sources, both public and keyless:
 *   - the project's own JSON API (https://api.squeekchain.com/v1), used for
 *     live measurement and the current deployment identity;
 *   - a Sepolia JSON-RPC endpoint, used to read the settled round history
 *     straight from the contract.
 *
 * Nothing here is trusted blindly: addresses and the deployment block are read
 * from the API at runtime rather than hardcoded, so a redeployment shows up as
 * new data instead of a silently wrong chart.
 */

export const API_BASE = "https://api.squeekchain.com";

export const RPC_ENDPOINTS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.drpc.org",
  "https://1rpc.io/sepolia",
  "https://rpc.ankr.com/eth_sepolia",
  "https://ethereum-sepolia.public.blastapi.io",
  "https://sepolia.gateway.tenderly.co",
];

const ROUND_RECORDED_TOPIC = "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c";
const HEX_WORD = /^0x[0-9a-fA-F]{64}$/;

// Ignore caches populated before event-signature validation was introduced.
const CACHE_PREFIX = "wheelcast:rounds:v2:";
const CACHE_TTL_MS = 10 * 60 * 1000;

export class ChainError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ChainError";
    this.cause = cause;
  }
}

async function fetchJSON(url, { timeout = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new ChainError(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    if (err instanceof ChainError) throw err;
    throw new ChainError(`Could not reach ${url}`, err);
  } finally {
    clearTimeout(timer);
  }
}

export const getCore = () => fetchJSON(`${API_BASE}/v1/core`);
export const getStatus = () => fetchJSON(`${API_BASE}/v1/status`);
export const getSettlements = () => fetchJSON(`${API_BASE}/v1/settlements`);

/** Try each endpoint until one answers, remembering the one that worked. */
let preferredRpc = null;

async function rpc(method, params) {
  const order = preferredRpc
    ? [preferredRpc, ...RPC_ENDPOINTS.filter((u) => u !== preferredRpc)]
    : RPC_ENDPOINTS;
  let lastError = null;
  for (const url of order) {
    try {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
      preferredRpc = url;
      return json.result;
    } catch (err) {
      lastError = err;
    }
  }
  throw new ChainError("Every RPC endpoint failed", lastError);
}

export async function latestBlock() {
  const hex = await rpc("eth_blockNumber", []);
  return Number.parseInt(hex, 16);
}

/**
 * RoundRecorded(uint64 indexed roundId, uint64 work, uint64 cumulativeWork,
 * uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks, bytes32 dataHash)
 * => 2 topics, 5 data words.
 */
export function decodeRoundRecorded(log) {
  const data = log.data.slice(2);
  const word = (i) => data.slice(i * 64, (i + 1) * 64);
  return {
    roundId: Number(BigInt(log.topics[1])),
    work: BigInt(`0x${word(0)}`),
    cumulativeWork: BigInt(`0x${word(1)}`),
    cumulativeBlockUnits: BigInt(`0x${word(2)}`),
    difficulty: BigInt(`0x${word(3)}`),
    blockNumber: Number.parseInt(log.blockNumber, 16),
    logIndex: Number.parseInt(log.logIndex, 16),
  };
}

function isRoundRecorded(log) {
  if (!Array.isArray(log?.topics) || log.topics.length !== 2) return false;
  if (typeof log.topics[0] !== "string" || log.topics[0].toLowerCase() !== ROUND_RECORDED_TOPIC) return false;
  if (typeof log.topics[1] !== "string" || !HEX_WORD.test(log.topics[1])) return false;
  return typeof log.data === "string" && /^0x[0-9a-fA-F]{320}$/.test(log.data);
}

/**
 * Read every settled round from the deployment block to the chain head.
 *
 * The range is walked in chunks because public endpoints cap how much history a
 * single eth_getLogs may cover, and the chunk size is halved once if an endpoint
 * refuses the request outright.
 */
export async function fetchRounds({ core, fromBlock, toBlock, onProgress }) {
  const rounds = [];
  let step = 5000;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + step - 1, toBlock);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [
        {
          address: core,
          fromBlock: `0x${cursor.toString(16)}`,
          toBlock: `0x${end.toString(16)}`,
          topics: [ROUND_RECORDED_TOPIC],
        },
      ]);
    } catch (err) {
      if (step > 500) {
        step = Math.floor(step / 2);
        continue;
      }
      throw new ChainError(`Could not read logs for blocks ${cursor}-${end}`, err);
    }
    for (const log of logs) {
      if (isRoundRecorded(log)) rounds.push(decodeRoundRecorded(log));
    }
    if (onProgress) onProgress({ cursor, end, toBlock, found: rounds.length });
    cursor = end + 1;
  }
  rounds.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return rounds;
}

const toWire = (r) => [
  r.roundId,
  r.work.toString(),
  r.cumulativeWork.toString(),
  r.cumulativeBlockUnits.toString(),
  r.difficulty.toString(),
];
const fromWire = (a) => ({
  roundId: a[0],
  work: BigInt(a[1]),
  cumulativeWork: BigInt(a[2]),
  cumulativeBlockUnits: BigInt(a[3]),
  difficulty: BigInt(a[4]),
});

export function readCache(core, fromBlock) {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${core}:${fromBlock}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
    return { ...parsed, rounds: parsed.rounds.map(fromWire) };
  } catch {
    return null;
  }
}

export function writeCache(core, fromBlock, latest, rounds) {
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${core}:${fromBlock}`,
      JSON.stringify({ at: Date.now(), latest, rounds: rounds.map(toWire) }),
    );
  } catch {
    /* storage is a convenience, never a requirement */
  }
}

/** The deployment record the documentation publishes, for comparison. */
export const DOCS_DEPLOYMENT_URL = "https://docs.squeekchain.com/assets/deployments/sepolia.json";
export const getPublishedDeployment = () => fetchJSON(DOCS_DEPLOYMENT_URL, { timeout: 15000 });


/** The ABIs the documentation publishes, for comparison with live logs. */
export const DOCS_ABI_BASE = "https://docs.squeekchain.com/assets/abi/";
export const getPublishedAbi = (name) => fetchJSON(DOCS_ABI_BASE + name + ".json", { timeout: 15000 });

/** Count how often each topic appears in a contract's logs over a block range. */
export async function fetchTopicCounts({ address, fromBlock, toBlock }) {
  const counts = new Map();
  if (!address || !Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) return counts;
  let step = 5000;
  let cursor = fromBlock;
  while (cursor <= toBlock) {
    const end = Math.min(cursor + step - 1, toBlock);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [
        { address, fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + end.toString(16) },
      ]);
    } catch (err) {
      if (step > 500) {
        step = Math.floor(step / 2);
        continue;
      }
      throw new ChainError("Could not read logs for " + address, err);
    }
    for (const log of logs) counts.set(log.topics[0], (counts.get(log.topics[0]) || 0) + 1);
    cursor = end + 1;
  }
  return counts;
}
