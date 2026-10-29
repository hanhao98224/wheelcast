import { getCore } from "./lib/chain.js";
import { captureEvidence } from "./lib/archive-source.js";
import { createArchive, verifyArchive, rowsToCSV } from "./lib/archive-package.js";

const $ = (id) => document.getElementById(id);
const number = (value) => new Intl.NumberFormat("en-US").format(BigInt(value));
let archive = null;

function status(text, state = "pending") {
  $("archive-status").textContent = text;
  $("archive-status").dataset.state = state;
}

function showSummary({ evidence, summary }) {
  $("archive-snapshot").textContent = number(evidence.snapshot.number);
  $("archive-hash").textContent = evidence.snapshot.hash;
  $("archive-active").textContent = number(summary.activeRounds);
  $("archive-zero").textContent = number(summary.zeroRounds);
  $("archive-unknown").textContent = number(summary.unknownRounds);
  $("archive-summary").hidden = false;
}

function download(bytes, type, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("archive-build").addEventListener("click", async () => {
  const button = $("archive-build");
  button.disabled = true;
  $("archive-input").disabled = true;
  $("archive-zip").disabled = true;
  $("archive-csv").disabled = true;
  $("archive-summary").hidden = true;
  archive = null;
  status("Discovering the current Core deployment…");
  try {
    const evidence = await captureEvidence({
      coreRecord: await getCore(),
      onProgress: (progress) => status(progress.message || "Reading the confirmed history…"),
    });
    const bytes = await createArchive(evidence);
    const checked = await verifyArchive(bytes);
    archive = { ...checked, bytes };
    showSummary(checked);
    $("archive-zip").disabled = false;
    $("archive-csv").disabled = false;
    status("Snapshot checked. Download the ZIP to keep the evidence and replay it offline.", "pass");
  } catch (error) {
    status("Could not build an archive: " + error.message, "fail");
  } finally {
    button.disabled = false;
    $("archive-input").disabled = false;
  }
});

$("archive-zip").addEventListener("click", () => {
  if (archive) download(archive.bytes, "application/zip",
    "wheelcast-core-sepolia-" + archive.evidence.snapshot.number + ".zip");
});

$("archive-csv").addEventListener("click", () => {
  if (archive) download(rowsToCSV(archive.rows), "text/csv;charset=utf-8",
    "wheelcast-rounds-" + archive.evidence.snapshot.number + ".csv");
});

$("archive-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  $("archive-build").disabled = true;
  $("archive-input").disabled = true;
  $("archive-zip").disabled = true;
  $("archive-csv").disabled = true;
  $("archive-summary").hidden = true;
  archive = null;
  status("Checking the selected ZIP locally…");
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error("Archive exceeds the 32 MiB size limit");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const checked = await verifyArchive(bytes);
    archive = { ...checked, bytes };
    showSummary(checked);
    $("archive-zip").disabled = false;
    $("archive-csv").disabled = false;
    status("Offline replay passed: file hashes, settlement continuity and arithmetic agree.", "pass");
  } catch (error) {
    status("Offline replay failed: " + error.message, "fail");
  } finally {
    $("archive-build").disabled = false;
    $("archive-input").disabled = false;
    event.target.value = "";
  }
});
