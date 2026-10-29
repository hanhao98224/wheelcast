/**
 * Wheelcast - rendering and orchestration.
 *
 * Flow: read the live deployment identity from the project API, pull every
 * RoundRecorded event from the contract, replay the whitepaper rule over them,
 * then keep the live panels ticking against /v1/status.
 */

import {
  BLOCK_UNITS_PER_BLOCK,
  replay,
  recoverPriorDifficulty,
  forecastBlocks,
  histogram,
  workToNextBlock,
  heightOf,
  blockProgress,
} from "./lib/protocol.js";
import {
  getCore,
  getStatus,
  getSettlements,
  fetchRounds,
  latestBlock,
  readCache,
  writeCache,
  getPublishedDeployment,
  ChainError,
} from "./lib/chain.js";

const RING_CIRCUMFERENCE = { r112: 2 * Math.PI * 112, r90: 2 * Math.PI * 90 };
const POLL_MS = 15000;
const HISTORY_MS = 5 * 60 * 1000;
/** Rounds used to estimate the empty-round share and the work distribution. */
const SAMPLE_ROUNDS = 120;

const $ = (id) => document.getElementById(id);

const state = {
  core: null,
  config: null,
  rounds: [],
  parity: null,
  status: null,
  settlements: null,
  clockOffset: 0,
  horizon: 144,
  lastHistoryAt: 0,
  loadingHistory: false,
};

/* ------------------------------ formatting ------------------------------ */

const nf = new Intl.NumberFormat("en-US");
const fmtInt = (v) => nf.format(typeof v === "bigint" ? Number(v) : v);

function fmtCompact(v) {
  const n = typeof v === "bigint" ? Number(v) : v;
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return nf.format(Math.round(n));
}

const fmtPct = (x) => (x * 100).toFixed(1) + "%";

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return m + "m " + String(rs).padStart(2, "0") + "s";
}

function setPill(stateName, text) {
  const pill = $("conn-pill");
  pill.dataset.state = stateName;
  $("conn-text").textContent = text;
}

function showError(message) {
  const existing = document.querySelector(".err-banner");
  if (existing) existing.remove();
  const el = document.createElement("div");
  el.className = "err-banner";
  el.textContent = message;
  $("parity-line").after(el);
}

/* ------------------------------- round clock ---------------------------- */

function now() {
  return Date.now() - state.clockOffset;
}

function roundInfo() {
  const cfg = state.config;
  if (!cfg) return null;
  const genesis = Number(cfg.genesisTimestamp) * 1000;
  const duration = Number(cfg.roundDuration) * 1000;
  if (!Number.isFinite(genesis) || !Number.isFinite(duration) || duration <= 0) return null;
  const elapsed = now() - genesis;
  if (elapsed < 0) return null;
  const index = Math.floor(elapsed / duration);
  const into = elapsed - index * duration;
  return { index, progress: into / duration, remaining: duration - into, duration };
}

/* --------------------------------- render ------------------------------- */

function renderClock() {
  const info = roundInfo();
  const anchor = state.status?.builder?.anchor;
  if (!info) return;
  $("round-id").textContent = fmtInt(info.index);
  $("round-eta").textContent = fmtDuration(info.remaining);

  const ringTime = $("ring-time");
  ringTime.style.strokeDasharray = String(RING_CIRCUMFERENCE.r112);
  ringTime.style.strokeDashoffset = String(RING_CIRCUMFERENCE.r112 * (1 - info.progress));

  const work = Number(state.status?.queued?.openRoundWorkUnits ?? 0);
  const cap = Number(state.config?.maxWorkPerRound ?? 10000) || 10000;
  const frac = Math.min(1, work / cap);
  const ringWork = $("ring-work");
  ringWork.style.strokeDasharray = String(RING_CIRCUMFERENCE.r90);
  ringWork.style.strokeDashoffset = String(RING_CIRCUMFERENCE.r90 * (1 - frac));
  $("wheel-work").textContent = fmtInt(work);
  $("round-cap").textContent = fmtInt(cap);

  if (anchor) {
    $("t-frontier").textContent = fmtInt(anchor.settledThroughRound);
    $("t-height").textContent = fmtInt(heightOf(BigInt(anchor.cumulativeBlockUnits)));
    $("t-progress").textContent = fmtPct(Number(blockProgress(BigInt(anchor.cumulativeBlockUnits))) / 1e9);
    const next = workToNextBlock(BigInt(anchor.cumulativeBlockUnits), BigInt(anchor.workPerThousandBlocks));
    $("t-next").textContent = fmtInt(next) + " work";
  }
  const m = state.status?.measurement;
  if (m) {
    $("t-work").textContent = fmtInt(BigInt(m.cumulativeWorkUnits));
    $("t-speed").textContent = (m.speedMmPerSecond / 1000).toFixed(2) + " m/s";
  }
}

function renderParity() {
  const p = state.parity;
  const card = $("verdict-card");
  if (!p) return;
  const okCount = p.steps.filter((step) => step.unitsOk && step.difficultyOk).length;

  card.dataset.state = p.ok ? "pass" : "fail";
  $("parity-ok").textContent = fmtInt(p.ok ? p.rounds : okCount);
  $("parity-total").textContent = fmtInt(p.rounds);
  $("parity-line").textContent = p.ok
    ? "Every recorded round reproduced exactly from the configured initial difficulty: block units and difficulty both match the contract."
    : (state.parityRecoveredMatchesConfig ? "" : "Configured initial difficulty is inconsistent with the first recorded round. ") +
      p.unitMismatches + " block-unit mismatch(es), " + p.difficultyMismatches + " difficulty mismatch(es). See the table.";

  $("d-initial").textContent = fmtInt(state.config?.initialWorkPerThousandBlocks ?? "-");
  const recovered = state.recoveredDifficulty;
  const matches = state.parityRecoveredMatchesConfig;
  const recoveredText = recovered == null ? "not recoverable" : recovered.low === recovered.high
    ? fmtInt(recovered.low)
    : fmtInt(recovered.low) + "–" + fmtInt(recovered.high);
  $("d-recovered").textContent = recoveredText + (matches ? "  ✓" : "  ≠");
  $("d-recovered").title = matches
    ? "The initial difficulty reported by the API is within the range derived from the first recorded round."
    : "The initial difficulty reported by the API is outside the range derived from the first recorded round.";
  $("d-current").textContent = fmtInt(p.finalDifficulty);

  const heroParity = $("hero-parity");
  if (heroParity) heroParity.textContent = fmtInt(p.rounds);
  const heroMismatch = $("hero-mismatch");
  if (heroMismatch) {
    const total = p.unitMismatches + p.difficultyMismatches;
    heroMismatch.textContent = total === 0 ? "0 mismatches" : total + " mismatches";
    heroMismatch.classList.toggle("is-bad", total > 0);
  }

  const strip = $("parity-strip");
  strip.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const step of p.steps) {
    const i = document.createElement("i");
    const bad = !step.unitsOk || !step.difficultyOk;
    if (bad) i.className = "bad";
    i.title = "round " + step.roundId + " | work " + step.work + " | D " + step.difficultyBefore + " -> " + step.difficultyAfter;
    frag.appendChild(i);
  }
  strip.appendChild(frag);

  renderTable();
}

function renderTable() {
  const p = state.parity;
  if (!p) return;
  const tbody = document.querySelector("#round-table tbody");
  const tpl = $("row-template");
  const frag = document.createDocumentFragment();
  for (const step of p.steps) {
    const row = tpl.content.firstElementChild.cloneNode(true);
    const bad = !step.unitsOk || !step.difficultyOk;
    row.querySelector(".c-round").textContent = fmtInt(step.roundId);
    row.querySelector(".c-work").textContent = fmtInt(step.work);
    row.querySelector(".c-dbefore").textContent = fmtInt(step.difficultyBefore);
    row.querySelector(".c-dexpected").textContent = fmtInt(step.difficultyAfter);
    row.querySelector(".c-dchain").textContent = fmtInt(step.chainDifficulty);
    row.querySelector(".c-uexpected").textContent = fmtInt(step.unitsAfter);
    row.querySelector(".c-uchain").textContent = fmtInt(step.chainUnits);
    const flag = row.querySelector(".c-flag");
    flag.textContent = bad ? "mismatch" : "ok";
    if (bad) flag.classList.add("bad");
    frag.appendChild(row);
  }
  tbody.replaceChildren(frag);
}

function recentWorkSample(windowRounds = SAMPLE_ROUNDS) {
  const p = state.parity;
  if (!p || p.steps.length === 0) return { work: [], zeroRate: 0.5 };
  const frontier = p.steps[p.steps.length - 1].roundId;
  const from = frontier - windowRounds + 1;
  const inWindow = p.steps.filter((s) => s.roundId >= from);
  const work = inWindow.map((s) => Number(s.work)).filter((w) => w > 0);
  const span = Math.max(1, frontier - Math.max(from, p.steps[0].roundId) + 1);
  const active = p.steps.filter((s) => s.roundId >= from && s.work > 0n).length;
  const zeroRate = Math.min(0.95, Math.max(0.02, 1 - active / span));
  return { work, zeroRate };
}

function sqkPerBlock() {
  const recent = state.settlements?.recentSettlements;
  if (!Array.isArray(recent) || recent.length === 0) return null;
  let minted = 0n;
  let blocks = 0n;
  for (const s of recent) {
    minted += BigInt(s.sqkMintedBaseUnits ?? 0);
    blocks += BigInt(s.completedBlockCount ?? 0);
  }
  if (blocks === 0n) return null;
  return Number(minted / 10n ** 12n) / 1e6 / Number(blocks);
}

function renderForecast() {
  const anchor = state.status?.builder?.anchor;
  if (!anchor || !state.parity) return;
  const { work, zeroRate } = recentWorkSample();
  if (work.length === 0) {
    $("fc-p50").textContent = "-";
    return;
  }
  const fc = forecastBlocks({
    cumulativeBlockUnits: BigInt(anchor.cumulativeBlockUnits),
    difficulty: BigInt(anchor.workPerThousandBlocks),
    observedWork: work,
    zeroRate,
    rounds: state.horizon,
    iterations: 1500,
    seed: 20261029,
  });

  $("fc-p50").textContent = fmtInt(Math.round(fc.p50));
  $("fc-range").textContent = "80% interval " + fmtInt(Math.round(fc.p10)) + " - " + fmtInt(Math.round(fc.p90));
  $("fc-zero").textContent = fmtPct(zeroRate);
  $("fc-sample").textContent = fmtInt(work.length) + " / " + fmtInt(SAMPLE_ROUNDS);
  $("fc-height").textContent = fmtInt(heightOf(BigInt(anchor.cumulativeBlockUnits)));

  const rate = sqkPerBlock();
  $("fc-sqk").textContent = rate == null ? "unavailable" : fmtCompact(Math.round(fc.p50 * rate)) + " SQK";

  const bars = histogram(fc.results, 28);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const hist = $("fc-hist");
  hist.replaceChildren();
  const frag = document.createDocumentFragment();
  for (const b of bars) {
    const i = document.createElement("i");
    i.style.height = Math.max(2, (b.count / max) * 100) + "%";
    i.title = fmtInt(Math.round(b.from)) + "-" + fmtInt(Math.round(b.to)) + " blocks: " + b.count + " sims";
    frag.appendChild(i);
  }
  hist.appendChild(frag);

  const hours = (state.horizon * 10) / 60;
  $("forecast-note").textContent =
    "Bootstrapped from the last " + SAMPLE_ROUNDS + " rounds (" + work.length + " active, " +
    fmtPct(zeroRate) + " empty) across " + hours + " h of simulated rounds. Difficulty follows " +
    "the same integer rule the audit checks, so a busy hamster raises difficulty and damps its " +
    "own block rate.";
}


/* ----------------------------- deployment drift ------------------------- */

function shortAddr(v) {
  if (typeof v !== "string" || v.length < 12) return v == null ? "-" : String(v);
  return v.slice(0, 10) + "..." + v.slice(-8);
}

function deployRows(published, live) {
  const docs = published ?? {};
  const core = docs.contracts?.SqueekCore ?? {};
  const cfg = docs.coreConfiguration ?? {};
  const op = docs.operational ?? {};
  return [
    ["SqueekCore proxy", core.address, live.identities?.core, true],
    ["core implementation", core.implementation, live.implementation?.codeAddress, true],
    ["implementation version", core.implementationVersion, live.implementation?.codeVersion, false],
    ["storage layout digest", core.storageLayoutDigest, live.implementation?.storageLayoutDigest, true],
    ["runtime code hash", core.implementationRuntimeHash, live.implementation?.runtimeHash, true],
    ["stream id", cfg.streamId, live.configuration?.streamId, true],
    ["guardian", op.guardian?.address, live.configuration?.guardian, true],
    ["reporter", op.reporter?.address, live.configuration?.reporter, true],
  ];
}

function renderDeployment() {
  const published = state.published;
  const live = state.core;
  const chip = $("deploy-verdict");
  const tbody = document.querySelector("#deploy-table tbody");
  if (!live || !tbody) return;

  const rows = deployRows(published, live);
  const frag = document.createDocumentFragment();
  let differ = 0;
  let compared = 0;

  for (const [label, pub, liv, isAddress] of rows) {
    const tr = document.createElement("tr");
    const same = pub != null && liv != null && String(pub).toLowerCase() === String(liv).toLowerCase();
    if (pub != null && liv != null) {
      compared++;
      if (!same) differ++;
    }
    const c1 = document.createElement("td");
    c1.textContent = label;
    const c2 = document.createElement("td");
    c2.className = "mono";
    c2.textContent = pub == null ? "not published" : isAddress ? shortAddr(String(pub)) : String(pub);
    if (pub != null) c2.title = String(pub);
    const c3 = document.createElement("td");
    c3.className = "mono";
    c3.textContent = liv == null ? "not reported" : isAddress ? shortAddr(String(liv)) : String(liv);
    if (liv != null) c3.title = String(liv);
    const c4 = document.createElement("td");
    if (pub == null || liv == null) {
      c4.textContent = "?";
    } else if (same) {
      c4.textContent = "ok";
      c4.className = "mark-ok";
    } else {
      c4.textContent = "differs";
      c4.className = "mark-diff";
    }
    tr.append(c1, c2, c3, c4);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);

  const heroDrift = $("hero-drift");
  if (heroDrift) heroDrift.textContent = published ? fmtInt(differ) : "—";

  if (!published) {
    chip.dataset.state = "pending";
    chip.textContent = "published record unavailable";
  } else if (differ === 0) {
    chip.dataset.state = "match";
    chip.textContent = "identical";
  } else {
    chip.dataset.state = "diff";
    chip.textContent = differ + " of " + compared + " fields differ";
  }
}

async function loadPublished() {
  try {
    state.published = await getPublishedDeployment();
  } catch {
    state.published = null;
  }
  renderDeployment();
}

/* --------------------------------- loading ------------------------------ */

async function loadIdentity() {
  const core = await getCore();
  state.core = core;
  state.config = {
    genesisTimestamp: core.configuration?.genesisTimestamp,
    roundDuration: core.configuration?.roundDuration ?? 600,
    maxWorkPerRound: core.configuration?.maxWorkPerRound ?? 10000,
    initialWorkPerThousandBlocks: core.configuration?.initialWorkPerThousandBlocks,
  };
  state.coreAddress = core.identities?.core;
  state.deploymentBlock = Number(core.chain?.deploymentBlock);
  if (!state.coreAddress || !Number.isFinite(state.deploymentBlock)) {
    throw new ChainError("The API did not report a core address and deployment block");
  }
  if (state.config.initialWorkPerThousandBlocks == null) {
    throw new ChainError("The API did not report an initial difficulty");
  }
}

async function loadHistory(force = false) {
  if (state.loadingHistory) return;
  if (!force && Date.now() - state.lastHistoryAt < HISTORY_MS) return;
  state.loadingHistory = true;
  $("parity-line").textContent = "reading settled rounds from chain…";
  try {
    const cached = readCache(state.coreAddress, state.deploymentBlock);
    let rounds = cached?.rounds;
    let head = cached?.latest;
    if (!rounds) {
      head = await latestBlock();
      rounds = await fetchRounds({
        core: state.coreAddress,
        fromBlock: state.deploymentBlock,
        toBlock: head,
        onProgress: ({ found, end }) => {
          $("parity-line").textContent = "reading settled rounds from chain… " + fmtInt(found) + " found through block " + fmtInt(end);
        },
      });
      writeCache(state.coreAddress, state.deploymentBlock, head, rounds);
    }
    state.rounds = rounds;
    state.lastHistoryAt = Date.now();

    if (rounds.length === 0) {
      $("parity-line").textContent = "No RoundRecorded events found yet on this deployment.";
      return;
    }

    const first = rounds[0];
    const initial = BigInt(state.config.initialWorkPerThousandBlocks);
    const recovered = recoverPriorDifficulty(first.work, first.difficulty);
    state.recoveredDifficulty = recovered;

    // The configuration is the claim being checked. Replaying from a recovered
    // replacement would hide a disagreement between that claim and the logs.
    state.parity = replay(rounds, initial);
    state.parityRecoveredMatchesConfig = recovered != null && initial >= recovered.low && initial <= recovered.high;
    state.parity.ok = state.parity.ok && state.parityRecoveredMatchesConfig;

    renderParity();
    renderForecast();
    $("foot-source").textContent =
      "core " + state.coreAddress + " · deployment block " + fmtInt(state.deploymentBlock) +
      " · " + fmtInt(rounds.length) + " RoundRecorded events · release " +
      (state.core?.installationId ?? "unknown");
  } catch (err) {
    showError("Could not read the settled history: " + (err?.message ?? err));
    setPill("error", "history unavailable");
  } finally {
    state.loadingHistory = false;
  }
}

async function pollStatus() {
  try {
    const status = await getStatus();
    state.status = status;
    if (status.generatedAt) {
      state.clockOffset = Date.now() - Date.parse(status.generatedAt);
    }
    const fresh = status.measurement?.freshness;
    setPill(fresh === "online" ? "live" : "stale", fresh === "online" ? "live" : fresh || "unknown");
    renderClock();
    renderForecast();
  } catch (err) {
    setPill("error", "API unreachable");
  }
}

async function loadSettlements() {
  try {
    state.settlements = await getSettlements();
  } catch {
    state.settlements = null;
  }
}

/* -------------------------------- controls ------------------------------ */

function wireControls() {
  $("toggle-table").addEventListener("click", (e) => {
    const card = $("table-card");
    const open = card.hasAttribute("hidden");
    if (open) card.removeAttribute("hidden");
    else card.setAttribute("hidden", "");
    e.currentTarget.setAttribute("aria-expanded", String(open));
    e.currentTarget.textContent = open ? "hide the round table" : "show every round";
  });

  for (const btn of document.querySelectorAll(".seg")) {
    btn.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".seg")) other.classList.remove("is-active");
      btn.classList.add("is-active");
      state.horizon = Number(btn.dataset.rounds);
      renderForecast();
    });
  }
}

function buildTicks() {
  const g = $("ticks");
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    const r1 = i % 5 === 0 ? 70 : 76;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(130 + Math.cos(a) * r1));
    line.setAttribute("y1", String(130 + Math.sin(a) * r1));
    line.setAttribute("x2", String(130 + Math.cos(a) * 82));
    line.setAttribute("y2", String(130 + Math.sin(a) * 82));
    frag.appendChild(line);
  }
  g.appendChild(frag);
}

/* --------------------------------- boot --------------------------------- */

async function boot() {
  buildTicks();
  wireControls();
  setPill("pending", "connecting");
  try {
    await loadIdentity();
  } catch (err) {
    setPill("error", "API unreachable");
    showError("Could not read the deployment record: " + (err?.message ?? err));
    return;
  }
  await Promise.all([loadSettlements(), loadPublished()]);
  await pollStatus();
  await loadHistory(true);
  setInterval(pollStatus, POLL_MS);
  setInterval(() => renderClock(), 1000);
  setInterval(() => loadHistory(false), HISTORY_MS);
}

boot();
