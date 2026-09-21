/**
 * CLI-level test: everything the user actually types. smoke.mjs covers the math;
 * this file covers argument parsing, output, exit codes and completion.
 *
 * Runs against dist/cli.js, so it also proves the built entry point works.
 */
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { REGISTRY } from "../dist/registry.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const registry = fileURLToPath(new URL("../dist/registry.js", import.meta.url));
/** file:// URLs for the -e snippets below: a bare Windows path (C:\…) is not a valid specifier */
const cliUrl = new URL("../dist/cli.js", import.meta.url).href;
const registryUrl = new URL("../dist/registry.js", import.meta.url).href;
/** Run the CLI the way a user would, and give back stdout/stderr/status */
const sh = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
/**
 * Same thing, but async: the mock-RPC checks need it, because spawnSync blocks the event
 * loop — and the mock server lives in this very process, so a blocking spawn deadlocks.
 */
const execFileAsync = promisify(execFile);
const shAsync = async (...args) => {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
    return { status: 0, stdout, stderr };
  } catch (err) {
    return { status: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

let n = 0;
const ok = (label, cond, detail = "") => {
  assert.ok(cond, `${label}\n  ${detail}`);
  console.log(`  ✓ ${label}`);
  n++;
};
const has = (out, needle) => out.includes(needle);

const aliases = Object.values(REGISTRY).map((e) => e.alias);

// list: every function, plus the constants block
const listed = sh("list");
ok("list exits 0", listed.status === 0, listed.stderr);
ok("--version prints the package version", /^\d+\.\d+\.\d+$/.test(sh("--version").stdout.trim()), sh("--version").stdout);
ok(
  "list is ordered by usefulness, not alphabetically",
  listed.stdout.indexOf("  slot0") < listed.stdout.indexOf("  sqrtToPrice") &&
    listed.stdout.indexOf("  sqrtToPrice") < listed.stdout.indexOf("  tokensOwed") &&
    listed.stdout.indexOf("  tokensOwed") < listed.stdout.indexOf("  msb")
);
ok("list shows what each group is for", has(listed.stdout, "√P ↔ price ↔ tick") && has(listed.stdout, "swaps and fees"));
ok(
  "list stays one line per function — params belong to help",
  !listed.stdout.includes("--sqrtPriceX96") && !listed.stdout.includes("--tickSpacing"),
  listed.stdout
);
ok(
  `list mentions all ${aliases.length} functions`,
  aliases.every((a) => has(listed.stdout, a)),
  "some alias is missing from list"
);
ok("list prints the constants block", has(listed.stdout, "constants:") && has(listed.stdout, "MIN_TICK"));

// help: params explained + a copy-pasteable command
const helped = sh("help", "swapStep");
ok("help exits 0", helped.status === 0, helped.stderr);
ok("help shows the short name", has(helped.stdout, "swapStep"));
ok("help shows a runnable command", has(helped.stdout, "ready to run:") && has(helped.stdout, "v3sdk swapStep --"));

// named args, positional args and --json
const named = sh("sqrtRatioAtTick", "--tick", "246333");
ok("named args work", named.stdout.trim() === "17687452210211969913755435227879803", named.stdout);

const positional = sh("nearestTick", "246333", "60");
ok("positional args work", positional.stdout.trim() === "246360", positional.stdout);

const asJson = sh("sqrtToPrice", "--sqrtPriceX96", "17687452210211969913755435227879803", "--dec0", "6", "--dec1", "18", "--json");
ok("--json exits 0", asJson.status === 0, asJson.stderr);
let parsed;
try {
  parsed = JSON.parse(asJson.stdout);
} catch (err) {
  ok("--json emits valid JSON", false, String(err));
}
ok("--json emits valid JSON", parsed && typeof parsed === "object");
ok("--json has the price sentence", String(parsed.price).startsWith("1 token0 = "), JSON.stringify(parsed));

// failures: missing param, unknown function
const missing = sh("sqrtRatioAtTick");
ok("missing param exits 1", missing.status === 1, `status ${missing.status}`);
ok("missing param names the flag", has(missing.stderr, "missing param --tick"));
ok("missing param prints the full command", has(missing.stderr, "ready to run:") && has(missing.stderr, "v3sdk sqrtRatioAtTick --tick 246333"));

const typo = sh("swpStep");
ok("unknown function exits 1", typo.status === 1, `status ${typo.status}`);
ok("unknown function suggests the nearest name", has(typo.stderr, "did you mean: swapStep"));

// completion backend that zsh / bash / fish call into
const bare = sh("--complete");
ok("--complete lists the commands and every function", ["list", "help", "completion", ...aliases].every((c) => has(bare.stdout, c)));
ok("--complete filters by prefix", sh("--complete", "sw").stdout.trim() === "swapStep");
ok(
  "--complete -d adds a description after a tab",
  sh("--complete", "-d", "swapStep", "--li").stdout.trim() === "--liquidity\te.g. 138851799446300 · current L"
);
ok("--complete --prefix filters by the half-typed word", sh("--complete", "--prefix", "sw").stdout.trim() === "swapStep");
ok(
  "--complete --prefix takes whole words before it",
  sh("--complete", "-d", "swapStep", "--prefix", "").stdout.startsWith("--sqrtRatioCurrentX96\t")
);
ok(
  "--complete --prefix survives a dropped empty value (PS 5.1 quirk)",
  sh("--complete", "-d", "swapStep", "--prefix").stdout.startsWith("--sqrtRatioCurrentX96\t")
);

// the four completion scripts
for (const [shell, marker] of [
  ["zsh", "compdef _v3sdk v3sdk"],
  ["bash", "complete -F _v3sdk v3sdk"],
  ["fish", "complete -c v3sdk -f"],
  ["powershell", "Register-ArgumentCompleter -Native -CommandName v3sdk"],
]) {
  const script = sh("completion", shell);
  ok(`completion ${shell} emits a script`, script.status === 0 && has(script.stdout, marker), script.stderr);
}

// PowerShell only exists on Windows (or wherever pwsh is installed); when it does, parse the script
const psExe = process.platform === "win32" ? "powershell" : "pwsh";
if (spawnSync(psExe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).status === 0) {
  const parsed = spawnSync(
    psExe,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$errs=@(); [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$errs); if ($errs.Count -gt 0) { $errs | ForEach-Object { $_.Message }; exit 1 }",
    ],
    { input: sh("completion", "powershell").stdout, encoding: "utf8" }
  );
  ok("completion powershell parses", parsed.status === 0, parsed.stdout + parsed.stderr);
} else {
  console.log(`  · skipped the PowerShell parse check (${psExe} is not installed here; the Windows CI job runs it)`);
}

// importing the package must not run the CLI
const imported = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", `import ${JSON.stringify(cliUrl)};`],
  { encoding: "utf8" }
);
ok("importing cli.js has no side effects", imported.status === 0 && imported.stdout === "", imported.stdout + imported.stderr);

// the SDK is ~100 ms to load; `list` / `help` / completion and `slot0` must not need it
const lazy = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import ${JSON.stringify(registryUrl)};
     const { createRequire } = await import("node:module");
     const req = createRequire(import.meta.url);
     const loaded = Object.keys(req.cache).some((k) => k.includes("@uniswap/v3-sdk"));
     console.log(loaded ? "loaded" : "not loaded");`,
  ],
  { encoding: "utf8" }
);
ok("importing the table does not load the SDK", lazy.stdout.trim() === "not loaded", lazy.stdout + lazy.stderr);

// math commands load only the utils modules they need — never the barrel (that is ~100 ms)
const deep = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import { createRequire } from "node:module";
     const req = createRequire(import.meta.url);
     const { call } = await import(${JSON.stringify(registryUrl)});
     call("swapStep", {
       sqrtRatioCurrentX96: "17687452210211969913755435227879803",
       sqrtRatioTargetX96: "17308168878124134539469234982985700",
       liquidity: "138851799446300",
       amountRemaining: "1000000",
       feePips: 3000,
     });
     const mods = Object.keys(req.cache).filter((k) => k.includes("@uniswap/v3-sdk"));
     console.log(mods.some((k) => k.endsWith("src/index.js")) ? "barrel" : mods.length + " modules");`,
  ],
  { encoding: "utf8" }
);
ok("a math command loads modules, not the whole SDK", /^\d+ modules$/.test(deep.stdout.trim()), deep.stdout + deep.stderr);

// slot0 talks to an RPC, so stand up a tiny JSON-RPC mock and run the whole path through it
const word = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const abiString = (s) => `0x${word(32n)}${word(BigInt(s.length))}${Buffer.from(s, "utf8").toString("hex").padEnd(64, "0")}`;
// take the token examples straight from the registry so this test cannot drift from them
const example = (param) => REGISTRY["Pool.price"].params.find((q) => q.name === param).example.split(",");
const [USDT, USDT_DEC, USDT_SYM] = example("token0");
const [LINK, LINK_DEC, LINK_SYM] = example("token1");
const isLink = (to) => to.toLowerCase() === LINK.toLowerCase();
const pool = "0x4444444444444444444444444444444444444444";
const mock = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { method, params, id } = JSON.parse(body);
    if (method === "eth_blockNumber") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ jsonrpc: "2.0", id, result: "0x112a880" }));
    }
    if (method === "eth_getCode") {
      // the pool has code; anything else does not
      const result = params[0].toLowerCase() === pool.toLowerCase() ? "0x6080604052" : "0x";
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }
    const selector = params[0].data.slice(0, 10);
    const result = {
      "0x3850c7bd": "0x" + [17687452210211969913755435227879803n, 246333n, 0n, 1n, 1n, 0n, 1n].map(word).join(""), // slot0()
      "0x1a686502": "0x" + word(138851799446300n), // liquidity()
      "0xddca3f43": "0x" + word(500n), // fee()
      "0x0dfe1681": "0x" + word(USDT), // token0()
      "0xd21220a7": "0x" + word(LINK), // token1()
      "0x313ce567": "0x" + word(BigInt(isLink(params[0].to) ? LINK_DEC : USDT_DEC)), // decimals()
      "0x95d89b41": abiString(isLink(params[0].to) ? LINK_SYM : USDT_SYM), // symbol()
    }[selector];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result ? { jsonrpc: "2.0", id, result } : { jsonrpc: "2.0", id, error: { message: "no mock for " + selector } }));
  });
});
const mockUp = await new Promise((resolve) => {
  mock.once("error", () => resolve(false));
  mock.listen(0, "127.0.0.1", () => resolve(true));
});
if (mockUp) {
  const url = `http://127.0.0.1:${mock.address().port}`;

  const live = await shAsync("slot0", "--pool", pool, "--rpc", url);
  ok("slot0 exits 0 against a mock RPC", live.status === 0, live.stderr);
  ok("slot0 prints the price sentence", live.stdout.includes(`1 ${USDT_SYM} = 0.0498392377369 ${LINK_SYM}`), live.stdout);
  ok("slot0 prints the tick", live.stdout.includes("246333"), live.stdout);

  const liveJson = JSON.parse((await shAsync("slot0", "--pool", pool, "--rpc", url, "--json")).stdout);
  ok("slot0 --json carries the raw sqrtPriceX96", liveJson.slot0.sqrtPriceX96 === "17687452210211969913755435227879803", JSON.stringify(liveJson));
  ok(
    "slot0 --json carries liquidity and both tokens (EIP-55 checksummed, ready to paste as token params)",
    liveJson.liquidity === "138851799446300" &&
      liveJson.token0 === `${USDT},${USDT_DEC},${USDT_SYM}` &&
      liveJson.token1 === `${LINK},${LINK_DEC},${LINK_SYM}`
  );
  ok("slot0 --json carries the fee tier and block", liveJson.fee === "0.05% (500)" && liveJson.block === "18000000", JSON.stringify(liveJson));
  ok(
    "slot0 --json carries the whole slot0 tuple",
    liveJson.slot0.tick === 246333 &&
      liveJson.slot0.observationIndex === 0 &&
      liveJson.slot0.observationCardinality === 1 &&
      liveJson.slot0.observationCardinalityNext === 1 &&
      liveJson.slot0.feeProtocol === "off (0)" &&
      liveJson.slot0.unlocked === true,
    JSON.stringify(liveJson)
  );

  const dead = await shAsync("slot0", "--pool", pool, "--rpc", "http://127.0.0.1:1");
  ok("an unreachable RPC fails with a readable message", dead.status === 1 && dead.stderr.includes("cannot reach"), dead.stderr);

  const noCode = await shAsync("slot0", "--pool", "0x000000000000000000000000000000000000dEaD", "--rpc", url);
  ok(
    "an address with no contract says so",
    noCode.status === 1 && noCode.stderr.includes("has no code on this chain"),
    noCode.stderr
  );
  mock.close();
} else {
  console.log("  · skipped the mock-RPC checks (cannot listen on localhost here; they run in CI)");
}

console.log(`\nall passed: ${n} checks`);
