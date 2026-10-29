import { ARCHIVE_TOPICS } from "../../lib/archive-core.js";

export const word = (value) => BigInt(value).toString(16).padStart(64, "0");
export const hash = (value) => "0x" + word(value);
const address = (value) => "0x" + BigInt(value).toString(16).padStart(40, "0");
const quantity = (value) => "0x" + BigInt(value).toString(16);

/** Two settled spans: rounds 1..3 (round 2 active), then zero-work rounds 4..5.
 * Snapshot time has elapsed through round 7, and round 8 is open. Neither the
 * elapsed unknown rounds nor the open unknown round may be exported as zero.
 */
export function makeEvidence() {
  const core = address(0x4444);
  const guardian = address(0x2222);
  const reporter = address(0x3333);
  const genesis = 1700000000n;
  const log = (block, logIndex, transactionHash, topics, values) => ({
    address: core,
    blockNumber: quantity(block),
    blockHash: hash(block),
    transactionIndex: "0x0",
    transactionHash: hash(transactionHash),
    logIndex: quantity(logIndex),
    topics,
    data: "0x" + values.map(word).join(""),
    removed: false,
  });
  return {
    schemaVersion: 1,
    chainId: "11155111",
    core,
    deploymentBlock: "100",
    head: { number: "122" },
    snapshot: { number: "110", hash: hash(110), parentHash: hash(109), timestamp: (genesis + 7n * 600n + 123n).toString() },
    confirmations: 12,
    configuration: {
      streamId: hash(0x1111), genesisTimestamp: genesis.toString(), roundDuration: "600",
      maxWorkPerRound: "10000", maxRoundsPerBatch: "16", guardian, reporter,
      initialWorkPerThousandBlocks: "10000", targetBlocksPerActiveRound: "40",
      difficultySmoothingRounds: "30", blockUnitsPerBlock: "1000000000",
    },
    state: {
      settledThroughRound: "5", cumulativeWork: "80", cumulativeBlockUnits: "8000000000",
      blockHeight: "8", blockProgress: "0", workPerThousandBlocks: "9733", authorizationNonce: "3", paused: false,
    },
    logs: [
      log(100, 0, 0xaaaa, [ARCHIVE_TOPICS.initialized, hash(0x1111), hash(0x2222), hash(0x3333)], [genesis, 10000, 10000]),
      log(101, 0, 0xbbbb, [ARCHIVE_TOPICS.round, hash(2)], [80, 80, 8000000000n, 9733, 0xdddd]),
      log(101, 1, 0xbbbb, [ARCHIVE_TOPICS.batch, hash(0xeeee), hash(0x3333), hash(3)], [1, 0, 1, 80, 8000000000n]),
      log(102, 0, 0xcccc, [ARCHIVE_TOPICS.batch, hash(0xffff), hash(0x3333), hash(5)], [2, 3, 0, 80, 8000000000n]),
    ],
  };
}
