/**
 * Wheelcast - Squeekchain protocol math.
 *
 * Every rule here is transcribed from the published whitepaper
 * (https://docs.squeekchain.com/whitepaper.md). Integer arithmetic only:
 * the paper states that its integer expressions *are* the definition, so any
 * float shortcut is a bug.
 */

export const BLOCK_UNITS_PER_BLOCK = 1_000_000_000n;
export const BLOCK_UNITS_SCALE = 1_000_000_000_000n; // 10^12
export const TARGET_BLOCKS_PER_ACTIVE_ROUND = 40n;
export const SMOOTHING = 30n;
export const MIN_DIFFICULTY = 1_000n;

/** One round's contribution to the block-unit counter. */
export function roundBlockUnits(work, difficulty) {
  return (work * BLOCK_UNITS_SCALE) / difficulty;
}

/** Difficulty after a round. Rounds under 40 work leave it untouched. */
export function nextDifficulty(work, difficulty) {
  if (work < TARGET_BLOCKS_PER_ACTIVE_ROUND) return difficulty;
  const target = (work * 1_000n) / TARGET_BLOCKS_PER_ACTIVE_ROUND;
  return (29n * difficulty + target) / SMOOTHING;
}

/** Block height implied by a cumulative block-unit total. */
export function heightOf(cumulativeBlockUnits) {
  return cumulativeBlockUnits / BLOCK_UNITS_PER_BLOCK;
}

/** Progress into the block currently being built, in [0, 1e9). */
export function blockProgress(cumulativeBlockUnits) {
  return cumulativeBlockUnits % BLOCK_UNITS_PER_BLOCK;
}

/**
 * Smallest amount of work that would finish the block in progress at the
 * current difficulty. Exact, not an estimate: block units accrue in whole-round
 * lumps and a block completes as soon as the counter crosses.
 */
export function workToNextBlock(cumulativeBlockUnits, difficulty) {
  const remaining = BLOCK_UNITS_PER_BLOCK - blockProgress(cumulativeBlockUnits);
  return (remaining * difficulty + BLOCK_UNITS_SCALE - 1n) / BLOCK_UNITS_SCALE;
}

/**
 * Replay recorded rounds through the whitepaper rules and compare the result
 * with what the contract actually emitted.
 *
 * rounds must be ordered oldest-first and shaped as
 *   { roundId, work, cumulativeWork, cumulativeBlockUnits, difficulty }
 * with the last three exactly as the chain reported them.
 *
 * The counter is re-synced to the chain value after every round so that one bad
 * round cannot masquerade as many. Difficulty is *not* re-synced: drift in
 * difficulty is itself the finding.
 */
export function replay(rounds, initialDifficulty) {
  let difficulty = initialDifficulty;
  let units = 0n;
  const steps = [];
  let unitMismatches = 0;
  let difficultyMismatches = 0;

  for (const r of rounds) {
    const work = BigInt(r.work);
    const expectedUnits = units + roundBlockUnits(work, difficulty);
    const expectedDifficulty = nextDifficulty(work, difficulty);
    const unitsOk = expectedUnits === r.cumulativeBlockUnits;
    const difficultyOk = expectedDifficulty === r.difficulty;

    if (!unitsOk) unitMismatches++;
    if (!difficultyOk) difficultyMismatches++;

    steps.push({
      roundId: r.roundId,
      work,
      unitsBefore: units,
      unitsAfter: expectedUnits,
      chainUnits: r.cumulativeBlockUnits,
      difficultyBefore: difficulty,
      difficultyAfter: expectedDifficulty,
      chainDifficulty: r.difficulty,
      unitsOk,
      difficultyOk,
    });

    units = r.cumulativeBlockUnits;
    difficulty = expectedDifficulty;
  }

  return {
    steps,
    rounds: rounds.length,
    unitMismatches,
    difficultyMismatches,
    ok: unitMismatches === 0 && difficultyMismatches === 0,
    finalDifficulty: difficulty,
    finalUnits: units,
  };
}

/**
 * Recover the difficulty that must have been in force *before* a recorded round,
 * from the round's own emitted difficulty. Used to prove the first recorded
 * round is consistent with the published initial value instead of assuming it.
 * Integer rounding can admit two starting values. Return their exact inclusive
 * interval rather than choosing one and rejecting another valid configuration.
 * Returns null when no protocol-valid starting difficulty reproduces the round.
 */
export function recoverPriorDifficulty(work, emittedDifficulty) {
  if (emittedDifficulty < MIN_DIFFICULTY) return null;
  if (work < TARGET_BLOCKS_PER_ACTIVE_ROUND) {
    return { low: emittedDifficulty, high: emittedDifficulty };
  }
  const target = (work * 1_000n) / TARGET_BLOCKS_PER_ACTIVE_ROUND;
  const divisor = SMOOTHING - 1n;
  const lower = SMOOTHING * emittedDifficulty - target;
  const upper = SMOOTHING * (emittedDifficulty + 1n) - 1n - target;
  // BigInt division truncates toward zero: round the lower bound upward and
  // the upper bound downward, including when an impossible event makes them negative.
  const low = lower >= 0n ? (lower + divisor - 1n) / divisor : lower / divisor;
  const high = upper >= 0n ? upper / divisor : -((-upper + divisor - 1n) / divisor);
  const validLow = low < MIN_DIFFICULTY ? MIN_DIFFICULTY : low;
  return high < validLow ? null : { low: validLow, high };
}

/** Deterministic PRNG so a forecast can be reproduced from its seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Bootstrap the next rounds rounds from observed per-round work and report how
 * many blocks complete.
 *
 * observedWork should hold only rounds that actually had work. zeroRate is the
 * share of recent rounds that produced nothing, which is not a rounding error:
 * a sleeping hamster really does close empty rounds.
 */
export function forecastBlocks({
  cumulativeBlockUnits,
  difficulty,
  observedWork,
  zeroRate,
  rounds,
  iterations = 2000,
  seed = 1,
}) {
  const startHeight = heightOf(cumulativeBlockUnits);
  const results = [];
  if (observedWork.length === 0 || rounds <= 0) {
    return { startHeight, results, samples: 0, p10: 0, p50: 0, p90: 0, mean: 0 };
  }
  const random = mulberry32(seed);
  for (let i = 0; i < iterations; i++) {
    let units = cumulativeBlockUnits;
    let d = difficulty;
    for (let r = 0; r < rounds; r++) {
      const w =
        random() < zeroRate
          ? 0n
          : BigInt(observedWork[Math.floor(random() * observedWork.length)]);
      units += roundBlockUnits(w, d);
      d = nextDifficulty(w, d);
    }
    results.push(Number(heightOf(units) - startHeight));
  }
  results.sort((a, b) => a - b);
  return {
    startHeight,
    results,
    samples: results.length,
    p10: quantile(results, 0.1),
    p50: quantile(results, 0.5),
    p90: quantile(results, 0.9),
    mean: results.reduce((s, v) => s + v, 0) / results.length,
  };
}

/** Histogram helper for the forecast chart. */
export function histogram(values, buckets = 24) {
  if (values.length === 0) return [];
  const min = values[0];
  const max = values[values.length - 1];
  const span = Math.max(1, max - min);
  const size = span / buckets;
  const out = Array.from({ length: buckets }, (_, i) => ({
    from: min + i * size,
    to: min + (i + 1) * size,
    count: 0,
  }));
  for (const v of values) {
    let i = Math.floor((v - min) / size);
    if (i >= buckets) i = buckets - 1;
    out[i].count++;
  }
  return out;
}
