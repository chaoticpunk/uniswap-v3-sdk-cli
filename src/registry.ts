/**
 * The function table.
 *
 * Two rules:
 *   1. Adding a function means adding one entry here — list / help / arg parsing /
 *      completion / the smoke test all pick it up automatically.
 *   2. Price-shaped results are always written as a sentence `1 <A> = x <B>`, so there
 *      is never any doubt about which side is which.
 */
import { checksumAddress, core, jsbi, util, v3 } from "./vendor.js";
import {
  SELECTOR,
  blockNumber,
  code,
  decodeAbiString,
  ethCall,
  wordToAddress,
  wordToDec,
  wordToNum,
  wordToSigned,
  words,
} from "./rpc.js";

/**
 * jsbi's .d.ts loses all its statics under NodeNext, so one cast keeps the rest clean. This
 * is the SDK's own copy of jsbi (see vendor.ts) — only used when we hand a JSBI to the SDK.
 */
export const bi = (v: string | number) => (jsbi() as any).BigInt(v);
export const dec = (v: unknown): string => String(v);

/**
 * `address,decimals,symbol[,chainId]` → Token.
 * The address is lowercased: mixed-case addresses copied from a block explorer often fail
 * the EIP-55 checksum, and sdk-core rejects those outright.
 */
export function parseToken(raw: string): InstanceType<ReturnType<typeof core>["Token"]> {
  const [address, decimals, symbol, chainId] = raw.split(",");
  if (!address || !decimals) throw new Error(`token expects address,decimals,symbol[,chainId] — got: ${raw}`);
  const { Token } = core();
  return new Token(Number(chainId ?? 1), address.toLowerCase(), Number(decimals), symbol ?? "?");
}

export type Kind = "number" | "bool" | "jsbi" | "bigintish" | "token" | "string" | "json";

export interface Param {
  name: string;
  kind: Kind;
  /** Example value; help turns it into a command you can copy and run */
  example: string;
  /** One line, shown in help and completion only, so that list stays terse */
  desc?: string;
  /** Falls back to `default` when omitted */
  optional?: boolean;
  default?: string;
}

export interface Entry {
  /** Short name (`v3sdk <alias>`) and the reverse lookup used by resolve() */
  alias: string;
  /** One short line for `list` and the completion popup — no params, no emoji, no period */
  brief: string;
  note: string;
  /** true = this entry talks to the network. Only `slot0` does; everything else is offline. */
  net?: true;
  params: Param[];
  /** Args are already converted per `params`; typed `any` because the SDK's JSBI types
   *  don't line up with their .d.ts and casting at every call site is just noise. */
  fn: (a: any) => unknown;
}

const p = (name: string, kind: Kind, example: string, desc?: string): Param => ({ name, kind, example, desc });
const opt = (name: string, kind: Kind, def: string, desc?: string): Param => ({
  name,
  kind,
  example: def,
  desc,
  optional: true,
  default: def,
});

/** Command-line string → runtime value (shared by CLI, help examples, completion and tests) */
export function convert(kind: Kind, raw: string): unknown {
  switch (kind) {
    case "number":
      return Number(raw);
    case "bool":
      return raw === "true" || raw === "1" || raw === "yes";
    case "jsbi":
      return bi(raw);
    case "bigintish":
      return raw; // BigintIsh takes a string; the SDK converts it internally
    case "json":
      return JSON.parse(raw);
    case "token":
      return parseToken(raw);
    case "string":
      return raw;
  }
}

/** The usual pool-state bundle: token0 / token1 / fee / √P / liquidity / tick */
const poolParams = (): Param[] => [
  p("token0", "token", USDT, "token0 (the one with the lower address)"),
  p("token1", "token", LINK, "token1"),
  p("fee", "number", "3000", "fee tier: 500 / 3000 / 10000"),
  p("sqrtPriceX96", "bigintish", SQRT_P, "current √P (= √(token1/token0) × 2^96)"),
  p("liquidity", "bigintish", "138851799446300", "current liquidity L"),
  p("tick", "number", "246333", "current tick"),
];

const PRICE_NOTE = "prices are written as a sentence, so the direction is never ambiguous";

/** Native BigInt here: our own arithmetic never needs jsbi, and this is the fast path */
const TEN = 10n;
const ONE = 1n;
const TWO = 2n;
const pow10 = (k: number) => TEN ** BigInt(k);
const pow2 = (k: number) => TWO ** BigInt(k);

/**
 * Exact num/den → decimal string with `sig` significant digits (half-up rounding).
 * Deliberately no floats anywhere: sqrtPriceX96 / 2^96 is ~2^96, and going through a
 * double loses digits before you even square it.
 */
function toDecimal(num: bigint, den: bigint, sig = 18): string {
  if (den === 0n) throw new Error("division by zero");
  const neg = num < 0n;
  if (neg) {
    num = -num;
    den = -den;
  }
  // Where does the first significant digit sit? value = d.ddd × 10^e
  const intPart = num / den;
  let e: number;
  if (intPart !== 0n) {
    e = intPart.toString().length - 1;
  } else {
    let k = 0;
    let probe = num;
    while (probe < den && k < 200) {
      probe *= TEN;
      k++;
    }
    e = -k;
  }
  // Scale to exactly `sig` digits, then round half-up
  const shift = sig - 1 - e;
  let scaled = shift >= 0 ? num * pow10(shift) : num;
  if (shift < 0) scaled *= pow10(-shift); // keep the digits we can show
  if (shift >= 0) {
    const rest = scaled % den;
    scaled /= den;
    if (rest * TWO >= den) scaled += ONE;
  }
  let digits = scaled.toString();
  if (digits.length > sig) {
    // rounded up to the next power of ten, e.g. 9.99 → 10.0
    digits = digits.slice(0, digits.length - 1);
    e += 1;
  }
  const cut = e + 1;
  let out =
    e >= 0
      ? digits.length <= cut
        ? digits + "0".repeat(cut - digits.length)
        : `${digits.slice(0, cut)}.${digits.slice(cut)}`
      : `0.${"0".repeat(-cut)}${digits}`;
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return neg ? `-${out}` : out;
}

/**
 * √P + decimals → both price sentences, in exact integer math.
 * `sig` significant digits: 12 reads well and is still far more precise than any pool
 * actually is. Exact integers (sqrtPriceX96, tick, liquidity) stay exact.
 */
function sqrtToPrice(sqrtPriceX96: string, dec0: number, dec1: number, sym0: string, sym1: string) {
  const p = BigInt(sqrtPriceX96);
  const d = dec0 - dec1;
  const rawNum = p * p;
  const priceNum = rawNum * (d >= 0 ? pow10(d) : ONE);
  const priceDen = pow2(192) * (d >= 0 ? ONE : pow10(-d)); // √P is Q96 fixed point
  return {
    price: `1 ${sym0} = ${toDecimal(priceNum, priceDen, 12)} ${sym1}`,
    inverse: `1 ${sym1} = ${toDecimal(priceDen, priceNum, 12)} ${sym0}`,
  };
}

/**
 * Example values: one self-consistent set of real numbers so that every command in
 * `help` / `list` can be copied and run as-is. The tool itself has nothing to do with
 * this or any other pool — any √P / tick / liquidity works.
 */
const SQRT_P = "17687452210211969913755435227879803"; // example √P (the value at tick 246333)
const SQRT_LO = "17308168878124134539469234982985700"; // example range lower bound √Pa
const SQRT_HI = "17914094950415131853668522753471700"; // example range upper bound √Pb
// placeholders on purpose: examples should not point at anyone's specific token or pool
const USDT = "0x1111111111111111111111111111111111111111,6,USDT";
const LINK = "0x2222222222222222222222222222222222222222,18,LINK";

export const REGISTRY: Record<string, Entry> = {
  // ── tick ↔ √P ↔ price ─────────────────────────────────────
  "TickMath.getSqrtRatioAtTick": {
    alias: "sqrtRatioAtTick",
    brief: "tick → √P",
    note: "tick → √P (Q96 fixed point; √P is the square root of token1/token0)",
    params: [p("tick", "number", "246333", "the price scale; one tick is 0.01%")],
    fn: (a) => util("tickMath").TickMath.getSqrtRatioAtTick(a.tick),
  },
  "TickMath.getTickAtSqrtRatio": {
    alias: "tickAtSqrtRatio",
    brief: "√P → tick",
    note: "√P → tick",
    params: [p("sqrtPriceX96", "jsbi", SQRT_P, "√(token1/token0) × 2^96")],
    fn: (a) => util("tickMath").TickMath.getTickAtSqrtRatio(a.sqrtPriceX96),
  },
  encodeSqrtRatioX96: {
    alias: "encodeSqrtRatio",
    brief: "raw amount ratio → √P",
    note: "raw unit ratio → √P. You pass amount1/amount0, i.e. how many raw token1 one raw token0 is worth",
    params: [
      p("amount1", "bigintish", "50000000000000000", "amount of token1, in raw units"),
      p("amount0", "bigintish", "1000000", "amount of token0, in raw units"),
    ],
    fn: (a) => util("encodeSqrtRatioX96").encodeSqrtRatioX96(a.amount1, a.amount0),
  },
  nearestUsableTick: {
    alias: "nearestTick",
    brief: "snap a tick to tickSpacing",
    note: "snap a tick to tickSpacing (range endpoints must be aligned or the NFPM reverts)",
    params: [
      p("tick", "number", "246333", "target tick"),
      p("tickSpacing", "number", "60", "spacing for the fee tier: 500→10, 3000→60, 10000→200"),
    ],
    fn: (a) => util("nearestUsableTick").nearestUsableTick(a.tick, a.tickSpacing),
  },
  tickToPrice: {
    alias: "tickToPrice",
    brief: "tick → readable price",
    note: `tick → human price (${PRICE_NOTE})`,
    params: [
      p("baseToken", "token", USDT, "the token on the left of the equation"),
      p("quoteToken", "token", LINK, "the token on the right"),
      p("tick", "number", "246333", "target tick"),
    ],
    fn: (a) => util("priceTickConversions").tickToPrice(a.baseToken, a.quoteToken, a.tick),
  },
  priceToClosestTick: {
    alias: "priceToTick",
    brief: "the price you want → the closest tick",
    note: "human price → the closest tick (price written as 1 base = numerator/denominator quote)",
    params: [
      p("baseToken", "token", USDT, "the token on the left of the equation"),
      p("quoteToken", "token", LINK, "the token on the right"),
      p("numerator", "bigintish", "1", "price numerator"),
      p("denominator", "bigintish", "20", "price denominator (1 base = num/den quote)"),
    ],
    fn: (a) =>
      util("priceTickConversions").priceToClosestTick(
        new (core().Price)(a.baseToken, a.quoteToken, String(a.numerator), String(a.denominator))
      ),
  },

  // ── amounts ↔ liquidity ↔ price ───────────────────────────
  "SqrtPriceMath.getAmount0Delta": {
    alias: "amount0Delta",
    brief: "token0 needed to move across a range",
    note: "how much token0 a given liquidity corresponds to while the price moves across a range (√Pa must be < √Pb)",
    params: [
      p("sqrtRatioAX96", "jsbi", SQRT_P, "the **lower** √P"),
      p("sqrtRatioBX96", "jsbi", SQRT_HI, "the **higher** √P"),
      p("liquidity", "jsbi", "138851799446300", "liquidity L"),
      p("roundUp", "bool", "false", "true = round up (what you owe), false = round down (what you receive)"),
    ],
    fn: (a) =>
      util("sqrtPriceMath").SqrtPriceMath.getAmount0Delta(
        a.sqrtRatioAX96,
        a.sqrtRatioBX96,
        a.liquidity,
        a.roundUp
      ),
  },
  "SqrtPriceMath.getAmount1Delta": {
    alias: "amount1Delta",
    brief: "token1 needed to move across a range",
    note: "same as amount0Delta, but for token1",
    params: [
      p("sqrtRatioAX96", "jsbi", SQRT_LO, "lower √P"),
      p("sqrtRatioBX96", "jsbi", SQRT_P, "higher √P"),
      p("liquidity", "jsbi", "138851799446300", "liquidity L"),
      p("roundUp", "bool", "false", "rounding direction"),
    ],
    fn: (a) =>
      util("sqrtPriceMath").SqrtPriceMath.getAmount1Delta(
        a.sqrtRatioAX96,
        a.sqrtRatioBX96,
        a.liquidity,
        a.roundUp
      ),
  },
  "SqrtPriceMath.getNextSqrtPriceFromInput": {
    alias: "nextSqrtFromIn",
    brief: "where the price lands after an exact input",
    note: "where the price lands after swapping amountIn in (price impact / slippage)",
    params: [
      p("sqrtPX96", "jsbi", SQRT_P, "current √P"),
      p("liquidity", "jsbi", "138851799446300", "current L"),
      p("amountIn", "jsbi", "1000000", "input amount, in raw units"),
      p("zeroForOne", "bool", "true", "true = selling token0 (price goes down), false = selling token1"),
    ],
    fn: (a) =>
      util("sqrtPriceMath").SqrtPriceMath.getNextSqrtPriceFromInput(
        a.sqrtPX96,
        a.liquidity,
        a.amountIn,
        a.zeroForOne
      ),
  },
  "SqrtPriceMath.getNextSqrtPriceFromOutput": {
    alias: "nextSqrtFromOut",
    brief: "where the price lands for an exact output",
    note: "where the price lands if you want amountOut",
    params: [
      p("sqrtPX96", "jsbi", SQRT_P, "current √P"),
      p("liquidity", "jsbi", "138851799446300", "current L"),
      p("amountOut", "jsbi", "49770090745185465", "the amount you want out, in raw units"),
      p("zeroForOne", "bool", "true", "same as above"),
    ],
    fn: (a) =>
      util("sqrtPriceMath").SqrtPriceMath.getNextSqrtPriceFromOutput(
        a.sqrtPX96,
        a.liquidity,
        a.amountOut,
        a.zeroForOne
      ),
  },
  maxLiquidityForAmounts: {
    alias: "maxLiquidity",
    brief: "amounts + range → the most liquidity you can mint",
    note: "given a range and both amounts → how much liquidity you can provide (it wants √Pl, √Pc, √Pu)",
    params: [
      p("sqrtRatioCurrentX96", "jsbi", SQRT_P, "current √P"),
      p("sqrtRatioAX96", "jsbi", SQRT_LO, "range lower bound √P"),
      p("sqrtRatioBX96", "jsbi", SQRT_HI, "range upper bound √P"),
      p("amount0", "bigintish", "20000000", "token0 you are willing to deposit (raw units)"),
      p("amount1", "bigintish", "1000000000000000000", "token1 you are willing to deposit (raw units)"),
      p("useFullPrecision", "bool", "true", "true = use on-chain theoretical precision"),
    ],
    fn: (a) =>
      util("maxLiquidityForAmounts").maxLiquidityForAmounts(
        a.sqrtRatioCurrentX96,
        a.sqrtRatioAX96,
        a.sqrtRatioBX96,
        a.amount0,
        a.amount1,
        a.useFullPrecision
      ),
  },
  "LiquidityMath.addDelta": {
    alias: "addDelta",
    brief: "liquidity ± delta",
    note: "add or subtract liquidity (used when the price crosses a tick; pass a negative number going down)",
    params: [
      p("x", "jsbi", "138851799446300", "liquidity before"),
      p("y", "jsbi", "-138851799446300", "this tick's liquidityNet delta"),
    ],
    fn: (a) => util("liquidityMath").LiquidityMath.addDelta(a.x, a.y),
  },

  // ── entities: Pool / Position ─────────────────────────────
  "Pool.price": {
    alias: "poolPrice",
    brief: "price from full pool state",
    note: `price from pool state (${PRICE_NOTE})`,
    params: poolParams(),
    fn: (a) => {
      const pool = new (v3().Pool)(
        a.token0,
        a.token1,
        a.fee,
        String(a.sqrtPriceX96),
        String(a.liquidity),
        a.tick
      );
      const s0 = pool.token0.symbol;
      const s1 = pool.token1.symbol;
      return {
        price: `1 ${s0} = ${pool.token0Price.toSignificant(12)} ${s1}`,
        inverse: `1 ${s1} = ${pool.token1Price.toSignificant(12)} ${s0}`,
      };
    },
  },
  "Position.fromAmounts": {
    alias: "positionFromAmounts",
    brief: "amounts + range → liquidity, and how much actually gets used",
    note: "given a range and both amounts → liquidity you can mint and what actually gets used (the rest stays in your wallet)",
    params: [
      ...poolParams(),
      p("tickLower", "number", "245760", "range lower bound (align it to tickSpacing)"),
      p("tickUpper", "number", "247020", "range upper bound"),
      p("amount0", "bigintish", "20000000", "token0 you are willing to deposit (raw units)"),
      p("amount1", "bigintish", "1000000000000000000", "token1 you are willing to deposit (raw units)"),
    ],
    fn: (a) => {
      const pool = new (v3().Pool)(
        a.token0,
        a.token1,
        a.fee,
        String(a.sqrtPriceX96),
        String(a.liquidity),
        a.tick
      );
      const pos = v3().Position.fromAmounts({
        pool,
        tickLower: a.tickLower,
        tickUpper: a.tickUpper,
        amount0: a.amount0,
        amount1: a.amount1,
        useFullPrecision: true,
      });
      const s0 = pool.token0.symbol;
      const s1 = pool.token1.symbol;
      return {
        liquidity: pos.liquidity.toString(),
        [`used ${s0} (raw)`]: pos.amount0.quotient.toString(),
        [`used ${s1} (raw)`]: pos.amount1.quotient.toString(),
        [`used ${s0} (human)`]: pos.amount0.toSignificant(10),
        [`used ${s1} (human)`]: pos.amount1.toSignificant(10),
      };
    },
  },

  // ── swap / fees ───────────────────────────────────────────
  "SwapMath.computeSwapStep": {
    alias: "swapStep",
    brief: "one swap step → new √P, in, out, fee",
    note: "one swap step → [new √P, amount actually in, amount out, fee]. The target must be the price you are moving towards",
    params: [
      p("sqrtRatioCurrentX96", "jsbi", SQRT_P, "current √P"),
      p("sqrtRatioTargetX96", "jsbi", SQRT_LO, "target √P (a lower price when selling token0)"),
      p("liquidity", "jsbi", "138851799446300", "current L"),
      p("amountRemaining", "jsbi", "1000000", "how much input is left (raw units)"),
      p("feePips", "number", "3000", "fee in millionths: 500 / 3000 / 10000"),
    ],
    fn: (a) =>
      util("swapMath").SwapMath.computeSwapStep(
        a.sqrtRatioCurrentX96,
        a.sqrtRatioTargetX96,
        a.liquidity,
        a.amountRemaining,
        bi(a.feePips)
      ),
  },
  "TickLibrary.getFeeGrowthInside": {
    alias: "feeGrowthInside",
    brief: "fee growth inside a range",
    note: "fee growth accumulated inside a range → [fg0, fg1] (the outside values come from ticks() on chain)",
    params: [
      p("outsideLower0", "jsbi", "0", "feeGrowthOutside0X128 of the lower tick"),
      p("outsideLower1", "jsbi", "0", "feeGrowthOutside1X128 of the lower tick"),
      p("outsideUpper0", "jsbi", "0", "feeGrowthOutside0X128 of the upper tick"),
      p("outsideUpper1", "jsbi", "0", "feeGrowthOutside1X128 of the upper tick"),
      p("tickLower", "number", "245760", "range lower bound"),
      p("tickUpper", "number", "247020", "range upper bound"),
      p("tickCurrent", "number", "246333", "current tick"),
      p("feeGrowthGlobal0X128", "jsbi", "0", "pool-wide feeGrowthGlobal0X128"),
      p("feeGrowthGlobal1X128", "jsbi", "0", "pool-wide feeGrowthGlobal1X128"),
    ],
    fn: (a) =>
      util("tickLibrary").TickLibrary.getFeeGrowthInside(
        { feeGrowthOutside0X128: a.outsideLower0, feeGrowthOutside1X128: a.outsideLower1 },
        { feeGrowthOutside0X128: a.outsideUpper0, feeGrowthOutside1X128: a.outsideUpper1 },
        a.tickLower,
        a.tickUpper,
        a.tickCurrent,
        a.feeGrowthGlobal0X128,
        a.feeGrowthGlobal1X128
      ),
  },
  "PositionLibrary.getTokensOwed": {
    alias: "tokensOwed",
    brief: "fees a position has accrued",
    note: "fees this position has accrued → [owed0, owed1]",
    params: [
      p("feeGrowthInside0LastX128", "jsbi", "0", "fgInside0 recorded for the position last time"),
      p("feeGrowthInside1LastX128", "jsbi", "0", "fgInside1 recorded for the position last time"),
      p("liquidity", "jsbi", "138851799446300", "position liquidity"),
      p("feeGrowthInside0X128", "jsbi", "0", "current fgInside0 of the range"),
      p("feeGrowthInside1X128", "jsbi", "0", "current fgInside1 of the range"),
    ],
    fn: (a) =>
      util("position").PositionLibrary.getTokensOwed(
        a.feeGrowthInside0LastX128,
        a.feeGrowthInside1LastX128,
        a.liquidity,
        a.feeGrowthInside0X128,
        a.feeGrowthInside1X128
      ),
  },

  // ── utilities ─────────────────────────────────────────────
  "TickList.nextInitializedTickWithinOneWord": {
    alias: "nextTickInWord",
    brief: "next initialized tick in the bitmap",
    note: "next initialized tick in the bitmap, searching within one word → [tick, initialized]",
    params: [
      p("ticks", "json", '[{"index":245760,"liquidityNet":"138851799446300"},{"index":247020,"liquidityNet":"-138851799446300"}]', "array of initialized ticks (index + liquidityNet)"),
      p("tick", "number", "246333", "current tick"),
      p("lte", "bool", "true", "true = search downwards (price falling), false = upwards"),
      p("tickSpacing", "number", "60", "spacing for the fee tier"),
    ],
    fn: (a) =>
      util("tickList").TickList.nextInitializedTickWithinOneWord(
        a.ticks,
        a.tick,
        a.lte,
        a.tickSpacing
      ),
  },
  "FullMath.mulDivRoundingUp": {
    alias: "mulDivUp",
    brief: "512-bit mulDiv, rounded up",
    note: "512-bit multiply-divide (overflow safe), rounded up",
    params: [
      p("a", "jsbi", "1", "multiplicand"),
      p("b", "jsbi", "2", "multiplier"),
      p("denominator", "jsbi", "3", "divisor"),
    ],
    fn: (a) => util("fullMath").FullMath.mulDivRoundingUp(a.a, a.b, a.denominator),
  },
  mostSignificantBit: {
    alias: "msb",
    brief: "most significant bit",
    note: "most significant bit (used to locate a tick in the bitmap)",
    params: [p("x", "jsbi", "2097153", "any integer")],
    fn: (a) => util("mostSignificantBit").mostSignificantBit(a.x),
  },
  toHex: {
    alias: "toHex",
    brief: "integer → 0x hex",
    note: "integer → 0x hex",
    params: [p("bigintIsh", "bigintish", "255", "any integer")],
    fn: (a) => util("calldata").toHex(a.bigintIsh),
  },
  computePoolAddress: {
    alias: "poolAddress",
    brief: "compute a pool address, no RPC",
    note: "compute a pool address (no RPC needed)",
    params: [
      p("factoryAddress", "string", "0x3333333333333333333333333333333333333333", "your v3 factory address"),
      p("tokenA", "token", USDT, "either token"),
      p("tokenB", "token", LINK, "the other token"),
      p("fee", "number", "3000", "fee tier"),
    ],
    fn: (a) =>
      util("computePoolAddress").computePoolAddress({
        factoryAddress: a.factoryAddress,
        tokenA: a.tokenA,
        tokenB: a.tokenB,
        fee: a.fee,
      }),
  },

  // ── shortcuts that aren't in the SDK but get used daily ───
  decodeSqrtPrice: {
    alias: "sqrtToPrice",
    brief: "√P → readable price, both directions",
    note: "🔧 what that big sqrtPriceX96 from the chain is actually worth (says which side is which)",
    params: [
      p("sqrtPriceX96", "bigintish", SQRT_P, "first return value of slot0() on chain"),
      p("dec0", "number", "6", "decimals of token0"),
      p("dec1", "number", "18", "decimals of token1"),
      opt("sym0", "string", "token0", "symbol of token0 (cosmetic)"),
      opt("sym1", "string", "token1", "symbol of token1"),
    ],
    fn: (a) => sqrtToPrice(String(a.sqrtPriceX96), a.dec0, a.dec1, String(a.sym0), String(a.sym1)),
  },
  encodePrice: {
    alias: "priceToSqrt",
    brief: "the price you want → the √P to set",
    note: "🔧 human price → sqrtPriceX96 (price written as 1 token0 = num/den token1)",
    params: [
      p("num", "bigintish", "1", "numerator of the price (token1 side)"),
      p("den", "bigintish", "20", "denominator of the price (token0 side)"),
      p("dec0", "number", "6", "decimals of token0"),
      p("dec1", "number", "18", "decimals of token1"),
    ],
    fn: (a) =>
      util("encodeSqrtRatioX96").encodeSqrtRatioX96(
        bi(String(a.num) + "0".repeat(a.dec1)),
        bi(String(a.den) + "0".repeat(a.dec0))
      ),
  },

  // ── on-chain read: the only command that uses the network ─
  slot0: {
    alias: "slot0",
    brief: "price, tick, liquidity, fee tier — straight from the chain",
    net: true,
    note: "🔌 read a pool's slot0 + liquidity + tokens over RPC, then print the price — the only command that touches the network",
    params: [
      p("pool", "string", "0x4444444444444444444444444444444444444444", "pool address"),
      opt("rpc", "string", "", "JSON-RPC endpoint; falls back to $RPC_URL"),
    ],
    fn: async (a) => {
      const url = String(a.rpc || process.env.RPC_URL || "");
      if (!url) throw new Error("no RPC endpoint given: pass --rpc <url> or set RPC_URL");
      const pool = String(a.pool);
      // fail with something useful instead of five identical "empty result" errors
      if ((await code(url, pool)) === "0x") {
        throw new Error(`${pool} has no code on this chain — wrong address, or is the RPC on another network?`);
      }
      const [slot0Hex, liqHex, feeHex, t0Hex, t1Hex, block] = await Promise.all([
        ethCall(url, pool, SELECTOR.slot0),
        ethCall(url, pool, SELECTOR.liquidity),
        ethCall(url, pool, SELECTOR.fee),
        ethCall(url, pool, SELECTOR.token0),
        ethCall(url, pool, SELECTOR.token1),
        blockNumber(url),
      ]);
      const w = words(slot0Hex);
      const sqrtPriceX96 = wordToDec(w[0]);
      // checksummed, and printed in the same `address,decimals,symbol` form the token params take
      const token0 = checksumAddress(wordToAddress(words(t0Hex)[0]));
      const token1 = checksumAddress(wordToAddress(words(t1Hex)[0]));
      const [dec0Hex, dec1Hex, sym0Hex, sym1Hex] = await Promise.all([
        ethCall(url, token0, SELECTOR.decimals),
        ethCall(url, token1, SELECTOR.decimals),
        ethCall(url, token0, SELECTOR.symbol),
        ethCall(url, token1, SELECTOR.symbol),
      ]);
      const dec0 = wordToNum(words(dec0Hex)[0]);
      const dec1 = wordToNum(words(dec1Hex)[0]);
      const sym0 = decodeAbiString(sym0Hex);
      const sym1 = decodeAbiString(sym1Hex);
      const fee = wordToNum(words(feeHex)[0]);
      // slot0 packs the protocol fee for both tokens: low 4 bits = token0, high 4 bits = token1.
      // Each value is the denominator of the protocol's share of the swap fee (0 = off) — see
      // IUniswapV3PoolOwnerActions: "Set the denominator of the protocol's % share of the fees".
      const fp = wordToNum(w[5]);
      const fp0 = fp & 0x0f;
      const fp1 = fp >> 4;
      return {
        // context first: which pool, which tokens, which fee tier, which block
        pool,
        token0: `${token0},${dec0},${sym0}`,
        token1: `${token1},${dec1},${sym1}`,
        fee: `${fee / 10_000}% (${fee})`,
        block,
        // then the whole slot0 tuple, in ABI order, kept together as one block
        slot0: {
          sqrtPriceX96,
          tick: wordToSigned(w[1]),
          observationIndex: wordToNum(w[2]),
          observationCardinality: wordToNum(w[3]),
          observationCardinalityNext: wordToNum(w[4]),
          feeProtocol: fp === 0 ? "off (0)" : `${fp0 === fp1 ? `1/${fp0} both sides` : `1/${fp0} token0, 1/${fp1} token1`} (${fp})`,
          unlocked: wordToNum(w[6]) === 1,
        },
        // and finally what we derived from it
        ...sqrtToPrice(sqrtPriceX96, dec0, dec1, sym0, sym1),
        liquidity: wordToDec(words(liqHex)[0]),
      };
    },
  },
};

/**
 * Name lookup: canonical name / short name (alias) / suffix / substring all work.
 * Returns "" when nothing matches.
 */

/**
 * The ranking that `list` and Tab-completion follow: most useful first, grouped by what
 * you are trying to do. This is the one place to edit when the priorities change — and
 * the test suite checks that every entry in REGISTRY appears here exactly once.
 */
export const GROUPS: [string, string[]][] = [
  ["read a pool (needs --rpc)", ["slot0"]],
  ["√P ↔ price ↔ tick", ["sqrtToPrice", "tickToPrice", "priceToSqrt", "priceToTick", "sqrtRatioAtTick", "tickAtSqrtRatio", "poolPrice"]],
  ["positions and amounts", ["positionFromAmounts", "maxLiquidity", "amount0Delta", "amount1Delta", "nearestTick"]],
  ["swaps and fees", ["swapStep", "nextSqrtFromIn", "nextSqrtFromOut", "feeGrowthInside", "tokensOwed"]],
  ["utilities", ["poolAddress", "encodeSqrtRatio", "addDelta", "nextTickInWord", "mulDivUp", "msb", "toHex"]],
];

/** Every alias, in ranking order, with anything missing from GROUPS appended at the end */
export const ORDERED = (): { alias: string; entry: Entry }[] => {
  const all = Object.values(REGISTRY);
  const ranked = GROUPS.flatMap(([, aliases]) => aliases.map((a) => all.find((e) => e.alias === a)));
  const rest = all.filter((e) => !ranked.includes(e));
  return [...ranked, ...rest].filter((e): e is Entry => Boolean(e)).map((entry) => ({ alias: entry.alias, entry }));
};

export function resolve(name: string | undefined): string {
  if (!name) return "";
  const q = String(name).toLowerCase();
  const keys = Object.keys(REGISTRY);
  return (
    keys.find((k) => k.toLowerCase() === q) ??
    keys.find((k) => REGISTRY[k].alias.toLowerCase() === q) ??
    keys.find((k) => k.toLowerCase().endsWith(`.${q}`)) ??
    keys.find((k) => k.toLowerCase().includes(q)) ??
    ""
  );
}

/**
 * For use from your own code — the function form of a CLI call:
 *
 *   call("sqrtToPrice", { sqrtPriceX96: slot0.sqrtPriceX96, dec0: 6, dec1: 18 })
 *
 * Short names and SDK names both work; jsbi params take plain decimal strings, so you
 * never have to import jsbi yourself.
 */
export function call(alias: string, args: Record<string, unknown> = {}): unknown {
  const key = resolve(alias);
  if (!key) throw new Error(`no such function: ${alias}`);
  const e = REGISTRY[key];
  const missing = e.params.filter((q) => args[q.name] === undefined && q.default === undefined);
  if (missing.length) throw new Error(`missing params: ${missing.map((q) => `--${q.name}`).join(" ")}`);
  const a: Record<string, unknown> = {};
  for (const q of e.params) {
    const raw = args[q.name] ?? q.default;
    a[q.name] = typeof raw === "string" ? convert(q.kind, raw) : raw; // already a runtime value
  }
  return e.fn(a);
}

/** SDK return value → plain JS: JSBI becomes a decimal string, Price becomes a sentence, objects recurse */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return v;
  const o = v as {
    constructor?: { name: string };
    baseCurrency?: { symbol: string };
    quoteCurrency?: { symbol: string };
    currency?: { symbol: string };
    toSignificant?: (d: number) => string;
  };
  if (o.constructor?.name === "JSBI") return dec(v); // JSBI extends Array, so check it first
  if (Array.isArray(v)) return v.map(plain);
  if (o.baseCurrency && o.quoteCurrency && typeof o.toSignificant === "function") {
    return `1 ${o.baseCurrency.symbol} = ${o.toSignificant(18)} ${o.quoteCurrency.symbol}`;
  }
  if (o.currency && typeof o.toSignificant === "function") {
    return `${o.toSignificant(18)} ${o.currency.symbol}`;
  }
  if (typeof o.toSignificant === "function") return o.toSignificant(18);
  return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, plain(val)]));
}

/**
 * Protocol constants, spelled out so `list` never has to load the SDK just to print them.
 * The smoke test compares them against the SDK's own TickMath / TICK_SPACINGS.
 */
export const CONSTS = (): Record<string, unknown> => ({
  MIN_TICK: -887272,
  MAX_TICK: 887272,
  "tickSpacing 500/3000/10000": "10 / 60 / 200",
});
