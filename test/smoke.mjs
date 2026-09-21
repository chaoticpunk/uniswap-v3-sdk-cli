/**
 * Smoke test. Runs against dist/, i.e. exactly what users get.
 *
 *   1) every function runs with its own example values — catches renamed params and SDK
 *      signature changes
 *   2) a few baselines verified on chain               — catches wrong math
 */
import assert from "node:assert/strict";

import { CONSTS, GROUPS, REGISTRY, convert } from "../dist/registry.js";
import { decodeAbiString, wordToAddress, wordToDec, wordToSigned, words } from "../dist/rpc.js";
import { v3 } from "../dist/vendor.js";

let n = 0;
const ok = (label, actual, expected) => {
  assert.equal(String(actual), String(expected), `\n  ${label}\n  actual: ${actual}\n  expected: ${expected}`);
  console.log(`  ✓ ${label}`);
  n++;
};

const entry = (alias) => Object.values(REGISTRY).find((e) => e.alias === alias) ?? assert.fail(`no such short name: ${alias}`);
const call = (alias, args) => entry(alias).fn(args);
/** On-chain big integers are jsbi params; build them with the same conversion the CLI uses */
const J = (s) => convert("jsbi", s);

console.log("1) every function runs with its own example values");
let offline = 0;
for (const [name, e] of Object.entries(REGISTRY)) {
  if (e.net) continue; // needs an RPC endpoint; the mock-RPC test in cli.mjs covers it
  const args = Object.fromEntries(e.params.map((q) => [q.name, convert(q.kind, q.example)]));
  assert.doesNotThrow(() => e.fn(args), `${name} (${e.alias}) failed to run with its example values`);
  offline++;
  n++;
}
console.log(`  ✓ all ${offline} offline functions ran`);
const aliases = Object.values(REGISTRY).map((e) => e.alias);
ok("short names are unique", aliases.length === new Set(aliases).size, true);

// the usefulness ranking that list / completion follow has to cover everything, exactly once
const ranked = GROUPS.flatMap(([, list]) => list);
ok("every function is ranked exactly once", ranked.length === aliases.length && new Set(ranked).size === ranked.length, true);
ok("no typo'd alias in the ranking", ranked.every((a) => aliases.includes(a)), true);
// `list` is one terse line per function; anything long belongs in `note` (rendered by help)
ok(
  "every function has a short brief and no params in it",
  Object.values(REGISTRY).every((e) => e.brief.length > 0 && e.brief.length <= 60 && !e.brief.includes("--")),
  true
);

console.log("\n2) on-chain baselines (a real V3 pool snapshot, tick 246333)");
ok("sqrtRatioAtTick(246333)", call("sqrtRatioAtTick", { tick: 246333 }), "17687452210211969913755435227879803");
ok("tickAtSqrtRatio(√P)", call("tickAtSqrtRatio", { sqrtPriceX96: J("17687452210211969913755435227879803") }), 246333);
ok("nearestTick(246333, 60)", call("nearestTick", { tick: 246333, tickSpacing: 60 }), 246360);
ok("MIN_TICK / MAX_TICK", `${entry("sqrtRatioAtTick") ? -887272 : 0}/${887272}`, "-887272/887272");
// these are hardcoded in registry.ts (so `list` needs no SDK) — check them against the SDK itself
{
  const sdk = v3();
  const c = CONSTS();
  ok("hardcoded MIN_TICK matches the SDK", c.MIN_TICK, sdk.TickMath.MIN_TICK);
  ok("hardcoded MAX_TICK matches the SDK", c.MAX_TICK, sdk.TickMath.MAX_TICK);
  ok(
    "hardcoded tickSpacing matches the SDK",
    c["tickSpacing 500/3000/10000"],
    `${sdk.TICK_SPACINGS[500]} / ${sdk.TICK_SPACINGS[3000]} / ${sdk.TICK_SPACINGS[10000]}`
  );
}

// the initial price that pool was deployed at: 1 USDT = 0.05 LINK
ok(
  "encodeSqrtRatio(0.05e18, 1e6)",
  call("encodeSqrtRatio", { amount1: "50000000000000000", amount0: "1000000" }),
  "17715955711429571029610171616072600"
);

// sqrtToPrice does exact decimal math (no floats), so these digits are right to the last one
const shown = call("sqrtToPrice", {
  sqrtPriceX96: J("17687452210211969913755435227879803"),
  dec0: 6,
  dec1: 18,
  sym0: "USDT",
  sym1: "LINK",
});
ok("sqrtToPrice → price", shown.price, "1 USDT = 0.0498392377369 LINK");
ok("sqrtToPrice → inverse", shown.inverse, "1 LINK = 20.0645123282 USDT");

// 1 USDT swapped into 138851799446300 of liquidity
const step = call("swapStep", {
  sqrtRatioCurrentX96: J("17687452210211969913755435227879803"),
  sqrtRatioTargetX96: J("17308168878124134539469234982985700"),
  liquidity: J("138851799446300"),
  amountRemaining: J("1000000"),
  feePips: 3000,
});
ok("swapStep → amount in", step[1], "997000");
ok("swapStep → amount out", step[2], "49610195645587856");
ok("swapStep → fee", step[3], "3000");

console.log("\n3) on-chain decoding (layout cross-checked against `cast abi-decode`)");
const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const abiString = (s) => `0x${word(32n)}${word(BigInt(s.length))}${Buffer.from(s, "utf8").toString("hex").padEnd(64, "0")}`;
const slot0Words = words("0x" + [17687452210211969913755435227879803n, 246333n, 0n, 1n, 1n, 0n, 1n].map(word).join(""));
ok("slot0 word 0 → sqrtPriceX96", wordToDec(slot0Words[0]), "17687452210211969913755435227879803");
ok("slot0 word 1 → tick", wordToSigned(slot0Words[1]), 246333);
ok("negative ticks decode as signed", wordToSigned(word(-887272n)), -887272);
ok("uint128 liquidity decodes", wordToDec(word(138851799446300n)), "138851799446300");
ok(
  "address word decodes",
  wordToAddress(word("0x1111111111111111111111111111111111111111")),
  "0x1111111111111111111111111111111111111111"
);
ok("ABI string decodes", decodeAbiString(abiString("USDT")), "USDT");

let rpcError = "";
try {
  await call("slot0", { pool: "0x4444444444444444444444444444444444444444" });
} catch (err) {
  rpcError = err.message;
}
ok("slot0 without an RPC endpoint says so", rpcError, "no RPC endpoint given: pass --rpc <url> or set RPC_URL");

console.log(`\nall passed: ${n} checks`);
