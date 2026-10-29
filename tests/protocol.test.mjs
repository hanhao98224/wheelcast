import assert from "node:assert/strict";
import test from "node:test";
import { recoverPriorDifficulty, replay } from "../lib/protocol.js";

test("a recorded round agrees with its configured starting difficulty", () => {
  const round = { roundId: 1, work: 260n, cumulativeWork: 260n,
    cumulativeBlockUnits: 26_000_000_000n, difficulty: 9883n };
  assert.deepEqual(recoverPriorDifficulty(round.work, round.difficulty), { low: 10000n, high: 10000n });
  assert.equal(replay([round], 10000n).ok, true);
  // Replaying from a recovered replacement would incorrectly conceal this mismatch.
  assert.equal(replay([round], 11000n).ok, false);
});

test("rounding admits an interval and preserves a valid non-lowest initial value", () => {
  assert.deepEqual(recoverPriorDifficulty(40n, 1000n), { low: 1000n, high: 1001n });
  assert.equal(replay([{ roundId: 1, work: 40n, cumulativeWork: 40n,
    cumulativeBlockUnits: 39_960_039_960n, difficulty: 1000n }], 1001n).ok, true);
});

test("quiet rounds preserve the initial difficulty exactly", () => {
  assert.deepEqual(recoverPriorDifficulty(39n, 10000n), { low: 10000n, high: 10000n });
});

test("impossible emitted difficulties cannot provide a valid recovery", () => {
  assert.equal(recoverPriorDifficulty(260n, 999n), null);
  assert.equal(recoverPriorDifficulty(10000n, 1000n), null);
});
