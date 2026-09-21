/**
 * The one place in this package that talks to the network.
 *
 * Every other command is pure math. This module runs only when you ask for `slot0` and
 * hand it an RPC endpoint: a handful of read-only `eth_call`s, no key, no wallet, no
 * transaction, nothing written anywhere.
 */

/** 4-byte selectors (keccak256 of the signature) for the calls we need */
export const SELECTOR = {
  slot0: "0x3850c7bd",
  liquidity: "0x1a686502",
  fee: "0xddca3f43",
  token0: "0x0dfe1681",
  token1: "0xd21220a7",
  decimals: "0x313ce567",
  symbol: "0x95d89b41",
} as const;

/**
 * One JSON-RPC call. Throws with the RPC's own message when it fails.
 * `allowEmpty` lets an intentional "0x" through (eth_getCode returns that for a plain EOA).
 */
export async function rpc(
  url: string,
  method: string,
  params: unknown[],
  { allowEmpty = false, timeoutMs = 20_000 }: { allowEmpty?: boolean; timeoutMs?: number } = {}
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs), // never hang forever on a dead endpoint
    });
  } catch (err) {
    throw new Error(`cannot reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(`RPC ${url} answered HTTP ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(`RPC error: ${body.error.message ?? "unknown"}`);
  if (!body.result || (body.result === "0x" && !allowEmpty)) throw new Error(`empty result from ${method}`);
  return body.result;
}

/** A read-only eth_call at the latest block */
export const ethCall = (url: string, to: string, data: string, timeoutMs?: number): Promise<string> =>
  rpc(url, "eth_call", [{ to, data }, "latest"], { timeoutMs });

/** The block the data came from, so a reading can be reproduced later */
export const blockNumber = async (url: string, timeoutMs?: number): Promise<string> =>
  BigInt(await rpc(url, "eth_blockNumber", [], { timeoutMs })).toString();

/** Account code at the latest block — "0x" means there is no contract there */
export const code = (url: string, address: string, timeoutMs?: number): Promise<string> =>
  rpc(url, "eth_getCode", [address, "latest"], { allowEmpty: true, timeoutMs });

/** Split an ABI response into its 32-byte words */
export function words(hex: string): string[] {
  const h = hex.replace(/^0x/, "");
  const out: string[] = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}

/** Word → unsigned integer, as a decimal string (keeps big values exact) */
export const wordToDec = (w: string): string => BigInt(`0x${w}`).toString();
/** Word → unsigned integer, as a number (fine for ticks, decimals, flags) */
export const wordToNum = (w: string): number => Number(BigInt(`0x${w}`));
/** Word → signed integer; the ABI sign-extends int24 into the full word */
export const wordToSigned = (w: string): number => {
  const v = BigInt(`0x${w}`);
  return Number(v >= 2n ** 255n ? v - 2n ** 256n : v);
};
/** Word → address (the last 20 bytes) */
export const wordToAddress = (w: string): string => `0x${w.slice(24)}`;

/** ABI-encoded dynamic string: offset, length, then the utf8 bytes */
export function decodeAbiString(hex: string): string {
  const w = words(hex);
  const at = wordToNum(w[0]) / 32;
  const len = wordToNum(w[at]);
  const bytes = w.slice(at + 1).join("").slice(0, len * 2);
  return Buffer.from(bytes, "hex").toString("utf8").replace(/\0+$/, "");
}
