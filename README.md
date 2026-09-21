# uniswap-v3-sdk-cli

[![CI](https://github.com/chaoticpunk/uniswap-v3-sdk-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/chaoticpunk/uniswap-v3-sdk-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/uniswap-v3-sdk-cli)](https://www.npmjs.com/package/uniswap-v3-sdk-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[中文说明](README.zh.md)

Turn the functions of [`@uniswap/v3-sdk`](https://github.com/Uniswap/sdks) into a command line: **name the function, pass only the params it needs**.

```bash
$ v3sdk sqrtRatioAtTick --tick 246333
17687452210211969913755435227879803

$ v3sdk swapStep --sqrtRatioCurrentX96 17687452210211969913755435227879803 \
  --sqrtRatioTargetX96 17308168878124134539469234982985700 \
  --liquidity 138851799446300 --amountRemaining 1000000 --feePips 3000
[17659144873478511247396769043304980, 997000, 49610195645587856, 3000]
```

No keys, no wallet, no transactions. Every command is offline math except `slot0`, which does a few read-only `eth_call`s when you hand it an RPC URL.

## The ones you'll reach for

Ranked by what V3 work actually needs, most useful first:

| | command | the question it answers |
| --- | --- | --- |
| 1 | `slot0 --pool 0x… --rpc …` | what is this pool trading at right now — price, tick, liquidity, fee tier, block |
| 2 | `sqrtToPrice --sqrtPriceX96 … --dec0 … --dec1 …` | that big √P → a readable price, both directions |
| 3 | `tickToPrice --baseToken … --quoteToken … --tick …` | a tick → a readable price |
| 4 | `priceToSqrt --num 1 --den 20 --dec0 … --dec1 …` | the price I want → the √P to set |
| 5 | `priceToTick …` | the price I want → the nearest tick |
| 6 | `sqrtRatioAtTick` / `tickAtSqrtRatio` | tick ↔ √P, the two primitives underneath everything |
| 7 | `positionFromAmounts` / `maxLiquidity` | I have these amounts — how much liquidity do I get |
| 8 | `nearestTick --tick … --tickSpacing …` | snap a range endpoint (skip it and the mint reverts) |
| 9 | `amount0Delta` / `amount1Delta` | how much of each token a move across the range costs |
| 10 | `swapStep` / `nextSqrtFromIn` | what one swap does to the price (impact, slippage) |
| 11 | `tokensOwed` / `feeGrowthInside` | what fees a position has earned |
|  | `poolAddress`, `encodeSqrtRatio`, `addDelta`, `nextTickInWord`, `mulDivUp`, `msb`, `toHex`, `poolPrice` | utilities |

`v3sdk list` prints exactly this order with the same headings — one short line per function, no parameter soup; params live in `help`. The Tab completion popup follows the same order and the same one-liners. The ranking lives in one place — `GROUPS` in `src/registry.ts` — so the CLI, the completion and this table cannot drift apart.

## Install

Node 20 or newer.

```bash
npm i -g github:chaoticpunk/uniswap-v3-sdk-cli   # installs the v3sdk command
# or, after cloning: npm install && npm link
# no global install: clone, npm install, then use `node dist/cli.js <args>`
```

Once published to npm: `npx uniswap-v3-sdk-cli list`.

## Usage

```bash
v3sdk list [keyword]         # every function, most useful first, grouped by what it is for
v3sdk help <function>        # params explained, plus a command you can copy
v3sdk <function> --p val     # or positional args, in declaration order
v3sdk <function> ... --json  # machine-readable
v3sdk <function> --p <Tab>   # Tab completion for function and param names
v3sdk slot0 --pool 0x… --rpc https://…   # read a pool straight from chain
```

The function name is the short name in the first column of `list` (class prefix and `get` dropped: `TickMath.getSqrtRatioAtTick` → `sqrtRatioAtTick`). The SDK name works too.

Install completion once (the script just forwards to the CLI, so new functions show up automatically):

```bash
v3sdk completion zsh  > ~/.v3sdk-completion.zsh  && echo 'source ~/.v3sdk-completion.zsh' >> ~/.zshrc
v3sdk completion bash > ~/.v3sdk-completion.bash && echo 'source ~/.v3sdk-completion.bash' >> ~/.bashrc
v3sdk completion fish > ~/.config/fish/completions/v3sdk.fish   # fish loads this dir automatically
```

```powershell
# PowerShell (Windows)
v3sdk completion powershell | Out-File -Encoding utf8 -Append $PROFILE
```

Candidates come with hints: a function shows what it does, a param shows `e.g. <value> · <what it is>` (zsh, fish and PowerShell). Miss a param and it prints the whole runnable command; misspell a function and it suggests the nearest one.

### Reading a pool

`slot0` is the one command that uses the network. Give it a pool and an RPC endpoint (or `export RPC_URL=…`) and it reads `slot0()`, `liquidity()`, `fee()`, `token0()`, `token1()`, `decimals()`, `symbol()` and the current block, then prints the same price sentences as `sqrtToPrice`:

```bash
# (example output — the addresses are placeholders; the format is what matters)
$ v3sdk slot0 --pool 0x4444444444444444444444444444444444444444 --rpc $RPC_URL
pool          0x4444444444444444444444444444444444444444
token0        0x1111111111111111111111111111111111111111,6,USDT
token1        0x2222222222222222222222222222222222222222,18,LINK
fee           0.3% (3000)
block      11748642
slot0
  sqrtPriceX96                17687557139328715823496784815151794
  tick                        246333
  observationIndex            279
  observationCardinality      360
  observationCardinalityNext  360
  feeProtocol                 1/6 both sides (102)
  unlocked                    true
price      1 USDT = 0.0498398290716 LINK
inverse    1 LINK = 20.0642742687 USDT
liquidity  138851799446300
```

Read it in three parts: **which pool** (address, tokens, fee tier, block), **what `slot0()` returned** — kept together as one indented block, in ABI order, with `feeProtocol` unpacked because a raw byte tells you nothing — and **what we derived** (both price directions and liquidity). The token lines are already in the `address,decimals,symbol` form the other commands take. In `--json` the same three parts are one object, with the tuple under `slot0`. Nothing signed, nothing sent, no key involved — just `eth_call`s, `eth_getCode` and `eth_blockNumber`.

A handy sanity check: `v3sdk tickAtSqrtRatio --sqrtPriceX96 <the value above>` should equal the `tick` field it printed.

It checks the address has code before reading (so a typo or the wrong network gives you `that address has no code on this chain` instead of a pile of confusing empty results), and gives up after 20 s rather than hanging on a dead endpoint.

**Two ground rules**

1. **Prices are always written as a sentence**, never a bare number: `1 USDT = 0.0498392377369 LINK`. The chain only stores `sqrtPriceX96 = √(token1/token0) × 2^96`; `sqrtToPrice` turns that into both directions in words, using exact integer arithmetic — no floats, so the digits it shows are right to the last one. `token0`/`token1` everywhere follow the same convention (token0 = the lower address).
2. **Params come in five flavors**: numbers/booleans as-is, big integers as decimal strings (negatives fine), `token` as `address,decimals,symbol[,chainId]`, JSON as-is, strings as-is. Square brackets mean optional, with a default.

## Adding a function

Add one entry to `src/registry.ts`; `list` / `help` / arg parsing / completion / the smoke test all follow. Then add its short name to `GROUPS` — that is the ranking `list` and completion are sorted by. Until you do, the new function shows up at the bottom under “other”, and a test reminds you. Keep `brief` to one short line (what `list` and the completion popup show) and put the detail in `note` (what `help` shows):

```ts
"SqrtPriceMath.getAmount0Delta": {
  alias: "amount0Delta",
  brief: "token0 needed to move across a range",
  note: "how much token0 a given liquidity corresponds to while the price moves from √Pa to √Pb",
  params: [
    p("sqrtRatioAX96", "jsbi", "176874…"),
    p("sqrtRatioBX96", "jsbi", "179140…"),
    p("liquidity", "jsbi", "138851799446300"),
    p("roundUp", "bool", "false"),
  ],
  fn: (a) => SqrtPriceMath.getAmount0Delta(a.sqrtRatioAX96, a.sqrtRatioBX96, a.liquidity, a.roundUp),
},
```

## Tests

```bash
npm test        # builds, then runs both suites
npm run build   # emits dist/
```

`test/smoke.mjs` checks the math (every offline function with its example values, the on-chain decoders, plus baselines copied from chain) and the shape of the table itself (every function ranked once, every `brief` short, the hardcoded protocol constants match the SDK). `test/cli.mjs` checks what you actually type: argument parsing, `--json`, exit codes, the completion backend, `--version`, that importing the package has no side effects, that the SDK stays lazy and that math commands load modules rather than the barrel — including the whole `slot0` path against a mock JSON-RPC server. 90 checks in total.

The tool is not tied to any pool — pass whatever values you like. The expected values in the test were read from a real V3 pool once (at tick 246333) and frozen, purely as an anchor: if the SDK ever computes something wrong, the test goes red immediately.

## Using it as a library

You read the chain; it does the math. Params take plain decimal strings, so you never import jsbi yourself:

```js
import { call, plain } from "uniswap-v3-sdk-cli";

// slot0 / liquidity come from your own provider
plain(call("sqrtToPrice", { sqrtPriceX96: slot0.sqrtPriceX96, dec0: 6, dec1: 18 }));
// { price: '1 token0 = 0.0498392377369 token1', inverse: '1 token1 = 20.0645123282 token0' }

plain(call("swapStep", {
  sqrtRatioCurrentX96: slot0.sqrtPriceX96,
  sqrtRatioTargetX96: "17308168878124134539469234982985700",
  liquidity,
  amountRemaining: "1000000",
  feePips: 3000,
}));
// [ '17659144873478511247396769043304980', '997000', '49610195645587856', '3000' ]
```

- `call(shortNameOrSdkName, args)` — both `swapStep` and `SwapMath.computeSwapStep` work.
- `plain(v)` — JSBI becomes a decimal string, Price becomes a `1 A = x B` sentence. Skip it if you want the raw values back.
- `slot0` is the only async entry: `await call("slot0", { pool, rpc })`. Everything else returns synchronously.
- To walk the table yourself: `import { REGISTRY, resolve, convert } from "uniswap-v3-sdk-cli"`; every entry is `{ alias, note, params, fn }`.
- Install: `npm i github:chaoticpunk/uniswap-v3-sdk-cli`; for local dev, `npm link uniswap-v3-sdk-cli`. Types ship with the package (`dist/registry.d.ts`).

## Speed, and calling this from other programs

Start-up is the cost that matters when something else shells out to this tool (M-series Mac, warm cache, best of 5):

| | |
| --- | --- |
| bare `node` (the floor) | ~25 ms |
| `list`, `help`, Tab completion | 30–40 ms |
| `slot0` (plus one round trip to your RPC) | ~50 ms |
| `sqrtRatioAtTick`, `swapStep`, `maxLiquidity`, `tickToPrice` | 40–60 ms |
| `poolPrice`, `positionFromAmounts` (need SDK entities) | ~100 ms |

Two things keep it there, and the tests lock both in:

- **The SDK is lazy.** Loading all of `@uniswap/v3-sdk` costs ~100 ms across 167 modules, and `list` / `help` / completion / `slot0` never need it.
- **Math commands load single modules, not the barrel.** `swapStep` pulls `utils/swapMath.js` and its dependencies — 5 modules instead of the whole package. If a future SDK version moves those files, the loader falls back to the barrel: correct, just slower.

(`poolPrice` and `positionFromAmounts` genuinely need the SDK's `Pool` / `Position` entities, so they pay the full load.)

**If your project calls these in a loop, don't spawn 100 processes — import the package:**

```js
import { call, plain } from "uniswap-v3-sdk-cli";

const prices = ticks.map((tick) => plain(call("sqrtRatioAtTick", { tick })));
```

Measured: 50 calls inside one process = **0.06 s**; 50 CLI spawns = **3.2 s**. Same numbers, ~50× the wall time.

**If you do shell out**, these are the parts meant to be depended on:

- `--json` on any command → a single JSON object on stdout, nothing else.
- exit code `0` = success, `1` = failure, with a readable message on stderr.
- `v3sdk --version` → the package version, if you need to check capabilities.

## Four known traps (already handled in the code)

1. **The official ESM build breaks under Node's native ESM** (`ERR_UNSUPPORTED_DIR_IMPORT`, from extensionless directory imports). So `src/vendor.ts` loads the CJS build through `createRequire`; types still come from the official `.d.ts`.
2. **JSBI extends `Array`**: when formatting output you must test for JSBI before testing for arrays, or results print as a list of internal ints.
3. **The second param of `swapStep` is the price you are moving towards**; get the direction wrong and `out` comes back `0` (the target should be lower when selling token0).
4. **There is more than one copy of jsbi**: `@uniswap/v3-sdk` nests its own, and the SDK type-checks with `constructor === JSBI`, so the top-level copy gets rejected. `src/vendor.ts` requires it relative to v3-sdk.

## Verifying it yourself

It never touches your keys or your files, and exactly one file can touch the network — but don't take this README's word for it:

```bash
# 1. one file does networking, and nothing spawns a shell or evals a string
grep -rlE 'fetch\(|process\.env' src/                        # → src/rpc.ts, src/registry.ts (the latter only reads $RPC_URL)
grep -rnE 'child_process|eval\(|writeFile' src/ || echo "no shell, no eval, no file writes"

# 2. the offline commands still answer with networking denied (macOS; on Linux try `unshare -n`)
sandbox-exec -p '(version 1)(allow default)(deny network*)' node dist/cli.js sqrtRatioAtTick --tick 246333
# 17687452210211969913755435227879803

# 3. install without running any dependency install scripts
npm ci --ignore-scripts && npm run build
```

`slot0` is the deliberate exception, and it has to be — reading a pool is an `eth_call`. Everything else runs with the network unplugged.

The completion scripts are just as boring: they pass the words you typed as argv to `v3sdk --complete` and print what comes back. No `eval`, no shell string building, nothing that turns your input into an executable command.

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the two rules that matter (keep `brief` to one line; rank new functions in `GROUPS`). Security reports go through [SECURITY.md](SECURITY.md), and changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
