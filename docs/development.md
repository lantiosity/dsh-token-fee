# 开发 / Development

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

本仓库无构建步骤：`lib/*.js` 是直接发布的产物，浏览器半是手写的 `__ModuleLoader__` 包。

## 命令

```bash
npm run check          # 语法检查
npm test               # 离线套件（纯函数 / host / 浏览器半静态渲染 / 安装器 / 组件级 / 闸门语义）
npm run test:process   # 进程级回归：用 --patch overlay 装进真实 dsh web 并探测端点
npm run verify         # 语法检查 + 离线套件 + 进程级回归（CI 用的就是它）
npm run verify:process # 同上但进程级为严格模式：跳过即失败（CI 的 process job 用它）
npm run pack:check     # npm pack --dry-run，核对发布载荷
```

`npm test` 不需要 dsh，也不需要网络。`test-process.mjs` 需要 `dsh` 在 PATH 上：

- 正常运行时退出码 `0`；环境不满足（没有 dsh、无法分配端口、插件未装进 profile）时退出码 **`77`**（autotools 的「skipped」约定），与失败区分开；
- `--strict`（或 `TOKEN_FEE_REQUIRE_PROCESS=1`）把跳过变成失败（退出码 `1`）——CI 的 `process` job 就是这么用的；
- `npm run verify` 由 `scripts/verify.mjs` 编排，显式把 `77` 当「跳过」放行并在末尾提示，因此**无 dsh 的环境里 `verify` 仍然是绿的**；真正的失败（其它非零码）照常变红。

## 测试套件

| 套件 | 覆盖 |
| --- | --- |
| `scripts/test-pricing.mjs` | 价目表校验（含同层重复身份）、匹配优先级、峰谷判定、时段切换倒计时（含 DST 与成本上界）、费用换算、随包节假日数据 |
| `scripts/test-host.mjs` | `apply` 的注册行为、投影折叠（含替换与重试）、价目表文件读写、保存端点的汇率兜底、指纹只跟折叠语义走、端点鉴权与 Promise 归属、子代理子树递归 |
| `scripts/test-client.mjs` | 模块工厂装配、`apply` 的 slot 注册、真实 React 渲染（含胶囊上的计费模式）、两侧费用/时段/倒计时一致性与成本上界、子代理卡片的四态呈现 |
| `scripts/test-editor.mjs` | 组件级：直接驱动 `PricingEditor` 的保存按钮，断言真实 `POST` 请求体（汇率接线、文件无效时不发请求）——静态 HTML 断言咬不住这条路径 |
| `scripts/test-install.mjs` | 安装器端到端：复制清单与 `files` 对齐、安装后**真的 import** host 半、`--check` 能发现缺文件、幂等（含手写单引号 patch） |
| `scripts/test-verify.mjs` | 闸门语义：`verify` 对进程级退出码 0/77/其它的判定 |
| `scripts/test-process.mjs` | 经 `--patch` overlay 装进真实 `dsh web`：端点契约、异常路径，以及**端点出错后进程仍然存活**（跳过 = 77，严格模式 = 失败） |

`test-client.mjs` 会从 `<DSH_HOME>/profiles/node_modules` 解析真实 React；解析不到时**直接报错**（不会静默跳过——CI 有 devDependencies，正常情况下总能解析到）。

`test-client.mjs` 里有三类「冻结约定」的断言，它们守的是本仓库最容易悄悄退化的地方：

- **两侧一致性**：host 与浏览器的费用换算、时段判定、倒计时逐项对齐；
- **设计 token 白名单**：引用的每个 `--dsw-*` 都经过核对，并断言「画了 `--dsw-specific-menu` 就要配毛玻璃」「`position:sticky` 要用不透明底色」；
- **胶囊结构**：分隔符必须落在 `.tf_text` 内、不写死字色、不带尾随空格。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `lib/pricing.js` | 纯定价原语：内置表、命名调度、分层合并、条目匹配、时段判定与倒计时、费用换算 |
| `lib/index.js` | host 半：`tokenFee` 会话投影 + 价目表读写端点 |
| `lib/client.js` | 浏览器半：费用胶囊（含计费模式与倒计时）、明细面板、价格编辑器、设置页 |
| `data/cn-holidays.json` | 大陆法定节假日数据；host 在装载期同步读一次，年度更新只改这个文件 |
| `cordis.patch.yml` | bundle 层 patch，挂载 host 半 |
| `scripts/install.mjs` | 无法使用 `dsh plugin` 时的备选安装器 |

`lib/client.js` 是一个手写的 CommonJS 风格包体，`lib/index.js` 与 `lib/pricing.js` 是普通 ESM。三者都不经过打包器，改完直接生效（浏览器侧刷新页面即可）。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`configuration.md`](configuration.md) | 价目表与峰谷规则的完整参考、编辑器行为 |
| [`internals.md`](internals.md) | 投影与时段归属、两侧换算、端点防线 |
| [`dsh-integration.md`](dsh-integration.md) | 与 DSH 的集成约束、跨版本兼容矩阵 |
| [`release-notes/`](release-notes/) | 每个版本的发版说明 |

<h2 id="english">English</h2>

This repository has no build step: `lib/*.js` is the shipped artifact, and the browser half is a hand-written `__ModuleLoader__` bundle.

## Commands

```bash
npm run check          # syntax check
npm test               # offline suites (pricing / host / browser-half render / installer / component-level / gate semantics)
npm run test:process   # process-level regression: install into a real dsh web via a --patch overlay and probe the endpoints
npm run verify         # syntax check + offline suites + process-level regression (what CI runs)
npm run verify:process # same, but process-level in strict mode: a skip counts as failure (CI's process job uses this)
npm run pack:check     # npm pack --dry-run, to check the published payload
```

`npm test` needs neither dsh nor the network. `test-process.mjs` needs `dsh` on PATH:

- exit code `0` when it really ran; exit code **`77`** (the autotools "skipped" convention) when the environment cannot support it (no dsh, no free port, plugin not installed in the profile), which keeps "skipped" distinct from "failed";
- `--strict` (or `TOKEN_FEE_REQUIRE_PROCESS=1`) turns a skip into a failure (exit code `1`) — that is what CI's `process` job uses;
- `npm run verify` is orchestrated by `scripts/verify.mjs`, which explicitly treats `77` as "skipped" and reports it at the end, so **`verify` stays green where dsh is absent**; real failures still turn it red.

## Test suites

| Suite | Coverage |
| --- | --- |
| `scripts/test-pricing.mjs` | Pricing validation (including duplicate identities in one layer), matching precedence, the tariff decision, the switch countdown (DST and a cost bound), cost conversion, the shipped holiday data |
| `scripts/test-host.mjs` | `apply` registration, projection folding (including replacement and retry), pricing-file reads and writes, the save endpoint's exchange-rate fallback, the fold-semantics-only fingerprint, endpoint authorization and promise ownership, recursive subagent subtrees |
| `scripts/test-client.mjs` | Module-factory assembly, `apply` slot registration, real React rendering (including the billing mode on the pill), host/browser agreement on cost, period and countdown plus a cost bound, the four subagent-card states |
| `scripts/test-editor.mjs` | Component level: drives `PricingEditor`'s save button directly and asserts the real `POST` body (exchange-rate wiring, no request while the file is invalid) — static HTML assertions cannot reach this path |
| `scripts/test-install.mjs` | Installer end to end: copy list aligned with `files`, **really imports** the installed host half, `--check` catches missing files, idempotency (including a hand-written single-quoted patch) |
| `scripts/test-verify.mjs` | Gate semantics: how `verify` classifies process-suite exit codes 0/77/other |
| `scripts/test-process.mjs` | Installed into a real `dsh web` via a `--patch` overlay: endpoint contract, failure paths, and **the process staying alive after an endpoint error** (skip = 77, strict mode = failure) |

`test-client.mjs` resolves real React from `<DSH_HOME>/profiles/node_modules`; when resolution fails it **errors out** rather than silently skipping (CI has devDependencies, so it normally always resolves).

`test-client.mjs` carries three kinds of "frozen convention" assertions, guarding the places this repository most easily degrades:

- **Two-side agreement**: host and browser cost conversion, tariff decisions and countdowns aligned item by item;
- **A design-token allowlist**: every `--dsw-*` referenced was checked, plus assertions that a `--dsw-specific-menu` fill carries the backdrop filter and that `position:sticky` uses an opaque fill;
- **Pill structure**: separators must sit inside `.tf_text`, must not pin a colour, and must carry no trailing space.

## Code structure

| File | Responsibility |
| --- | --- |
| `lib/pricing.js` | Pure pricing primitives: the built-in table, named schedules, layer merging, entry matching, tariff decisions and countdown, cost conversion |
| `lib/index.js` | Host half: the `tokenFee` session projection plus the pricing read/write endpoints |
| `lib/client.js` | Browser half: the cost pill (with billing mode and countdown), the breakdown panel, the price editor, the settings page |
| `data/cn-holidays.json` | Mainland China holiday data; the host reads it once at load, and the yearly update touches only this file |
| `cordis.patch.yml` | Bundle-layer patch mounting the host half |
| `scripts/install.mjs` | Fallback installer for when `dsh plugin` is unavailable |

`lib/client.js` is a hand-written CommonJS-style bundle body; `lib/index.js` and `lib/pricing.js` are plain ESM. None of them goes through a bundler, so edits take effect directly (refresh the page for the browser side).

## Documentation

| File | Content |
| --- | --- |
| [`configuration.md`](configuration.md) | Complete reference for the pricing table and peak/off-peak schedules, plus editor behaviour |
| [`internals.md`](internals.md) | Projection and period attribution, two-side conversion, endpoint defenses |
| [`dsh-integration.md`](dsh-integration.md) | DSH integration constraints and the cross-version compatibility matrix |
| [`release-notes/`](release-notes/) | Release notes per version |
