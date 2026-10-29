/**
 * Portable, dependency-free evidence archives. ZIP entries are deliberately stored
 * without compression so browsers and Node can verify the same bounded format.
 */
import { validateEvidence } from "./archive-core.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FILES = ["evidence.json", "logs.jsonl", "rounds.csv", "manifest.json"];
const MAX_BYTES = 32 * 1024 * 1024;
const COLUMNS = ["roundId", "status", "work", "cumulativeWork", "cumulativeBlockUnits",
  "difficulty", "dataHash", "batchTransactionHash"];

export function rowsToCSV(rows) {
  const cell = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
  };
  return COLUMNS.join(",") + "\n" +
    rows.map((row) => COLUMNS.map((key) => cell(row[key])).join(",")).join("\n") +
    (rows.length ? "\n" : "");
}

const jsonLines = (logs) => logs.map((log) => JSON.stringify(log)).join("\n") + (logs.length ? "\n" : "");
const pretty = (value) => JSON.stringify(value, null, 2) + "\n";
const canonical = (value) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
    : entry);

async function sha256(bytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function storeZIP(files) {
  const entries = Object.entries(files).map(([name, bytes]) =>
    ({ name: encoder.encode(name), bytes, crc: crc32(bytes) }));
  const localSize = entries.reduce((sum, entry) => sum + 30 + entry.name.length + entry.bytes.length, 0);
  const centralSize = entries.reduce((sum, entry) => sum + 46 + entry.name.length, 0);
  const size = localSize + centralSize + 22;
  if (size > MAX_BYTES) throw new Error("Archive exceeds the 32 MiB size limit");
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let cursor = 0;
  for (const entry of entries) {
    entry.offset = cursor;
    view.setUint32(cursor, 0x04034b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0x0800, true);
    view.setUint16(cursor + 12, 0x0021, true); // 1980-01-01
    view.setUint32(cursor + 14, entry.crc, true);
    view.setUint32(cursor + 18, entry.bytes.length, true);
    view.setUint32(cursor + 22, entry.bytes.length, true);
    view.setUint16(cursor + 26, entry.name.length, true);
    bytes.set(entry.name, cursor + 30);
    bytes.set(entry.bytes, cursor + 30 + entry.name.length);
    cursor += 30 + entry.name.length + entry.bytes.length;
  }
  for (const entry of entries) {
    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, 0x0800, true);
    view.setUint16(cursor + 14, 0x0021, true);
    view.setUint32(cursor + 16, entry.crc, true);
    view.setUint32(cursor + 20, entry.bytes.length, true);
    view.setUint32(cursor + 24, entry.bytes.length, true);
    view.setUint16(cursor + 28, entry.name.length, true);
    view.setUint32(cursor + 42, entry.offset, true);
    bytes.set(entry.name, cursor + 46);
    cursor += 46 + entry.name.length;
  }
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, entries.length, true);
  view.setUint32(cursor + 12, centralSize, true);
  view.setUint32(cursor + 16, localSize, true);
  return bytes;
}

function readZIP(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22 || bytes.length > MAX_BYTES) throw new Error("Invalid archive size (maximum 32 MiB)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50 ||
      view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0 ||
      view.getUint16(end + 8, true) !== FILES.length ||
      view.getUint16(end + 10, true) !== FILES.length ||
      view.getUint16(end + 20, true) !== 0) {
    throw new Error("Expected a Wheelcast ZIP with four uncompressed files");
  }
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  if (centralStart + centralSize !== end) throw new Error("Invalid ZIP directory");
  const files = Object.create(null);
  const ranges = [];
  let cursor = centralStart;
  for (let index = 0; index < FILES.length; index++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("Invalid ZIP entry");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const local = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags !== 0x0800 || method !== 0 || size !== view.getUint32(cursor + 20, true) ||
        extraLength !== 0 || commentLength !== 0 || view.getUint16(cursor + 34, true) !== 0) {
      throw new Error("Unsupported or malformed ZIP entry");
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!FILES.includes(name) || files[name]) throw new Error("Unexpected or duplicate ZIP filename");
    const dataStart = local + 30 + nameLength;
    const dataEnd = dataStart + size;
    if (local + 30 > centralStart || dataEnd > centralStart ||
        view.getUint32(local, true) !== 0x04034b50 ||
        view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method ||
        view.getUint32(local + 14, true) !== crc ||
        view.getUint32(local + 18, true) !== size || view.getUint32(local + 22, true) !== size ||
        view.getUint16(local + 26, true) !== nameLength || view.getUint16(local + 28, true) !== 0 ||
        decoder.decode(bytes.subarray(local + 30, dataStart)) !== name) {
      throw new Error("ZIP directory and file header disagree");
    }
    const content = bytes.subarray(dataStart, dataEnd);
    if (crc32(content) !== crc) throw new Error("ZIP integrity check failed for " + name);
    files[name] = content;
    ranges.push([local, dataEnd]);
    cursor = next;
  }
  if (cursor !== end) throw new Error("Unexpected ZIP directory bytes");
  ranges.sort((a, b) => a[0] - b[0]);
  let position = 0;
  for (const [start, finish] of ranges) {
    if (start !== position) throw new Error("Overlapping or unaccounted ZIP data");
    position = finish;
  }
  if (position !== centralStart) throw new Error("Unaccounted ZIP data");
  return files;
}

export async function createArchive(evidence) {
  const { summary, rows } = validateEvidence(evidence);
  const files = {
    "evidence.json": encoder.encode(pretty(evidence)),
    "logs.jsonl": encoder.encode(jsonLines(evidence.logs)),
    "rounds.csv": encoder.encode(rowsToCSV(rows)),
  };
  const hashes = Object.fromEntries(await Promise.all(
    Object.entries(files).map(async ([name, bytes]) => [name, await sha256(bytes)])));
  files["manifest.json"] = encoder.encode(pretty({
    format: "wheelcast-core-archive",
    schemaVersion: 1,
    hashes,
    summary,
    scope: "Checks the included Core evidence and arithmetic; does not independently authenticate it to Ethereum.",
  }));
  return storeZIP(files);
}

/** No RPC or API calls: all replay inputs must be present inside the archive. */
export async function verifyArchive(bytes) {
  const files = readZIP(bytes);
  const manifest = JSON.parse(decoder.decode(files["manifest.json"]));
  if (manifest?.format !== "wheelcast-core-archive" || manifest.schemaVersion !== 1 ||
      !manifest.hashes || Object.keys(manifest.hashes).sort().join(",") !== "evidence.json,logs.jsonl,rounds.csv") {
    throw new Error("Unsupported archive manifest");
  }
  for (const name of FILES.filter((file) => file !== "manifest.json")) {
    if (manifest.hashes[name] !== await sha256(files[name])) throw new Error("SHA-256 mismatch for " + name);
  }
  const evidence = JSON.parse(decoder.decode(files["evidence.json"]));
  const { rows, summary } = validateEvidence(evidence);
  if (decoder.decode(files["rounds.csv"]) !== rowsToCSV(rows)) throw new Error("CSV disagrees with replayed rounds");
  if (decoder.decode(files["logs.jsonl"]) !== jsonLines(evidence.logs)) throw new Error("JSONL disagrees with raw evidence");
  if (canonical(manifest.summary) !== canonical(summary)) throw new Error("Manifest summary disagrees with replay");
  return { rows, summary, evidence, manifest };
}
