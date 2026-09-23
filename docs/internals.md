# 内部机制 / Internals

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

费用与时段是怎么算出来的、算在哪里，以及几处刻意的取舍。

## 数据流

```
会话事件 ──▶ host 投影 tokenFee ──▶ 浏览器换算 ──▶ 胶囊与明细面板
              （只携带 token 桶）      （按当前价目表）
价目表文件 ──▶ 回环端点 ─────────────┘
```

**投影只携带 token 桶**：host 折叠出 `(provider, model, tariff)` 三元组的四个 token 桶，金额一律由浏览器按**当前**价目表换算。因此改价格立即生效、也不会让持久化的投影缓存失效。代价是 host 与浏览器各有一份换算实现（浏览器侧无法 import host 模块），峰谷判定与倒计时同样如此——`test-client.mjs` 里有数组断言把两侧的费用与时段结果钉在一起，避免它们悄悄漂移。`lib/pricing.js` 的 `computeCost` / `costOfEntry` / `tariffStateAt` 保留在 host 侧，正是作为这组对照断言的锚点。

## 时段归属

**一个样本属于哪个时段是在折叠时定下的**，写进投影状态。投影状态是持久化检查点（`~/.dsh/storages/session_projcache/sessions/<id>.json`），DSH 只在检查点的 `ver` 与当前 `stateVersion` 一致、且 `seq` 落在范围内时复用它、只回放其后的尾部事件。

时段分桶是**唯一**被烘进这份状态的派生数据，因此插件把有效价目表的内容指纹并进了 `stateVersion`：

```js
projectionVersion() { return FOLD_VERSION * REVISION_SCALE + this.revision }
```

`revision` 是归一化条目与调度的内容哈希。价目表一变（改价格、改规则、增删条目），`PricingStore` 就通知订阅者，插件撤下旧注册、按新版本重装；检查点的 `ver` 随即不匹配，DSH 从 `seq 0` 重折整段日志。**历史因此跟着新规则走，而不是冻结在当初那次判定上。**

**时段标签不写死成高峰**：折叠入口是 `tariffOf(entry, timestamp)`，匹配不到条目、条目只有统一单价、或时间戳不可用时一律返回 `flat`（不分峰谷）。兜底值曾是 `peak`，于是「还没配置价格」和「只填了统一单价」这两段用量都会被计成高峰，而标签一旦写进检查点就冻结——这正是「高峰用量比规则算出来的多出十几个百分点」的来源。明细面板会单独标出 `flat` 用量的「未记录时段」，不会默默按高峰价冒充。

## 价目表端点

**只接受回环来源**：读写端点要求 peer socket 是回环且 `Host` 头是回环或 `localhost`。经 Tailscale 等**远程地址**访问 GUI 时端点返回 403，费用面板会显示「未配置价格」并在设置页给出失败原因。

这是 CSRF 与 DNS-rebinding 防线的一部分：放宽判据需要复用 connection 插件的信任判定，而该判定位于客户端包内，link 安装的插件解析不到它，重写一份又会重复安全关键逻辑。经远程地址使用时，请直接编辑 `<DSH_HOME>/token-fee.json`。

写请求另外要求自定义动作头，读取端点只做来源判定。端点抛出的异常一律就地转成错误响应——一个逃逸的 rejection 会让 `dsh web` 直接退出，`test-process.mjs` 专门盯这条。

## 已知取舍

- **中国法定节假日**：官方的高峰判定不含法定节假日，本插件按自然工作日判定，因此法定节假日会被高估为高峰价。需要精确计费时，请为节假日单独调整规则或改用固定单价。
- **跨币种**：不同币种的金额不会换算合并。胶囊与合计只统计展示币种，其他币种在明细中单独提示。
- **倒计时的小时不进位到天**：跨周末的长间隔按总小时数显示（例如 `63:00:00`），比「2 天 15 小时」更直接地回答「还剩多久」。
- **金额四舍五入到分**：胶囊显示到分；明细面板给出更精确的数值。

<h2 id="english">English</h2>

How the cost and the period are computed, where the computation happens, and a few deliberate trade-offs.

## Data flow

```
session events ──▶ host projection tokenFee ──▶ browser conversion ──▶ pill and breakdown
                    (token buckets only)          (against the current table)
pricing file ────▶ loopback endpoints ─────────┘
```

**The projection carries token buckets only**: the host folds four token buckets per `(provider, model, tariff)` triple, and every amount is converted in the browser against the **current** pricing table. Price edits therefore apply immediately and never invalidate the persisted projection cache. The cost is that host and browser each have their own conversion implementation (the browser side cannot import the host module) — the same holds for the tariff decision and the countdown; several assertions in `test-client.mjs` pin both the cost and the period results together so they cannot drift unnoticed. `computeCost` / `costOfEntry` / `tariffStateAt` in `lib/pricing.js` stay on the host side precisely as the anchors for that comparison.

## Period attribution

**Which period a sample belongs to is decided at fold time** and written into the projection state. That state is a persisted checkpoint (`~/.dsh/storages/session_projcache/sessions/<id>.json`), and DSH only reuses it — replaying just the tail after it — when the checkpoint's `ver` matches the current `stateVersion` and its `seq` falls inside the range.

The period split is the **only** piece of derived data baked into that state, so the plugin folds a content fingerprint of the effective pricing table into `stateVersion`:

```js
projectionVersion() { return FOLD_VERSION * REVISION_SCALE + this.revision }
```

`revision` is a content hash of the normalized entries and schedules. Whenever the table changes (a price edit, a rule edit, an entry added or removed), `PricingStore` notifies its subscribers and the plugin tears down the old registration and installs a new one; the checkpoint's `ver` then no longer matches and DSH refolds the whole log from `seq 0`. **History therefore follows the current rule instead of staying frozen at the original verdict.**

**The period label never defaults to peak**: the fold entry point is `tariffOf(entry, timestamp)`, which returns `flat` (no peak/off-peak split) when no entry matches, when the entry carries a single unit price only, or when the timestamp is unusable. The fallback used to be `peak`, so usage recorded before a price existed — or under a single unit price — was counted as peak, and once written into the checkpoint that label was frozen. That is exactly where "peak usage exceeds what the rule computes by a dozen points" came from. The breakdown panel reports `flat` usage separately as "without a period" rather than passing it off as peak.

## Pricing endpoints

**Loopback origins only**: reads and writes require the peer socket to be loopback and the `Host` header to be loopback or `localhost`. Reaching the GUI over a **remote address** such as Tailscale makes the endpoints return 403, the cost panel shows everything as unpriced, and the settings page reports the failure.

This is part of the CSRF and DNS-rebinding defense: relaxing it would mean reusing the connection plugin's trust decision, which lives in a client package that a link-installed plugin cannot resolve, and re-implementing it would duplicate security-critical logic. Over a remote address, edit `<DSH_HOME>/token-fee.json` directly.

Writes additionally require a custom action header; reads only decide on origin. Any exception thrown by an endpoint is converted into an error response on the spot — an escaped rejection would take `dsh web` down with it, and `test-process.mjs` watches that specifically.

## Known trade-offs

- **Chinese public holidays**: the official peak decision excludes public holidays, while this plugin decides by natural weekdays, so holidays are overpriced as peak. For exact billing, adjust the schedule for those days or use a flat price.
- **Cross-currency**: amounts in different currencies are not converted or merged. The pill and the total count the display currency only; other currencies are reported separately in the breakdown.
- **The countdown does not carry hours into days**: a long gap across a weekend is shown as total hours (for example `63:00:00`), which answers "how long left" more directly than "2 days 15 hours".
- **Amounts round to the cent**: the pill shows cents; the breakdown panel gives more precise figures.
