import assert from "node:assert/strict";
import test from "node:test";
import { ARCHIVE_TOPICS, validateEvidence } from "../lib/archive-core.js";
import { hash, makeEvidence, word } from "./fixtures/archive-fixture.mjs";

function replaceWord(log, index, value) {
  const words = log.data.slice(2).match(/.{64}/g);
  words[index] = word(value);
  log.data = "0x" + words.join("");
}

test("archive topics match the published Ethereum event signatures", () => {
  assert.equal(ARCHIVE_TOPICS.initialized, "0xac8b1a3b6325873fc2af5d6ca51d91e754518132f7876ac6d37efa2298d0e042");
  assert.equal(ARCHIVE_TOPICS.round, "0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c");
  assert.equal(ARCHIVE_TOPICS.batch, "0x66d3b3a53f97d0ca9c3e3df2d021d50358ee2110678472c2dd7ebd9e2834634d");
});

test("complete replay expands active, certified zero and uncertified unknown rounds", () => {
  const { rows, summary } = validateEvidence(makeEvidence());
  assert.deepEqual(rows.map(row => row.status), ["zero", "active", "zero", "zero", "zero", "unknown", "unknown", "unknown"]);
  assert.equal(rows[0].cumulativeWork, "0");
  assert.equal(rows[1].work, "80");
  assert.equal(rows[2].cumulativeWork, "80");
  assert.equal(rows[4].batchTransactionHash, hash(0xcccc));
  for (const row of rows.slice(5)) {
    assert.deepEqual(Object.values(row).slice(2), [null, null, null, null, null, null]);
  }
  assert.deepEqual(summary, {
    activeRounds: 1, zeroRounds: 4, unknownRounds: 3, settledThroughRound: "5",
    observedThroughRound: "8", batches: 2, blockHeight: "8", cumulativeWork: "80",
    cumulativeBlockUnits: "8000000000", difficulty: "9733",
  });
});

test("an all-zero ledger is certified only by its BatchSettled events", () => {
  const evidence = makeEvidence();
  evidence.logs.splice(1, 1);
  for (const log of evidence.logs.slice(1)) {
    replaceWord(log, 2, 0);
    replaceWord(log, 3, 0);
    replaceWord(log, 4, 0);
  }
  Object.assign(evidence.state, { cumulativeWork: "0", cumulativeBlockUnits: "0", blockHeight: "0", workPerThousandBlocks: "10000" });
  const result = validateEvidence(evidence);
  assert.equal(result.summary.activeRounds, 0);
  assert.equal(result.summary.zeroRounds, 5);
  assert.equal(result.rows[5].status, "unknown");
});

test("several active rounds share a batch and quiet work does not steer difficulty", () => {
  const evidence = makeEvidence();
  const quiet = structuredClone(evidence.logs[1]);
  quiet.logIndex = "0x1";
  quiet.topics[1] = hash(3);
  quiet.data = "0x" + [20, 100, 10054864892n, 9733, 0x1234].map(word).join("");
  evidence.logs[2].logIndex = "0x2";
  replaceWord(evidence.logs[2], 2, 2);
  for (const batch of evidence.logs.slice(2)) {
    replaceWord(batch, 3, 100);
    replaceWord(batch, 4, 10054864892n);
  }
  evidence.logs.splice(2, 0, quiet);
  Object.assign(evidence.state, { cumulativeWork: "100", cumulativeBlockUnits: "10054864892", blockHeight: "10", blockProgress: "54864892" });
  const { rows, summary } = validateEvidence(evidence);
  assert.equal(summary.activeRounds, 2);
  assert.equal(rows[2].difficulty, "9733");
  assert.equal(rows[2].cumulativeBlockUnits, "10054864892");
  assert.equal(rows[3].status, "zero");
  assert.equal(rows[3].cumulativeBlockUnits, "10054864892");
});

test("an initialized but unsettled ledger leaves every observed round unknown", () => {
  const evidence = makeEvidence();
  evidence.logs = evidence.logs.slice(0, 1);
  Object.assign(evidence.state, { settledThroughRound: "0", cumulativeWork: "0", cumulativeBlockUnits: "0", blockHeight: "0", blockProgress: "0", workPerThousandBlocks: "10000", authorizationNonce: "0", paused: true });
  const { rows, summary } = validateEvidence(evidence);
  assert.equal(summary.zeroRounds, 0);
  assert.equal(summary.unknownRounds, 8);
  assert.ok(rows.every(row => row.status === "unknown" && row.work === null));
});

test("missing working rounds, zero-work batches, or trailing batches cannot pass", () => {
  for (const index of [0, 1, 2, 3]) {
    const evidence = makeEvidence();
    evidence.logs.splice(index, 1);
    assert.throws(() => validateEvidence(evidence));
  }
  const evidence = makeEvidence();
  evidence.logs = evidence.logs.slice(0, 2);
  assert.throws(() => validateEvidence(evidence), /trailing BatchSettled/);
});

test("a missing intermediate frontier is rejected even when final totals agree", () => {
  const evidence = makeEvidence();
  replaceWord(evidence.logs[3], 1, 4);
  assert.throws(() => validateEvidence(evidence), /previous frontier/);
});

test("active rounds must settle in the same transaction and before their batch", () => {
  const differentTransaction = makeEvidence();
  differentTransaction.logs[2].transactionIndex = "0x1";
  differentTransaction.logs[2].transactionHash = hash(0x1234);
  assert.throws(() => validateEvidence(differentTransaction), /transaction/);
  const afterBatch = makeEvidence();
  [afterBatch.logs[1], afterBatch.logs[2]] = [afterBatch.logs[2], afterBatch.logs[1]];
  assert.throws(() => validateEvidence(afterBatch));
});

test("duplicate occurrences and inconsistent block hashes are rejected", () => {
  const duplicate = makeEvidence();
  duplicate.logs.splice(2, 0, structuredClone(duplicate.logs[1]));
  assert.throws(() => validateEvidence(duplicate), /duplicates/);
  const hashes = makeEvidence();
  hashes.logs[2].blockHash = hash(1234);
  assert.throws(() => validateEvidence(hashes), /block hash/);
});

test("malformed ABI, wrong emitter and removed logs are not silently discarded", () => {
  for (const mutate of [
    e => { e.logs[1].address = "0x" + "11".repeat(20); },
    e => { e.logs[1].topics[0] = hash(0x1234); },
    e => { e.logs[1].data += "00"; },
    e => { e.logs[1].removed = true; },
    e => { delete e.logs[1].removed; },
    e => { e.logs[1].transactionIndex = "0x00"; },
    e => { e.logs[1].topics[1] = hash(1n << 64n); },
  ]) {
    const evidence = makeEvidence();
    mutate(evidence);
    assert.throws(() => validateEvidence(evidence));
  }
});

test("work caps, nonzero work and data hashes are enforced before arithmetic", () => {
  for (const work of [0, 10001]) {
    const evidence = makeEvidence();
    replaceWord(evidence.logs[1], 0, work);
    assert.throws(() => validateEvidence(evidence), /cap or is zero/);
  }
  const evidence = makeEvidence();
  replaceWord(evidence.logs[1], 4, 0);
  assert.throws(() => validateEvidence(evidence), /data hash must not be zero/);
});

test("arithmetic and snapshot state mismatches cannot be repaired by resyncing", () => {
  for (const [field, value] of [[1, 81], [2, 8000000001n], [3, 9734]]) {
    const evidence = makeEvidence();
    replaceWord(evidence.logs[1], field, value);
    assert.throws(() => validateEvidence(evidence), /mismatch/);
  }
  for (const [field, value] of Object.entries({ cumulativeWork: "81", cumulativeBlockUnits: "8000000001", blockHeight: "9", blockProgress: "1", workPerThousandBlocks: "9734", authorizationNonce: "2" })) {
    const evidence = makeEvidence();
    evidence.state[field] = value;
    assert.throws(() => validateEvidence(evidence));
  }
});

test("initial evidence must agree with the configuration while live actors may change", () => {
  const evidence = makeEvidence();
  evidence.configuration.guardian = "0x" + "55".repeat(20);
  evidence.configuration.reporter = "0x" + "66".repeat(20);
  assert.equal(validateEvidence(evidence).summary.activeRounds, 1);
  evidence.configuration.initialWorkPerThousandBlocks = "10001";
  assert.throws(() => validateEvidence(evidence), /Initialized difficulty/);
});

test("the snapshot must be confirmed and cannot certify the current open round", () => {
  const shallow = makeEvidence();
  shallow.head.number = "121";
  assert.throws(() => validateEvidence(shallow), /confirmed deployment range/);
  const future = makeEvidence();
  future.snapshot.timestamp = (1700000000n + 4n * 600n).toString();
  assert.throws(() => validateEvidence(future), /unfinished round/);
  const wrongSnapshot = makeEvidence();
  wrongSnapshot.snapshot.number = "102";
  wrongSnapshot.snapshot.hash = hash(9999);
  assert.throws(() => validateEvidence(wrongSnapshot), /snapshot block hash/);
});

test("large expansion ranges are refused before allocating their rows", () => {
  const evidence = makeEvidence();
  evidence.snapshot.timestamp = (1700000000n + 100000n * 600n).toString();
  assert.throws(() => validateEvidence(evidence), /expansion limit/);
});
