import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createArchive, verifyArchive, rowsToCSV } from "../lib/archive-package.js";
import { makeEvidence } from "./fixtures/archive-fixture.mjs";

function entries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  let cursor = view.getUint32(end + 16, true);
  const files = {};
  while (cursor < end) {
    const nameLength = view.getUint16(cursor + 28, true);
    const name = Buffer.from(bytes.subarray(cursor + 46, cursor + 46 + nameLength)).toString();
    const local = view.getUint32(cursor + 42, true);
    const start = local + 30 + nameLength;
    const size = view.getUint32(cursor + 24, true);
    files[name] = { local, central: cursor, start, size };
    cursor += 46 + nameLength;
  }
  return files;
}

// Repair the transport checksum to exercise the stronger SHA/replay checks.
function replaceFile(bytes, entry, text) {
  const content = Buffer.from(text);
  assert.equal(content.length, entry.size, "fixture edits preserve ZIP offsets");
  bytes.set(content, entry.start);
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(entry.local + 14, (crc ^ 0xffffffff) >>> 0, true);
  view.setUint32(entry.central + 16, (crc ^ 0xffffffff) >>> 0, true);
}

test("portable ZIP replays with networking disabled and preserves unknown values", async (t) => {
  const evidence = makeEvidence();
  const bytes = await createArchive(evidence);
  t.mock.method(globalThis, "fetch", () => { throw new Error("network forbidden"); });
  const result = await verifyArchive(bytes);
  assert.deepEqual(result.evidence, evidence);
  assert.equal(result.summary.activeRounds, 1);
  assert.equal(result.summary.zeroRounds, 4);
  assert.equal(result.summary.unknownRounds, 3);
  const unknown = result.rows.filter((row) => row.status === "unknown");
  assert.ok(unknown.every((row) => row.work === null && row.cumulativeWork === null));
  assert.match(rowsToCSV(unknown), /\n6,unknown,,,,,,\n/);
  assert.deepEqual(Object.keys(entries(bytes)).sort(),
    ["evidence.json", "logs.jsonl", "manifest.json", "rounds.csv"]);
});

test("corrupted ZIP payload is rejected before parsing evidence", async () => {
  const bytes = await createArchive(makeEvidence());
  const file = entries(bytes)["evidence.json"];
  bytes[file.start + 2] ^= 1;
  await assert.rejects(verifyArchive(bytes), /ZIP integrity check/);
});

test("a repaired transport checksum cannot hide a changed evidence file", async () => {
  const bytes = await createArchive(makeEvidence());
  const file = entries(bytes)["evidence.json"];
  const text = Buffer.from(bytes.subarray(file.start, file.start + file.size)).toString();
  replaceFile(bytes, file, text.replace('"schemaVersion": 1', '"schemaVersion": 2'));
  await assert.rejects(verifyArchive(bytes), /SHA-256 mismatch for evidence.json/);
});

test("even updated hashes cannot make CSV disagree with the included logs", async () => {
  const bytes = await createArchive(makeEvidence());
  const files = entries(bytes);
  const csv = files["rounds.csv"];
  const original = Buffer.from(bytes.subarray(csv.start, csv.start + csv.size)).toString();
  const changed = original.replace(",active,", ",zero  ,");
  assert.notEqual(changed, original);
  replaceFile(bytes, csv, changed);
  const manifestEntry = files["manifest.json"];
  const manifestText = Buffer.from(bytes.subarray(manifestEntry.start, manifestEntry.start + manifestEntry.size)).toString();
  const oldHash = JSON.parse(manifestText).hashes["rounds.csv"];
  const newHash = createHash("sha256").update(changed).digest("hex");
  replaceFile(bytes, manifestEntry, manifestText.replace(oldHash, newHash));
  await assert.rejects(verifyArchive(bytes), /CSV disagrees with replayed rounds/);
});

test("archive creation refuses incomplete settlement history", async () => {
  const evidence = makeEvidence();
  evidence.logs.pop();
  await assert.rejects(createArchive(evidence));
});

test("unsupported ZIP formats and oversized inputs are rejected", async () => {
  await assert.rejects(verifyArchive(new Uint8Array([1, 2, 3])), /Invalid archive size/);
  await assert.rejects(verifyArchive(new Uint8Array(32 * 1024 * 1024 + 1)), /Invalid archive size/);
});
