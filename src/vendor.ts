/**
 * Lazy loader for the official SDK.
 *
 * Loading @uniswap/v3-sdk costs ~100 ms (167 modules), and `list`, `help`, completion and
 * `slot0` never need it — so nothing is required until a command that does SDK math runs.
 * That is the whole difference between a 140 ms command and a 45 ms one, which matters when
 * another program shells out to this CLI in a loop.
 *
 * Why createRequire and not a plain import: the ESM build published by @uniswap/* uses
 * extensionless directory imports (e.g. `dist/esm/src/entities`), which Node's native ESM
 * rejects with ERR_UNSUPPORTED_DIR_IMPORT. The CJS build is fine, and types still come from
 * the official .d.ts files.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { keccak256 } from "@ethersproject/keccak256";

const require = createRequire(import.meta.url);

let v3Cache: typeof import("@uniswap/v3-sdk") | undefined;
let coreCache: typeof import("@uniswap/sdk-core") | undefined;
let jsbiCache: typeof import("jsbi") | undefined;

/** @uniswap/v3-sdk, loaded on first use */
export const v3 = (): typeof import("@uniswap/v3-sdk") =>
  (v3Cache ??= require("@uniswap/v3-sdk") as typeof import("@uniswap/v3-sdk"));

/** @uniswap/sdk-core, loaded on first use (Token, Price, address validation) */
export const core = (): typeof import("@uniswap/sdk-core") =>
  (coreCache ??= require("@uniswap/sdk-core") as typeof import("@uniswap/sdk-core"));

/**
 * ⚠️ There is more than one copy of jsbi (a top-level one plus one nested inside
 * @uniswap/v3-sdk). The SDK type-checks with `constructor === JSBI`, so handing it the wrong
 * copy makes it treat a JSBI as a plain object and fail. Requiring it relative to v3-sdk
 * gives us the copy the SDK itself uses. Our own arithmetic uses native BigInt and never
 * touches this.
 */
export const jsbi = (): typeof import("jsbi") => {
  if (!jsbiCache) {
    const fromSdk = createRequire(require.resolve("@uniswap/v3-sdk"));
    jsbiCache = fromSdk("jsbi") as typeof import("jsbi");
  }
  return jsbiCache;
};

let sdkRootDir: string | undefined;

/** The package root of @uniswap/v3-sdk — require.resolve gives the entry file, not the root */
const sdkRoot = (): string => {
  if (!sdkRootDir) {
    try {
      sdkRootDir = dirname(require.resolve("@uniswap/v3-sdk/package.json"));
    } catch {
      sdkRootDir = join(dirname(require.resolve("@uniswap/v3-sdk")), "..", "..", ".."); // dist/cjs/src/index.js
    }
  }
  return sdkRootDir;
};

/**
 * One module from `@uniswap/v3-sdk/dist/cjs/src/utils/*` instead of the package barrel.
 *
 * The barrel drags in 167 modules (~100 ms); a utils module is 5–20 ms. Every symbol we
 * use lives in one of them, and they export the same names, so the types stay identical.
 * If a future version reshuffles `dist/`, the try/catch silently falls back to the barrel —
 * correct, just slower — and the test suite (which runs every function) would still pass.
 */
export const util = (name: string): typeof import("@uniswap/v3-sdk") => {
  try {
    return require(`${sdkRoot()}/dist/cjs/src/utils/${name}.js`) as typeof import("@uniswap/v3-sdk");
  } catch {
    return v3();
  }
};

/** EIP-55 checksum, without pulling in sdk-core (which costs ~20 ms) for one string op */
export function checksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, "");
  if (lower.length !== 40) throw new Error(`not an address: ${address}`);
  const hash = keccak256(Buffer.from(lower, "utf8")).slice(2);
  let out = "0x";
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}
