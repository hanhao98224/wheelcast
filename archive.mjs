#!/usr/bin/env node
/** Export a confirmed Core snapshot, or replay an archive without the network. */
import { lstat, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

class CliError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return [
    'Wheelcast Core archives (Node 22+; no dependencies)',
    '',
    '  node archive.mjs export output.zip [--json]',
    '  node archive.mjs verify input.zip [--json]',
    '',
    'Export reads free public API/RPC data at one block, at least 12 confirmations',
    'behind the head. It never overwrites an existing output file.',
    'Verify replays only the files in the ZIP and makes no network requests.',
    '',
    'Export environment:',
    '  WHEELCAST_API         API base (default https://api.squeekchain.com/v1)',
    '  WHEELCAST_RPCS        comma-separated HTTP(S) RPC URLs or URL@maxRange',
    '  WHEELCAST_TIMEOUT_MS  API request timeout (default 30000)',
    '',
    'Exit: 0 valid archive; 1 invalid evidence/archive; 2 usage, network or IO error.',
    'Offline success checks internal consistency, not Ethereum provenance.',
  ].join('\n');
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') return { help: true };
  const json = args.includes('--json');
  const positional = args.filter((arg) => arg !== '--json');
  if (positional.length !== 2 || !['export', 'verify'].includes(positional[0]) || positional[1].startsWith('--')) {
    throw new CliError('Expected export <output.zip> or verify <input.zip>. Use --help for usage.');
  }
  return { command: positional[0], filename: path.resolve(positional[1]), json };
}

function apiUrl() {
  const base = (process.env.WHEELCAST_API ?? 'https://api.squeekchain.com/v1').replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch { throw new CliError('WHEELCAST_API must be an HTTP(S) API base URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('WHEELCAST_API must be an HTTP(S) API base URL without credentials, query or fragment.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/core';
  return url;
}

function rpcUrls() {
  if (process.env.WHEELCAST_RPCS === undefined) return undefined;
  const entries = process.env.WHEELCAST_RPCS.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new CliError('WHEELCAST_RPCS must contain at least one RPC URL.');
  return entries.map((entry) => {
    // Check the base URL; the collector interprets an optional @maxRange hint.
    const raw = entry.replace(/@\d+$/, '');
    let url;
    try { url = new URL(raw); } catch { throw new CliError('WHEELCAST_RPCS contains an invalid RPC URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new CliError('RPC URLs must use HTTP or HTTPS.');
    return entry;
  });
}

async function ensureNewOutput(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new CliError('Could not inspect the output path: ' + error.message);
  }
  throw new CliError('Output already exists; choose a new filename. Nothing was overwritten.');
}

async function writeNewFile(filename, bytes) {
  let handle;
  try {
    handle = await open(filename, 'wx');
    await handle.writeFile(bytes);
    await handle.close();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      await unlink(filename).catch(() => {});
    }
    if (error.code === 'EEXIST') throw new CliError('Output already exists; choose a new filename. Nothing was overwritten.');
    throw new CliError('Could not write the archive: ' + error.message);
  }
}

function reportSuccess(options, result) {
  const report = {
    ok: true,
    command: options.command,
    file: options.filename,
    core: result.evidence.core,
    snapshot: result.evidence.snapshot,
    summary: result.summary,
    scope: 'Internal consistency of the included Core evidence; not an Ethereum provenance proof.',
  };
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  const summary = result.summary;
  process.stdout.write([
    'ARCHIVE OK ' + options.filename,
    'snapshot block ' + report.snapshot.number + ' ' + report.snapshot.hash,
    summary.activeRounds + ' active, ' + summary.zeroRounds + ' certified zero-work, ' + summary.unknownRounds + ' unknown round(s)',
    'certified through round ' + summary.settledThroughRound + '; block height ' + summary.blockHeight,
    report.scope,
    '',
  ].join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (options.command === 'verify') {
    // This path deliberately does not import the RPC collector or inspect any
    // network-related environment variables. Offline checks stay offline.
    let bytes;
    try {
      const info = await stat(options.filename);
      if (!info.isFile()) throw new CliError('Archive input must be a regular file.');
      if (info.size > 32 * 1024 * 1024) throw new CliError('Wheelcast ZIP exceeds the 32 MiB size limit.', 1);
      bytes = await readFile(options.filename);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('Could not read the archive: ' + error.message);
    }
    const { verifyArchive } = await import('./lib/archive-package.js');
    let result;
    try { result = await verifyArchive(bytes); }
    catch (error) { throw new CliError('Archive verification failed: ' + error.message, 1); }
    reportSuccess(options, result);
    return;
  }

  await ensureNewOutput(options.filename);
  const url = apiUrl();
  const endpoints = rpcUrls();
  const timeout = Number(process.env.WHEELCAST_TIMEOUT_MS ?? 30000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new CliError('WHEELCAST_TIMEOUT_MS must be a positive integer timeout in milliseconds.');
  }
  let coreRecord;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    coreRecord = await response.json();
    if (!coreRecord || typeof coreRecord !== 'object' || Array.isArray(coreRecord)) throw new Error('Invalid deployment record');
    if (coreRecord.status && coreRecord.status !== 'available') throw new Error('Deployment record is unavailable');
  } catch (error) { throw new CliError('Could not discover the deployment from the API: ' + error.message); }

  const { captureEvidence } = await import('./lib/archive-source.js');
  const { createArchive, verifyArchive } = await import('./lib/archive-package.js');
  let evidence;
  try {
    evidence = await captureEvidence({
      coreRecord,
      ...(endpoints ? { rpcUrls: endpoints } : {}),
      confirmations: 12,
    });
  } catch (error) { throw new CliError('Could not capture a confirmed snapshot: ' + error.message); }
  let bytes;
  let result;
  try {
    bytes = await createArchive(evidence);
    result = await verifyArchive(bytes);
  } catch (error) { throw new CliError('Captured evidence failed verification: ' + error.message, 1); }
  await writeNewFile(options.filename, bytes);
  reportSuccess(options, result);
}

main().catch((error) => {
  const exitCode = error instanceof CliError ? error.exitCode : 2;
  const message = error?.message ?? String(error);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ ok: false, error: message, exitCode }, null, 2) + '\n');
  } else {
    process.stderr.write('ARCHIVE ERROR: ' + message + '\n');
  }
  process.exitCode = exitCode;
});
