import assert from "node:assert/strict";
import test from "node:test";
import { fetchRounds } from "../lib/chain.js";

// keccak256("RoundRecorded(uint64,uint64,uint64,uint96,uint32,bytes32)")
const TOPIC = "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c";
const CORE = "0x0000000000000000000000000000000000000001";
const word = (value) => BigInt(value).toString(16).padStart(64, "0");

function roundLog(roundId, blockNumber, logIndex = 0) {
  return {
    address: CORE,
    topics: [TOPIC, "0x" + word(roundId)],
    data: "0x" + [25n, 60n, 123456789n, 10000n, 1n].map(word).join(""),
    blockNumber: "0x" + blockNumber.toString(16),
    logIndex: "0x" + logIndex.toString(16),
  };
}

test("fetchRounds ignores same-shaped unrelated events and preserves valid rounds", async (t) => {
  const valid = roundLog(45, 101);
  const uppercase = roundLog(46, 102);
  uppercase.topics[0] = "0x" + TOPIC.slice(2).toUpperCase();
  const unrelated = { ...valid, topics: ["0x" + "ab".repeat(32), valid.topics[1]] };
  const malformed = { ...valid, data: "0x" + "zz".repeat(160) };
  const requests = [];

  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    // Return an unrelated event even though the request asks for one topic, so
    // the client-side check is exercised independently of RPC filtering.
    return { ok: true, json: async () => ({ result: [unrelated, uppercase, malformed, valid] }) };
  });

  const rounds = await fetchRounds({ core: CORE, fromBlock: 100, toBlock: 110 });
  assert.deepEqual(rounds.map((round) => round.roundId), [45, 46]);
  assert.equal(rounds[0].work, 25n);
  assert.equal(rounds[0].cumulativeWork, 60n);
  assert.equal(rounds[0].cumulativeBlockUnits, 123456789n);
  assert.equal(rounds[0].difficulty, 10000n);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "eth_getLogs");
  assert.deepEqual(requests[0].params, [{
    address: CORE,
    fromBlock: "0x64",
    toBlock: "0x6e",
    topics: [TOPIC],
  }]);
});

test("fetchRounds keeps the event filter when reading more than one block range", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const block = Number.parseInt(request.params[0].fromBlock, 16);
    return { ok: true, json: async () => ({ result: [roundLog(block, block)] }) };
  });

  const rounds = await fetchRounds({ core: CORE, fromBlock: 1, toBlock: 5001 });
  assert.deepEqual(rounds.map((round) => round.roundId), [1, 5001]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.params[0].topics, [TOPIC]);
  }
});
