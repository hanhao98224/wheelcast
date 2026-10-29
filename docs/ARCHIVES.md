# Confirmed round archives

Wheelcast can export SqueekCore's complete round ledger as a ZIP and replay that
ZIP without contacting the API or an Ethereum RPC. This is a **Core arithmetic and
settlement check**, not a security audit of Squeekchain or a proof of physical
wheel activity.

No wallet, signature, transaction, paid RPC key or package installation is needed.
Use Node 22 or later for the commands below. The page also offers archive download
and local verification controls; selecting a local ZIP does not upload it.

## Export and verify

From the repository directory:

```sh
node archive.mjs export /tmp/wheelcast-core.zip
node archive.mjs verify /tmp/wheelcast-core.zip

# Machine-readable reports
node archive.mjs export /tmp/wheelcast-core-next.zip --json
node archive.mjs verify /tmp/wheelcast-core-next.zip --json
```

The exporter refuses to overwrite an existing output. Choose another filename for
the next snapshot. The verifier reads only the ZIP; it does not need an Internet
connection or inspect the API/RPC configuration. It is safe to disconnect from the
network between `export` and `verify`.

Exit codes are `0` for a valid archive, `1` for invalid evidence or an archive that
fails verification, and `2` for usage, network, configuration or file IO errors.
`ARCHIVE OK` means the included evidence and derived files agree with the rules
below, within the trust limits in the final section.

## What is in the ZIP

| File | Contents |
|---|---|
| `manifest.json` | Archive format/version, SHA-256 checksums and the derived summary |
| `evidence.json` | Chain and Core identity, deployment block, head and snapshot header, configuration and state at that snapshot, and raw RPC logs |
| `logs.jsonl` | The same raw log evidence, one JSON object per line, including block and transaction hashes and event positions |
| `rounds.csv` | One row per round from round 1 through the round open at the snapshot, with status and ledger values |

Integers in JSON evidence are decimal strings so large counters retain their exact
value. Raw RPC fields retain Ethereum's hexadecimal representation. The manifest's
checksums detect changed files; the verifier also re-derives CSV and JSONL rather
than accepting their summaries on trust.

Version 1 uses uncompressed ZIP entries; verify the downloaded ZIP directly rather
than recompressing it. Archives are limited to 32 MiB, 100,000 raw logs and 100,000
expanded rounds. Capture supports the published Core V3 ABI and a history span of
at most 2,000,000 Ethereum blocks; unsupported deployments fail explicitly.

Round status is explicit:

| Status | Meaning | Work and ledger values |
|---|---|---|
| `active` | A `RoundRecorded` event is certified by a corresponding `BatchSettled` | Exact replayed values |
| `zero` | The round is omitted from a complete certified batch span | Work is `0`; the ledger carries forward |
| `unknown` | The round is beyond the certified frontier, including the current open round | Numeric values are empty, not `0` |

A zero-work round is a statement about accepted work in the settlement ledger. It
does not prove that the wheel stood still or that the measurement host was online.

## Capture and replay checks

1. The public `/v1/core` API discovers the Core address and deployment block. The
   collector reads configuration and state directly from RPC at one fixed Sepolia
   block, at least 12 Ethereum blocks behind the captured head.
2. The collector fetches `CoreInitialized`, `RoundRecorded` and `BatchSettled` logs
   from the deployment block through that snapshot. It retains event identity and
   ordering, not just aggregated totals. Free endpoints and smaller block ranges
   are tried when an endpoint cannot serve a request. Missing or failed requests
   never become an empty history.
3. The snapshot block hash is read again after capture. A changed anchor rejects
   the capture instead of publishing evidence assembled across a reorganization.
4. Replay starts from the initialization parameters, prices every active round at
   the previous difficulty, then updates difficulty with exact integer arithmetic.
   It checks work limits, accumulated work and block units, event order, batch
   continuity and counts, and the state at the fixed snapshot.
5. Each batch must continue the previous certified frontier. Omitted rounds become
   `zero` only inside that complete certified span. Uncertified rounds remain
   `unknown`.
6. Offline verification checks the file checksums, repeats the evidence replay,
   and compares the derived CSV, JSONL and summary with the archived files.

The scope is one Core deployment. Reward issuance, NFT ownership, staking and
claims are outside this archive. The existing `node verify.mjs` command remains a
separate implementation of the active-round arithmetic check.

## Free endpoint configuration

```sh
WHEELCAST_RPCS=https://sepolia.gateway.tenderly.co,https://ethereum-sepolia-rpc.publicnode.com \
  node archive.mjs export /tmp/wheelcast-custom.zip
```

| Variable | Default | Effect |
|---|---|---|
| `WHEELCAST_API` | `https://api.squeekchain.com/v1` | Discovery API base for `export` |
| `WHEELCAST_RPCS` | Public Sepolia endpoints | Comma-separated HTTP(S) RPC URLs or `URL@maxRange` for `export` |
| `WHEELCAST_TIMEOUT_MS` | `30000` | Timeout for the discovery API request |

For compatibility with the original verifier, a URL may end in `@maxRange` to set
its initial block-range size (1 to 20,000 blocks). The collector shrinks that range
when the endpoint refuses a request.
These variables have no effect on `verify`, which does not use the network.
Public RPC service availability and history retention vary. If none can provide
the complete history and fixed-block reads, export fails without writing a ZIP.

## What offline success establishes

An archive is reproducible evidence of the data the collector received. Offline
verification establishes that the included raw logs, initialization, snapshot
state and derived files are internally consistent with the supported Core rules.

The manifest and its hashes are not a signature or an Ethereum proof. Someone who
replaces every file and recomputes the manifest can fabricate a consistent archive.
Offline verification alone cannot prove that an RPC told the truth, that the block
belongs to Ethereum's canonical chain, or that the sensor measurements describe a
real animal. For chain provenance, independently compare the archived address,
snapshot block hash, receipts/logs and state against an Ethereum node you trust.
Twelve confirmations and the capture-time anchor recheck reduce ordinary reorg
mixing; they do not remove that trust boundary.

The implementation follows the project's [Core reference](https://docs.squeekchain.com/developers/core/)
and [event indexing guide](https://docs.squeekchain.com/developers/index-events/).
