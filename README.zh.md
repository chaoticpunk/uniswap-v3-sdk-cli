# uniswap-v3-sdk-cli

[![CI](https://github.com/chaoticpunk/uniswap-v3-sdk-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/chaoticpunk/uniswap-v3-sdk-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/uniswap-v3-sdk-cli)](https://www.npmjs.com/package/uniswap-v3-sdk-cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)

[English](README.md)

把 [`@uniswap/v3-sdk`](https://github.com/Uniswap/sdks) 的函数变成命令行：**敲函数名，只给它需要的参数**。

```bash
$ v3sdk sqrtRatioAtTick --tick 246333
17687452210211969913755435227879803

$ v3sdk swapStep --sqrtRatioCurrentX96 17687452210211969913755435227879803 \
  --sqrtRatioTargetX96 17308168878124134539469234982985700 \
  --liquidity 138851799446300 --amountRemaining 1000000 --feePips 3000
[17659144873478511247396769043304980, 997000, 49610195645587856, 3000]
```

不需要私钥、不需要钱包、不发交易。除了 `slot0`，所有命令都是离线计算；`slot0` 只在你给它 RPC 地址时才发几条只读的 `eth_call`。

## 最该先用的几个

按 V3 实际干活的顺序排，越靠前越常用：

| | 命令 | 它回答什么 |
| --- | --- | --- |
| 1 | `slot0 --pool 0x… --rpc …` | 这个池子现在多少钱——价格、tick、流动性、费率档、区块 |
| 2 | `sqrtToPrice --sqrtPriceX96 … --dec0 … --dec1 …` | 链上那个大 √P → 人话价格，正反两句 |
| 3 | `tickToPrice --baseToken … --quoteToken … --tick …` | tick → 人话价格 |
| 4 | `priceToSqrt --num 1 --den 20 --dec0 … --dec1 …` | 我想挂的价格 → 该填的 √P |
| 5 | `priceToTick …` | 我想挂的价格 → 最近的 tick |
| 6 | `sqrtRatioAtTick` / `tickAtSqrtRatio` | tick ↔ √P，底下两个原语 |
| 7 | `positionFromAmounts` / `maxLiquidity` | 我手里这些币 → 能建多少流动性 |
| 8 | `nearestTick --tick … --tickSpacing …` | 把区间端点对齐（不对齐 mint 直接 revert） |
| 9 | `amount0Delta` / `amount1Delta` | 价格走完这个区间，要花掉多少 token0 / token1 |
| 10 | `swapStep` / `nextSqrtFromIn` | 一笔 swap 会把价格推到哪（冲击、滑点） |
| 11 | `tokensOwed` / `feeGrowthInside` | 这个头寸赚了多少手续费 |
|  | `poolAddress`、`encodeSqrtRatio`、`addDelta`、`nextTickInWord`、`mulDivUp`、`msb`、`toHex`、`poolPrice` | 工具类 |

`v3sdk list` 就是按这个顺序、带同样的小标题打印的：每个函数只有一行短说明，不再堆参数串（参数在 `help` 里）。Tab 补全的候选顺序和说明文字也是同一份。排序只存在于一处——`src/registry.ts` 里的 `GROUPS`——所以 CLI、补全和这张表不会各自漂移。

## 装

需要 Node 20 或更高版本。

```bash
npm i -g github:chaoticpunk/uniswap-v3-sdk-cli   # 装完命令名是 v3sdk
# 或者 clone 之后：npm install && npm link
# 不想动全局：clone 之后 npm install，然后 node dist/cli.js <参数>
```

发到 npm 之后：`npx uniswap-v3-sdk-cli list`。

## 用

```bash
v3sdk list [关键词]        # 全部函数，按常用程度排序、按用途分组
v3sdk help <函数>          # 参数说明 + 一条可直接复制的命令
v3sdk <函数> --参数 值 …    # 也可以按声明顺序写位置参数
v3sdk <函数> … --json      # 机器可读
v3sdk <函数> --参数 <Tab>   # Tab 补全，函数名和参数名都能补
v3sdk slot0 --pool 0x… --rpc https://…   # 直接从链上读一个池子
```

函数名就是 `list` 第一列的短名（去掉类名前缀和 `get`，如 `TickMath.getSqrtRatioAtTick` → `sqrtRatioAtTick`）；SDK 原名照样认得。

补全装一次（补全脚本只是转发，新加函数会自动跟上，不用重装）：

```bash
v3sdk completion zsh  > ~/.v3sdk-completion.zsh  && echo 'source ~/.v3sdk-completion.zsh' >> ~/.zshrc
v3sdk completion bash > ~/.v3sdk-completion.bash && echo 'source ~/.v3sdk-completion.bash' >> ~/.bashrc
v3sdk completion fish > ~/.config/fish/completions/v3sdk.fish   # fish 自动加载，不用改配置
```

```powershell
# PowerShell（Windows）
v3sdk completion powershell | Out-File -Encoding utf8 -Append $PROFILE
```

补全旁边会带提示：函数名显示出它是干什么的，参数是「e.g. 值 · 说明」（zsh / fish / PowerShell 都会显示）。参数没给全时，直接把整条能跑的命令打出来；函数名拼错会给「did you mean」。

### 读链上的池子

`slot0` 是唯一联网的命令。给它池子地址和 RPC（或者 `export RPC_URL=…`），它会读 `slot0()`、`liquidity()`、`fee()`、`token0()`、`token1()`、`decimals()`、`symbol()` 和当前区块，然后按 `sqrtToPrice` 的格式打出价格：

```bash
# （示例输出；其中的地址都是占位符，格式才是重点）
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

分三段读：**这是哪个池子**（地址、两个币、费率档、区块）、**`slot0()` 返回了什么**（单独成块、缩进显示，完整七元组按 ABI 顺序；`feeProtocol` 做了拆解，因为裸的那个字节看不出含义）、**我们算出来的**（正反两句价格和流动性）。token 那两行就是别的命令要的 `地址,decimals,符号` 格式，可以直接复制。`--json` 里同样是这三段，七元组收在 `slot0` 键下。不签名、不发交易、不需要私钥——只有 `eth_call`、`eth_getCode` 和 `eth_blockNumber`。

顺手一个自检：`v3sdk tickAtSqrtRatio --sqrtPriceX96 <上面那个值>` 应该正好等于它打印的 `tick`。

它在读之前会先确认这个地址上有合约（所以地址打错、或者 RPC 连到别的网络时，你会看到 `that address has no code on this chain`，而不是一堆莫名其妙的空结果）；端点假死时 20 秒超时退出，不会挂住。

**两条硬规矩**

1. **价格一律写成句子**，不留"谁比谁"：`1 USDT = 0.0498392377369 LINK`。链上只存 `sqrtPriceX96 = √(token1/token0) × 2^96`，`sqrtToPrice` 会翻成正反两句人话——用的是精确整数运算，不经过浮点，所以显示的位数都是对的。参数里的 `token0/token1` 同此约定（token0 = 地址排序后较小的那个）。
2. **参数只有五种给法**：数字/布尔原样、大整数写十进制串（可为负）、`token` 写 `地址,decimals,符号[,chainId]`、JSON 原样、字符串原样。带方括号的是可选参数，省略就用默认值。

## 加函数

在 `src/registry.ts` 里加一条，`list` / `help` / 参数解析 / 补全 / 冒烟测试都自动跟上。然后把它的短名加进 `GROUPS`——`list` 和补全的排序就是按它来的。没加之前，新函数会落在最后的「other」组里，测试也会提醒你。`brief` 保持一行短句（`list` 和补全弹窗显示的就是它），详细说明写进 `note`（`help` 显示那个）：

```ts
"SqrtPriceMath.getAmount0Delta": {
  alias: "amount0Delta",
  brief: "价格走完区间要花多少 token0",
  note: "价格从 √Pa 走到 √Pb，这么多流动性对应多少 token0",
  params: [
    p("sqrtRatioAX96", "jsbi", "176874…"),
    p("sqrtRatioBX96", "jsbi", "179140…"),
    p("liquidity", "jsbi", "138851799446300"),
    p("roundUp", "bool", "false"),
  ],
  fn: (a) => SqrtPriceMath.getAmount0Delta(a.sqrtRatioAX96, a.sqrtRatioBX96, a.liquidity, a.roundUp),
},
```

## 测试

```bash
npm test        # 先 build，再跑两套测试
npm run build   # 产出 dist/
```

`test/smoke.mjs` 管算得对不对（每个离线函数用自己的示例值跑一遍 + 链上数据解码 + 链上基准值），也管表本身的结构（每个函数恰好排一次、每条 `brief` 够短、硬编码的协议常量与 SDK 一致）；`test/cli.mjs` 管你实际敲的那一层（参数解析、`--json`、退出码、补全后端、`--version`、import 时不该跑 CLI、SDK 必须保持懒加载、数学命令只能加载单个模块而不是整包，还包括用本地 mock JSON-RPC 把 `slot0` 整条路走一遍）。一共 90 项。

工具本身不绑定任何池子，参数随便传。测试里那一组期望值是从一个真实 V3 池子读下来（tick 246333）之后冻结的，只用来当锚点——SDK 升级后如果算错，测试会立刻红。

## 当库用（在自己的项目里）

链上数据你自己读，算交给它。参数给十进制字符串就行，不用自己引 jsbi：

```js
import { call, plain } from "uniswap-v3-sdk-cli";

// slot0 / liquidity 是你从链上读到的
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

- `call(短名或 SDK 原名, 参数)`：短名和 `TickMath.getSqrtRatioAtTick` 这种原名都认。
- `plain(v)`：把 JSBI 转成十进制字符串、Price 转成「1 A = x B」句子。要原始值（自己继续算）就别套 `plain`。
- `slot0` 是唯一的异步入口：`await call("slot0", { pool, rpc })`，其余都是同步返回。
- 想遍历函数表：`import { REGISTRY, resolve, convert } from "uniswap-v3-sdk-cli"`，每条是 `{ alias, note, params, fn }`。
- 装法：`npm i github:chaoticpunk/uniswap-v3-sdk-cli`；本地开发用 `npm link uniswap-v3-sdk-cli`。类型随包提供（`dist/registry.d.ts`）。

## 速度，以及被别的程序调用

别的程序 shell 调用时，**启动时间**就是主要成本（M 系 Mac、热缓存、5 次取最快）：

| | |
| --- | --- |
| 裸 `node`（地板） | 约 25 ms |
| `list`、`help`、Tab 补全 | 30–40 ms |
| `slot0`（外加一次到你自己 RPC 的网络往返） | 约 50 ms |
| `sqrtRatioAtTick`、`swapStep`、`maxLiquidity`、`tickToPrice` | 40–60 ms |
| `poolPrice`、`positionFromAmounts`（需要 SDK 实体类） | 约 100 ms |

能压到这个水平靠两件事，测试把两条都锁住了：

- **SDK 是懒加载的**：整个 `@uniswap/v3-sdk` 要约 100 ms、167 个模块，而 `list` / `help` / 补全 / `slot0` 根本用不到它。
- **数学命令只加载单个模块，不走整包 barrel**：`swapStep` 只拉 `utils/swapMath.js` 和它的依赖，一共 5 个模块。将来 SDK 若挪动这些文件，加载器会回退到整包——结果正确，只是慢一点。

（`poolPrice` 和 `positionFromAmounts` 确实需要 SDK 的 `Pool` / `Position` 实体，所以它们付整包的加载成本。）

**如果你的项目要循环调用，别开 100 个进程——直接当库用：**

```js
import { call, plain } from "uniswap-v3-sdk-cli";

const prices = ticks.map((tick) => plain(call("sqrtRatioAtTick", { tick })));
```

实测：同一个进程里调 50 次 **0.06 s**；用命令行调 50 次 **3.2 s**。结果一样，耗时差约 50 倍。

**如果你确实要走命令行**，这几样是可以依赖的稳定契约：

- 任何命令加 `--json` → stdout 只有一个 JSON 对象，没有别的输出。
- 退出码 `0` 成功、`1` 失败；失败时 stderr 有一条可读的消息。
- `v3sdk --version` 打印包版本，方便你做能力探测。

## 四个已知坑（都已在代码里处理）

1. **官方包的 ESM 产物在 Node 原生 ESM 下会挂**（`ERR_UNSUPPORTED_DIR_IMPORT`，因为用了无扩展名的目录导入）。所以 `src/vendor.ts` 统一用 `createRequire` 加载 CJS 副本，类型仍走官方 `.d.ts`。
2. **JSBI 继承自 `Array`**：输出格式化时必须先判 JSBI 再判数组，否则结果会打印成一串内部数字。
3. **`swapStep` 的第二个参数是"价格要走去的目标价"**，方向给反了会得到 `out = 0`（卖 token0 时目标价应更低）。
4. **jsbi 有多份副本**：`@uniswap/v3-sdk` 内部嵌了自己的 jsbi，SDK 用 `constructor === JSBI` 判断类型，传顶层那份会被拒。`src/vendor.ts` 是从 v3-sdk 的位置 require 的。

## 怎么自己验证

它不碰你的私钥、不碰你的文件，而且只有一个文件能碰网络——但不用信 README 的说法，自己验：

```bash
# 1. 只有一个文件碰网络；没有起进程、没有 eval、没有写文件
grep -rlE 'fetch\(|process\.env' src/                        # → src/rpc.ts，以及 src/registry.ts（只读 $RPC_URL）
grep -rnE 'child_process|eval\(|writeFile' src/ || echo "no shell, no eval, no file writes"

# 2. 离线命令断网也照样算（macOS 自带沙箱；Linux 上可用 unshare -n）
sandbox-exec -p '(version 1)(allow default)(deny network*)' node dist/cli.js sqrtRatioAtTick --tick 246333
# 17687452210211969913755435227879803

# 3. 安装时不执行任何依赖的 install 脚本
npm ci --ignore-scripts && npm run build
```

`slot0` 是刻意留的例外，而且它只能是例外——读链上池子就是一次 `eth_call`。其余命令断网照跑。

补全脚本也一样无聊：只是把你敲的词当参数传给 `v3sdk --complete`，再把返回结果打出来。没有 eval，不拼 shell 字符串，不会把你输入的东西变成可执行命令。

## 参与

欢迎提 issue 和 PR——具体见 [CONTRIBUTING.md](CONTRIBUTING.md)（两条硬规矩：`brief` 只写一行；新函数要排进 `GROUPS`）。安全问题走 [SECURITY.md](SECURITY.md)，改动记录在 [CHANGELOG.md](CHANGELOG.md)。

## License

MIT
