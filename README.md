# Wheelcast

Wheelcast is a zero-dependency static site for **Squeekchain**, a hamster-powered
proof-of-work toychain on Ethereum Sepolia. It does three things:

1. shows the live state of the wheel, the rounds and the Squeek block count;
2. **replays every `RoundRecorded` event from the deployment block** and re-derives
   the chain's own block accounting from the whitepaper's integer rules, comparing
   the result with what `SqueekCore` actually emitted;
3. forecasts when the next Squeek block completes, by resampling the observed
   per-round work.

There is no build step, no bundler and no dependency: static files, one standalone
verification script, and the public API.

## What Squeekchain is

A hamster runs on a wheel. Every accepted magnet passage is one work unit. Work is
grouped into 600-second rounds, and a signed batch of rounds is settled onchain by
`SqueekCore`. Settled work earns *Squeek blocks*: 1,000,000,000 block units per
block, and every completed block issues SQK to Squeek NFT holders in proportion to
active power.

Difficulty is `workPerThousandBlocks`: the work that 1,000 Squeek blocks cost at
that moment. It adapts to the hamster's active rounds, so a busy hamster finishes a
block sooner and a quiet one later, while each block issues the same amount.

Squeekchain runs on Sepolia only. Testnet SQK and Squeeks have no monetary value.

## What Wheelcast does

| View | Source | What it shows |
|---|---|---|
| Live | `/v1/status` | wheel measurement, open round, settlement queue, builder anchor |
| Rounds | `eth_getLogs` | every recorded round with its work, difficulty and block units |
| Parity | replayed locally | derived vs emitted `cumulativeBlockUnits` and `workPerThousandBlocks` |
| Deployment record | `/v1/core` vs the published docs record | eight configuration fields side by side: which agree, which do not |
| Forecast | Monte Carlo over observed rounds | distribution of blocks completed over the next 1 / 6 / 24 hours (P10, P50, P90) |

## The parity check

This is the part worth reading.

The whitepaper states the protocol as integer arithmetic:

```text
blockUnits += floor(w * 10^12 / D)
D_next      = floor((29*D + floor(w*1000/40)) / 30)   when w >= 40
D_next      = D                                        when w < 40
height      = floor(blockUnits / 10^9)
```

`w` is a round's work and `D` is `workPerThousandBlocks`.

Wheelcast takes the raw `RoundRecorded` logs — not a helper view, not the API's
totals — starts from the deployment's `initialWorkPerThousandBlocks`, and walks the
rounds in order. After each round it has a derived `cumulativeBlockUnits` and a
derived difficulty. Both must equal the words the contract emitted. A single
divergence breaks the replay, so the check is strict: it is not "close enough",
it is the same integer or it is a failure.

**The ordering subtlety.** The whitepaper prices a round "at the difficulty that
earlier rounds set", and only then moves difficulty. So block units are earned at
the difficulty *before* the round, while the `workPerThousandBlocks` word in the
event is the difficulty *after* it. Implement it the other way round — price with
the freshly updated difficulty — and every round mismatches. That is the difference
between a replay that proves something and one that merely looks plausible.

**Recovering the genesis difficulty.** The first event only carries the difficulty
after one update, so the starting value is recoverable as an interval rather than a
single number. For the current deployment the interval collapses to exactly
`10000`, which is the `initialWorkPerThousandBlocks` in the deployment
configuration: the chain has been replaying one consistent difficulty since genesis.

## Verified against

```
71 recorded rounds (round 45 -> 375)
0 mismatches on cumulativeBlockUnits
0 mismatches on workPerThousandBlocks
height 2994, block units 2,994,347,019,284, cumulative work 32,660
difficulty 11,246 (from 10,000 at deployment)
SqueekCore 0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44, deployment block 11998937
Sepolia head 12017251, 2026-10-29
```

Those are a snapshot. The chain keeps settling, so the numbers move; rerun
`node verify.mjs` for the current set. Round 45 is the first round with work —
rounds with zero work emit no event, which is why 71 events cover rounds 45 to 375
rather than every round in that range.

## Run it locally

Any static file server works. The page must be served over HTTP rather than opened
as a `file://` URL, because it fetches JSON.

```sh
python3 -m http.server 8080
# or
npx serve .
```

Then open http://localhost:8080.

## verify.mjs

A standalone reimplementation of the parity check for the terminal. It shares no
code with the page: keccak-256, log decoding and the replay are all in the file, so
a bug in `lib/` cannot hide itself.

```sh
node verify.mjs           # mismatches only, plus a summary
node verify.mjs --all     # print every round
node verify.mjs --json    # machine-readable report
```

It reads `/v1/core` for the core address, deployment block, chain id and
`initialWorkPerThousandBlocks`; fetches `RoundRecorded` logs with `eth_getLogs` in
chunks; decodes the 2-topic / 5-word payload by hand; and replays with `BigInt`.

Exit codes: `0` parity holds, `1` mismatch, `2` setup or network failure.

```
$ node verify.mjs
...
PARITY OK 71/71 rounds, height 2994
```

Configuration, if the defaults are blocked:

| Variable | Default | Meaning |
|---|---|---|
| `WHEELCAST_API` | `https://api.squeekchain.com/v1` | API base |
| `WHEELCAST_RPCS` | public Sepolia endpoints | `url` or `url@maxRange`, comma separated |
| `WHEELCAST_TIMEOUT_MS` | `30000` | per-request timeout |

Public Sepolia RPCs differ in what they allow. Some prune history, some cap a
`eth_getLogs` span at a few hundred blocks. The script starts at each endpoint's
widest allowed span, shrinks the range when a request is refused, and rotates to the
next endpoint when the range is already small. The report names every endpoint that
actually served logs.

## Data sources

| Source | Used for |
|---|---|
| `https://api.squeekchain.com/v1/status` | wheel measurement, builder anchor, settlement queue, incidents |
| `https://api.squeekchain.com/v1/core` | chain id, core address, deployment block, launch configuration, core accounting |
| `https://api.squeekchain.com/v1/settlements` | settlement history: work added, completed block range, transaction hashes |
| `https://api.squeekchain.com/v1/economy/state` | SQK supply and issuance schedule, NFT power |
| Sepolia `eth_getLogs` | the `RoundRecorded` events the replay is built from |
| `https://docs.squeekchain.com/whitepaper.md` | the integer rules being tested |

The core address and deployment block are **not hardcoded**. They are read from
`/v1/core` at runtime (`identities.core` and `chain.deploymentBlock`), so a
redeployment is followed rather than ignored.

`RoundRecorded` is `RoundRecorded(uint64 indexed roundId, uint64 work, uint64 cumulativeWork, uint96 cumulativeBlockUnits, uint32 workPerThousandBlocks, bytes32 dataHash)`,
which is topic0 `0x6f7efb5b00900843c192802a77e52da9f18fee1daa04089fc4bf159963c7968c`
with 2 topics and 5 data words.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | page shell |
| `app.js` | data loading, replay, forecast, rendering |
| `styles.css` | styles |
| `lib/` | modules the page uses for chain reads and the protocol arithmetic |
| `verify.mjs` | standalone parity check, no imports from `lib/` |
| `docs/SUBMIT.md` | submission walkthrough for the Squeekchain Genesis code lane |
| `package.json` | `"type": "module"`, private, no dependencies |
| `.nojekyll` | stops GitHub Pages from filtering the served files |
| `README.md`, `LICENSE`, `.gitignore` | this file, MIT licence, ignore rules |

## Caveats

- Testnet only. Nothing here moves value, and the forecast is a model, not a promise.
- The API is a *copy* of the chain, 12 confirmations behind. The replay reads the
  logs, so it is checking the chain itself, but the live panel is checking the API.
- The published deployment record at
  `docs.squeekchain.com/assets/deployments/sepolia.json` still points at an earlier
  `SqueekCore` (`0x74665dAecA35A2303e767E76a2FF1FB6F93e119f`, deployment block
  `11902282`), whose last event is at block `11999145` — within a few blocks of the
  current core's deployment block `11998937`. `/v1/core` describes the deployment in
  use today, and the page puts the two records side by side, field by field: at the
  time of writing five of the eight compared fields differ. That gap is exactly why
  nothing in this repo hardcodes an address: the API is the source of truth for
  *which* contract is live, and the logs are the source of truth for *what* it
  recorded.
- A parity report covers the rounds it can see. Rounds that never happened cannot be
  checked, and rounds with zero work emit no event at all.

## License

MIT. See `LICENSE`.

## Why this project exists / 为什么这个项目存在

链上日志是唯一的事实来源，白皮书里的整数公式是唯一的规范。两者之间平时没有人
去核对，因为核对意味着要重新实现一遍协议，而不能调用合约自己的 view 函数。
Wheelcast 就是那第二份实现：它不读 ABI、不问 API 要总计，只解码 `RoundRecorded`
日志，从部署时的工作量参数开始，一轮一轮重算区块单位与难度，再逐字比对合约当时
写下的值。

这样做的意义不在于"相信"某个团队，而在于任何人打开页面或运行一条命令，就能自己
确认部署出来的协议与文档描述的是同一个协议——包括那个容易被实现错的细节：本轮
的区块单位按更新前的难度计价，事件里写出的难度则是更新后的值。仓鼠在轮子上跑的
每一步都变成了一个可以被公开复核的整数。
