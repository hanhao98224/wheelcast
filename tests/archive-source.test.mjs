import assert from "node:assert/strict";
import test from "node:test";
import { captureEvidence } from "../lib/archive-source.js";
import { ARCHIVE_TOPICS } from "../lib/archive-core.js";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const hash = (value) => "0x" + word(value);
const address = (value) => "0x" + BigInt(value).toString(16).padStart(40, "0");
const core = address(1);
const guardian = address(2);
const reporter = address(3);
const stream = hash(4);
const encode = (values) => "0x" + values.map(word).join("");
const configurationData = encode([4, 1000, 600, 10000, 16, 2, 3, 10000, 40, 30, 1000000000]);
const stateData = encode([3, 0, 0, 0, 0, 10000, 1, 0]);
const coreRecord = {
  identities: { core }, chain: { deploymentBlock: "90" },
  // These mutable API values must never replace the pinned RPC reads.
  configuration: { initialWorkPerThousandBlocks: "99999" },
  core: { settledThroughRound: "99999" },
};
const header = { number: "0x64", hash: hash(100), parentHash: hash(99), timestamp: "0xfa0" };

function logs() {
  return [
    {
      address: core, topics: [ARCHIVE_TOPICS.initialized, stream, hash(2), hash(3)],
      data: encode([1000, 10000, 10000]), blockNumber: "0x5a", blockHash: hash(90),
      transactionHash: hash(1000), transactionIndex: "0x0", logIndex: "0x0", removed: false,
    },
    {
      address: core, topics: [ARCHIVE_TOPICS.batch, hash(500), hash(3), hash(3)],
      data: encode([0, 0, 0, 0, 0]), blockNumber: "0x63", blockHash: hash(99),
      transactionHash: hash(1001), transactionIndex: "0x0", logIndex: "0x0", removed: false,
    },
  ];
}

function mockRpc(t, override = () => undefined) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    const call = { url, ...body };
    calls.push(call);
    const customized = override(call, calls);
    if (customized !== undefined) return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, ...customized }) };
    let result;
    if (body.method === "eth_chainId") result = "0xaa36a7";
    else if (body.method === "eth_blockNumber") result = "0x70";
    else if (body.method === "eth_getBlockByNumber") result = header;
    else if (body.method === "eth_call") {
      result = ({ "0x6c70bee9": configurationData, "0xc19d93fb": stateData, "0xe5900225": encode([3]) })[body.params[0].data];
    } else if (body.method === "eth_getLogs") {
      const range = body.params[0];
      result = logs().filter((log) => BigInt(log.blockNumber) >= BigInt(range.fromBlock) && BigInt(log.blockNumber) <= BigInt(range.toBlock));
    } else throw new Error("Unexpected RPC method: " + body.method);
    return { ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
  });
  return calls;
}

test("capture pins all contract reads and history to a block twelve confirmations behind head", async (t) => {
  const calls = mockRpc(t);
  const progress = [];
  const evidence = await captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"], onProgress: (event) => progress.push(event) });
  assert.deepEqual(evidence.snapshot, { number: "100", hash: hash(100), parentHash: hash(99), timestamp: "4000" });
  assert.deepEqual(evidence.head, { number: "112" });
  assert.equal(evidence.chainId, "11155111");
  assert.equal(evidence.confirmations, 12);
  assert.equal(evidence.configuration.initialWorkPerThousandBlocks, "10000");
  assert.equal(evidence.configuration.guardian, guardian);
  assert.equal(evidence.configuration.reporter, reporter);
  assert.equal(evidence.configuration.streamId, stream);
  assert.equal(evidence.state.settledThroughRound, "3");
  assert.equal(evidence.state.paused, false);
  assert.deepEqual(evidence.logs, logs());
  assert.equal(calls.filter((call) => call.method === "eth_getBlockByNumber").length, 2);
  for (const call of calls.filter((call) => call.method === "eth_call")) assert.equal(call.params[1], "0x64");
  const filter = calls.find((call) => call.method === "eth_getLogs").params[0];
  assert.deepEqual(filter.topics, [[ARCHIVE_TOPICS.initialized, ARCHIVE_TOPICS.round, ARCHIVE_TOPICS.batch]]);
  assert.equal(filter.toBlock, "0x64");
  assert.ok(progress.every((event) => typeof event.message === "string"));
});

test("capture rejects a snapshot whose block hash changes while history is read", async (t) => {
  mockRpc(t, (call, calls) => {
    if (call.method === "eth_getBlockByNumber" && calls.filter((entry) => entry.method === call.method).length > 1) {
      return { result: { ...header, hash: hash(101) } };
    }
  });
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /snapshot block changed/);
});

test("failed history pages never return a partial archive and the next endpoint starts from deployment", async (t) => {
  const calls = mockRpc(t, (call) => {
    if (call.url === "https://bad.example" && call.method === "eth_getLogs" && BigInt(call.params[0].fromBlock) >= 95n) {
      return { error: { code: 4444, message: "historical data pruned" } };
    }
  });
  const evidence = await captureEvidence({ coreRecord, rpcUrls: ["https://bad.example@5", "https://good.example@5"] });
  assert.deepEqual(evidence.logs, logs());
  assert.equal(calls.find((call) => call.url === "https://good.example" && call.method === "eth_getLogs").params[0].fromBlock, "0x5a");
});

test("capture fails closed when no endpoint can provide all history pages", async (t) => {
  mockRpc(t, (call) => call.method === "eth_getLogs" ? { error: { code: 4444, message: "historical data pruned" } } : undefined);
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /No partial archive was produced.*historical data pruned/);
});

test("capture shrinks oversized RPC ranges without omitting any blocks", async (t) => {
  const calls = mockRpc(t, (call) => {
    if (call.method === "eth_getLogs" && BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) >= 4n) {
      return { error: { code: -32005, message: "range too wide" } };
    }
  });
  const evidence = await captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example@10"] });
  assert.deepEqual(evidence.logs, logs());
  const successfulRanges = calls.filter((call) => call.method === "eth_getLogs" && BigInt(call.params[0].toBlock) - BigInt(call.params[0].fromBlock) < 4n);
  assert.equal(successfulRanges[0].params[0].fromBlock, "0x5a");
  assert.equal(successfulRanges.at(-1).params[0].toBlock, "0x64");
});

test("an empty RPC result cannot disguise missing initialization and batches", async (t) => {
  mockRpc(t, (call) => call.method === "eth_getLogs" ? { result: [] } : undefined);
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /No partial archive was produced/);
});

test("capture rejects wrong networks and insufficient confirmation requests", async (t) => {
  mockRpc(t, (call) => call.method === "eth_chainId" ? { result: "0x1" } : undefined);
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /not on the Sepolia network/);
  await assert.rejects(captureEvidence({ coreRecord, confirmations: 11 }), /at least 12 confirmations/);
});

test("capture refuses an unknown implementation version instead of guessing its ABI", async (t) => {
  mockRpc(t, (call) => call.method === "eth_call" && call.params[0].data === "0xe5900225" ? { result: encode([4]) } : undefined);
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /Only the published Core V3 ABI is supported/);
});

test("capture rejects malformed static ABI state rather than truncating or coercing it", async (t) => {
  mockRpc(t, (call) => call.method === "eth_call" && call.params[0].data === "0xc19d93fb"
    ? { result: encode([3, 0, 0, 0, 0, 10000, 1, 2]) } : undefined);
  await assert.rejects(captureEvidence({ coreRecord, rpcUrls: ["https://rpc.example"] }), /invalid paused flag/);
});
