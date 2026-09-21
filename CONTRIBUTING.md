# Contributing

Small tool, small rules.

## Setup

```bash
npm install      # the prepare hook builds dist/
npm test         # 90 checks: math, on-chain decoding, CLI behaviour
npm run typecheck
npm link         # optional: puts `v3sdk` on your PATH
```

## Adding a function

Everything user-facing lives in `src/registry.ts`. Add one entry, then add its short name to `GROUPS`:

```ts
"SwapMath.computeSwapStep": {
  alias: "swapStep",
  brief: "one swap step → new √P, in, out, fee",  // one line, no params — what `list` shows
  note: "…",                                       // the long version — what `help` shows
  params: [p("sqrtRatioCurrentX96", "jsbi", "176874…"), /* … */],
  fn: (a) => util("swapMath").SwapMath.computeSwapStep(a.sqrtRatioCurrentX96, /* … */),
},
```

- `list` / `help` / completion / the smoke test pick it up automatically.
- The smoke test runs your function with its own example values, so a wrong parameter name or an
  SDK signature change shows up immediately.
- Forget `GROUPS` and the function lands at the bottom under “other” — a test reminds you.
- Only `slot0` may touch the network. Anything that needs an RPC endpoint must set `net: true`
  so the offline test run knows to skip it.

## Pull requests

- `npm test` must be green; it is the whole safety net.
- Keep the output terse: new text goes in `brief` (one line) or `note`, never both.
- If it could affect start-up, say so with a number in the PR. The metadata commands should stay
  under ~50 ms, and `node test/cli.mjs` carries the lazy-loading and barrel guards.

## Releasing

The CLI output and the `--json` shape are the public API; version bumps follow semver.

```bash
npm version patch -m "v%s" && git push --follow-tags
```
