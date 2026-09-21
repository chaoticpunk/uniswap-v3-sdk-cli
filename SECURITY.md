# Security

## What this tool does, and does not do

- It holds **no keys** and never signs or sends a transaction.
- Every command except `slot0` is offline math. `slot0` makes read-only `eth_call`,
  `eth_getCode` and `eth_blockNumber` requests to the RPC endpoint you pass it.
- Nothing is written to disk. The completion scripts pass the words you typed as argv — there is
  no `eval`, no shell string building, nothing that turns your input into a command.

## The one real trust boundary

`npm install` runs the install scripts of the dependency tree (`keccak` comes in through
`@uniswap/v3-sdk`, and ships prebuilt binaries for darwin/linux/win32-x64). To skip all install
scripts entirely:

```bash
npm ci --ignore-scripts && npm run build
```

## Verifying it yourself

```bash
# one file does networking, and nothing spawns a shell or evals a string
grep -rlE 'fetch\(|process\.env' src/
grep -rnE 'child_process|eval\(|writeFile' src/ || echo "no shell, no eval, no file writes"

# the offline commands still answer with networking denied (macOS; Linux: unshare -n)
sandbox-exec -p '(version 1)(allow default)(deny network*)' node dist/cli.js sqrtRatioAtTick --tick 246333
```

## Reporting

Please use GitHub's private vulnerability reporting (the **Security** tab → *Report a
vulnerability*) rather than a public issue.
