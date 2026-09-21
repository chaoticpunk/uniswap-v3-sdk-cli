# Changelog

Notable changes are recorded here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/) — the CLI output and the `--json` shape are the public API.

## [0.1.0] - 2026-09-21

First release.

### Added

- `v3sdk <function>` for 25 Uniswap V3 SDK calls: tick ↔ √P ↔ price, liquidity and position
  amounts, swap steps, fee accounting, pool address computation and helpers.
- `v3sdk slot0 --pool … --rpc …` — the only command that uses the network. Prints the full
  `slot0()` tuple (with `feeProtocol` unpacked), both price directions and the current liquidity.
- `v3sdk list` grouped by usefulness with one terse line per function, and `v3sdk help <fn>` with
  parameters, example values and a command you can copy.
- Tab completion for zsh, bash, fish and PowerShell, with hints and a prefix-safe protocol.
- Library entry point: `import { call, plain } from "uniswap-v3-sdk-cli"`.
- `--json`, `--version` and stable exit codes for scripting.
- English README (`README.zh.md` for Chinese), CI on Linux/macOS/Windows × Node 20/22/24.

### Notes

- Prices are computed in exact integer arithmetic — no floats — and printed to 12 significant
  digits; `slot0` also returns the raw `sqrtPriceX96`, `tick` and `liquidity`.
- Start-up is 30–50 ms for the metadata commands and ~60 ms when SDK math is involved (the SDK is
  lazy, and math commands load single modules rather than the package barrel).
