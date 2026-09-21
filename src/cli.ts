#!/usr/bin/env node
/**
 * A generic command-line caller for the Uniswap V3 SDK.
 *
 *   v3sdk list [keyword]          # every function: signature + one line
 *   v3sdk help <function>         # one function: what each param is, plus a runnable command
 *   v3sdk <function> --param val  # named args (or positional, in declaration order)
 *   v3sdk <function> ... --json   # machine-readable output
 *
 * Price-shaped output is always a sentence (`1 USDT = 0.0498 LINK`), never a bare number.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { CONSTS, GROUPS, ORDERED, REGISTRY, convert, plain, resolve, type Entry, type Param } from "./registry.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/**
 * Text form: arrays on one line, objects as aligned `key  value` lines.
 * A nested object becomes its own indented block under the key, so groups like
 * `slot0` read as one unit instead of leaking into the lines around them.
 */
const asText = (v: unknown, indent = ""): string => {
  if (Array.isArray(v)) return `[${v.map((x) => asText(x, indent)).join(", ")}]`;
  if (!v || typeof v !== "object") return String(v);
  const rows = Object.entries(v);
  const width = Math.max(...rows.map(([k]) => k.length));
  return rows
    .map(([k, val]) => {
      const nested = val !== null && typeof val === "object" && !Array.isArray(val);
      return nested
        ? `${indent}${k}\n${asText(val, `${indent}  `)}`
        : `${indent}${k.padEnd(width)}  ${asText(val, indent)}`;
    })
    .join("\n");
};

/** Guess the closest short name for a typo (only when the edit distance is ≤ 3) */
function nearest(input: string): string {
  const dist = (a: string, b: string): number => {
    const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const best = Object.values(REGISTRY)
    .map((e) => ({ alias: e.alias, d: dist(input.toLowerCase(), e.alias.toLowerCase()) }))
    .sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 3 ? best.alias : "";
}

/** A ready-to-copy command line, using the short name */
const signature = (e: Entry): string =>
  `v3sdk ${e.alias}${e.params
    .map((q) => {
      const bit = `--${q.name}${q.example ? ` ${q.example}` : ""}`;
      return q.optional ? ` [${bit}]` : ` ${bit}`;
    })
    .join("")}`;

const CMDS: Record<string, string> = {
  list: "every function: short name + params + one line",
  help: "params for one function, plus a ready-made command",
  completion: "print a Tab-completion script (zsh / bash / fish)",
};
/** Trim long example values so the description column stays readable */
const short = (s: string, n = 22): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Completion candidates: v3sdk --complete [-d] <words typed so far...>
 *   -d emits "candidate<Tab>description"; zsh and fish show it next to the candidate
 *   --prefix <partial>  put the half-typed word last, separately from whole words.
 *                       Windows PowerShell 5.1 drops empty arguments passed to native
 *                       programs, so a missing value is read as an empty prefix.
 */
function complete(argv: string[], withDesc: boolean): void {
  const clean = argv.filter((x) => x !== "-d");
  const p = clean.indexOf("--prefix");
  const prior = p >= 0 ? clean.slice(0, p) : clean.slice(0, -1);
  const prefix = p >= 0 ? (clean[p + 1] ?? "") : (clean[clean.length - 1] ?? "");
  const key = prior.length ? resolve(prior[0]) : "";
  const pairs: [string, string][] =
    prior[0] === "completion"
      ? [
          ["zsh", "zsh completion"],
          ["bash", "bash completion"],
          ["fish", "fish completion"],
          ["powershell", "PowerShell completion"],
        ]
      : key
        ? [
            ...REGISTRY[key].params.map(
              (q) =>
                [
                  `--${q.name}`,
                  `e.g. ${short(q.example)}${q.desc ? ` · ${q.desc}` : ""}${q.optional ? " (optional)" : ""}`,
                ] as [string, string]
            ),
            ["--json", "machine-readable output"],
          ]
        : [
            ...Object.entries(CMDS).map(([c, d]) => [c, d] as [string, string]),
            ...ORDERED().map(({ entry }) => [entry.alias, entry.brief] as [string, string]), // same ranking as list
          ];
  const hit = pairs.filter(([c]) => c.startsWith(prefix));
  console.log(hit.map(([c, d]) => (withDesc ? `${c}\t${d}` : c)).join("\n"));
}

/** The completion scripts themselves: eval "$(v3sdk completion zsh)" */
const COMPLETION: Record<string, string> = {
  zsh: `#compdef v3sdk
(( $+functions[compdef] )) || { autoload -Uz compinit; compinit; }
_v3sdk() {
  local -a vals descs
  local line
  for line in "\${(@f)$(v3sdk --complete -d $words[2,-1] 2>/dev/null)}"; do
    [[ -z $line ]] && continue
    vals+=("\${line%%$'\\t'*}")
    descs+=("\${line#*$'\\t'}")
  done
  (( \${#vals} )) && compadd -d descs -a vals
}
compdef _v3sdk v3sdk`,
  bash: `_v3sdk() {
  local out
  out=$(v3sdk --complete "\${COMP_WORDS[@]:1}")
  COMPREPLY=($(compgen -W "$out" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _v3sdk v3sdk`,
  fish: `function __v3sdk_complete
    set -l prior (commandline -opc)
    set -l cur (commandline -ct)
    v3sdk --complete -d $prior[2..-1] "$cur" 2>/dev/null
end
complete -c v3sdk -f -a '(__v3sdk_complete)'`,
  powershell: `Register-ArgumentCompleter -Native -CommandName v3sdk -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $prior = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.Extent.Text })
    # the word being completed is the last AST element; drop it and pass it as --prefix
    if ($prior.Count -gt 0 -and $prior[$prior.Count - 1] -eq $wordToComplete) {
        $prior = if ($prior.Count -eq 1) { @() } else { $prior[0..($prior.Count - 2)] }
    }
    # --prefix goes last and its value may be dropped by PowerShell 5.1, which is fine
    v3sdk --complete -d @prior --prefix "$wordToComplete" 2>$null | ForEach-Object {
        $parts = $_ -split "\`t", 2
        $desc = if ($parts.Count -gt 1) { $parts[1] } else { $parts[0] }
        [System.Management.Automation.CompletionResult]::new($parts[0], $parts[0], 'ParameterValue', $desc)
    }
}`,
};

/** Terse listing: grouped by usefulness, two lines per function */
function list(filter?: string): void {
  const f = filter?.toLowerCase();
  const byAlias = new Map(Object.values(REGISTRY).map((e) => [e.alias, e]));
  const hit = (e: Entry) => !f || e.alias.toLowerCase().includes(f) || e.note.toLowerCase().includes(f);

  let counted = 0;
  const row = (e: Entry) => {
    console.log(`  ${e.alias.padEnd(20)} ${e.brief}`);
    counted++;
  };

  const ranked = new Set(GROUPS.flatMap(([, aliases]) => aliases));
  for (const [heading, aliases] of GROUPS) {
    const rows = aliases.map((a) => byAlias.get(a)).filter((e): e is Entry => Boolean(e) && hit(e!));
    if (!rows.length) continue;
    console.log(`\n${heading}`);
    rows.forEach(row);
  }
  // anything not ranked in GROUPS yet — keeps a freshly added function visible
  const rest = ORDERED().filter(({ alias, entry }) => !ranked.has(alias) && hit(entry));
  if (rest.length) {
    console.log("\nother");
    rest.forEach(({ entry }) => row(entry));
  }

  if (!counted) return void console.log(`nothing matched "${filter}".`);
  console.log("\nconstants:");
  for (const [k, v] of Object.entries(CONSTS())) console.log(`  ${k} = ${v}`);
  console.log(`\n${counted} total, most useful first. Params and a runnable command: v3sdk help <function>`);
}

/** Details: what each param is, its default, and a ready-to-run command */
function showHelp(name?: string): void {
  if (!name) return list();
  const resolved = resolve(name);
  if (!resolved) {
    const guess = nearest(name);
    return void console.log(`no such function: ${name}${guess ? `\ndid you mean: ${guess}` : ""}`);
  }
  const e = REGISTRY[resolved];
  console.log(`${resolved}  (short name: ${e.alias})\n  ${e.note}\n`);
  for (const q of e.params) {
    const flag = q.optional ? `[--${q.name}]` : `--${q.name}`;
    const fallback = q.optional && q.default ? ` (default ${q.default})` : "";
    console.log(`  ${flag.padEnd(18)} <${q.kind}>  ${q.desc ?? ""}${fallback}`);
    if (q.example) console.log(`  ${"".padEnd(18)} e.g. ${q.example}`);
  }
  console.log(`\nready to run:\n  ${signature(e)}`);
}

export async function run(argv: string[]): Promise<void> {
  if (argv[0] === "--complete") return complete(argv.slice(1), argv.includes("-d"));

  const json = argv.includes("--json");
  const rest = argv.filter((x) => x !== "--json");
  const cmd = rest[0];

  if (cmd === "completion") return void console.log(COMPLETION[rest[1] ?? "zsh"] ?? COMPLETION.zsh);
  if (cmd === "--version" || cmd === "-v" || cmd === "version") return void console.log(pkg.version);
  if (!cmd || cmd === "list") return list(rest[1]);
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return showHelp(rest[1]);

  const name = resolve(cmd);
  if (!name) {
    const guess = nearest(cmd);
    console.error(
      `no such function: ${cmd}${guess ? `\ndid you mean: ${guess}` : ""}\nrun "v3sdk list" to see them all.`
    );
    process.exitCode = 1;
    return;
  }
  const entry = REGISTRY[name];

  const named: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 1; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0) named[t.slice(2, eq)] = t.slice(eq + 1);
      else named[t.slice(2)] = rest[++i];
    } else positional.push(t);
  }

  const args: Record<string, unknown> = {};
  let bad = false;
  entry.params.forEach((q: Param, idx: number) => {
    let raw: string | undefined = named[q.name] ?? positional[idx];
    if (raw === undefined && q.optional) raw = q.default;
    if (raw === undefined) {
      console.error(`missing param --${q.name} <${q.kind}>${q.desc ? `  ${q.desc}` : ""}\n  e.g. ${q.example}`);
      bad = true;
      return;
    }
    try {
      args[q.name] = convert(q.kind, raw);
    } catch (err) {
      console.error(`${q.name}: ${err instanceof Error ? err.message : String(err)}`);
      bad = true;
    }
  });
  if (bad) {
    // Params missing: print the whole runnable command so it can be copied as-is
    console.error(`\nready to run:\n  ${signature(entry)}`);
    process.exitCode = 1;
    return;
  }

  try {
    const out = await entry.fn(args); // slot0 is async; every other entry resolves immediately
    console.log(json ? JSON.stringify(plain(out), null, 2) : asText(plain(out)));
  } catch (err) {
    console.error(`call failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// Only run when invoked as a command; importing this module does nothing
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
