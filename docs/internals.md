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
projectionVersion() { return FOLD_VERSION * REVISION_SCALE + (this.revision % REVISION_SCALE) }
```

`revision` 是**折叠语义相关字段**的内容哈希：条目顺序与条数、`provider` / `model`、有没有 `offPeak`（决定标签是 peak/offPeak 还是 flat），以及解析后的调度（时区、高峰星期、高峰窗口、节假日与调休日期）。`prices`、`currency`、`note`、`source`、`id` **不进**哈希——它们只影响展示时的金额换算，不改变样本归到哪个时段。改规则（窗口、时区、节假日、增删条目、有无空闲价）时 `PricingStore` 通知订阅者，插件撤下旧注册、按新版本重装，检查点的 `ver` 随即不匹配，DSH 从 `seq 0` 重折整段日志——**历史因此跟着新规则走，而不是冻结在当初那次判定上**；改价格或备注则只刷新展示，不作废任何检查点。

**时段标签不写死成高峰**：折叠入口是 `tariffOf(entry, timestamp)`，匹配不到条目、条目只有统一单价、或时间戳不可用时一律返回 `flat`（不分峰谷）。兜底值曾是 `peak`，于是「还没配置价格」和「只填了统一单价」这两段用量都会被计成高峰，而标签一旦写进检查点就冻结——这正是「高峰用量比规则算出来的多出十几个百分点」的来源。明细面板会单独标出 `flat` 用量的「未记录时段」，不会默默按高峰价冒充。

## 价目表端点

**只接受回环来源**：读写端点要求 peer socket 是回环且 `Host` 头是回环或 `localhost`。经 Tailscale 等**远程地址**访问 GUI 时端点返回 403，费用面板会显示「未配置价格」并在设置页给出失败原因。

这是 CSRF 与 DNS-rebinding 防线的一部分：放宽判据需要复用 connection 插件的信任判定，而该判定位于客户端包内，link 安装的插件解析不到它，重写一份又会重复安全关键逻辑。经远程地址使用时，请直接编辑 `<DSH_HOME>/token-fee.json`。

写请求另外要求自定义动作头，读取端点只做来源判定。端点抛出的异常一律就地转成结构化错误响应——当前 DSH 的 webserver 外层还有 last-resort `.catch()`（回 400 纯文本），逃逸的 rejection 不会终止进程，但客户端拿不到可读原因；`test-process.mjs` 专门盯这条。

## 已知取舍

- **节假日数据是静态包数据，不随配置热更新**：`data/cn-holidays.json` 由 host 在装载期**同步**读一次并当作常量——Config 校验与投影注册都跑在装载期，两者都必须同步拿到它，否则 `stateVersion` 在注册时还拿不到表指纹，异步读会让检查点与真实表脱节。代价是改数据要重启 `dsh`；换来的是节假日变更会改变表指纹，从而让检查点失效、整段日志按新数据重折，历史因此跟着改（与改价格走同一条路径）。
- **逐年更新**：文件里没有的年份会退回「按自然工作日判定」，即该年的法定节假日按高峰价计。
- **跨币种不自动折算**：插件不做任何外发请求，也不会硬编码一个会过期的汇率，所以折算率只能由用户通过 `exchangeRates` 提供。各币种**始终并列累加**（不丢信息）；**只要有一种外币缺汇率就不给折算合计**——半个合计比没有合计更危险，它看起来像「全部算完了」，实际漏掉了一种币。汇率方向定为「1 单位该币种等于多少展示币种」，并拒绝包含展示币种自身：那是目标不是来源，写进去说明方向理解反了。
- **倒计时的小时不进位到天**：跨周末的长间隔按总小时数显示（例如 `63:00:00`），比「2 天 15 小时」更直接地回答「还剩多久」。
- **金额四舍五入到分**：胶囊显示到分；明细面板给出更精确的数值。
- **两种「会话口径」是刻意不同的**：胶囊 / 明细里的**本会话**数字按整条日志折（与官方 `tokenUsage` 一致），因此 fork 出来的会话会带着祖先那段的用量——它是这条会话上下文的一部分，也确实会被再次发给模型。**子代理端点**只折 `seq >= inheritedEventCount` 的**后缀**，因为父会话那一段已经由父会话自己的视图计过，重复计入就是四倍放大的那个 bug。两处都有注释与用例，别把它们「统一」掉。
- **没有 route 的用量不计入**：`request/header` / `request/context` 都给不出 provider·model 时，本插件折不出可计价的行，该样本被跳过；官方 `tokenUsage` 会照常累计总量。因此来源不明的日志（迁移 / 手工拼接）里，插件的 token 合计可能小于官方统计——这是「不知道价就不冒充」的取舍。
- **端点的信任边界是本机进程**：`kind: 'exact'` 路由先于 `/api` 前缀命中，因此绕过 DSH 的 web 鉴权，只靠「peer 回环 + Host 回环」两重判定；本机任意进程可读价目表、带自定义动作头可写。若前面有把 `Host` 改写成回环的反向代理，远程也能命中——经 Tailscale 等远程地址访问时请直接编辑文件。
- **两半的换算「语义等价」而非逐位相同**：host 的 `computeCost` 与浏览器的 `computeView` 走同一套规则，但浮点累加顺序可能差 1e-13 量级（舍入到分后无差），未定价计数的分行/分模型口径也略有不同，越界 token 值（负数、字符串、NaN）的处理以浏览器侧为准。测试断言的是「同一输入下金额与时段一致」，不是 IEEE 逐位相等。

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
projectionVersion() { return FOLD_VERSION * REVISION_SCALE + (this.revision % REVISION_SCALE) }
```

`revision` is a hash of the fields that affect **fold semantics only**: entry order and count, `provider` / `model`, whether `offPeak` exists (which decides whether the label is peak/offPeak or flat), and the resolved schedule (timezone, peak weekdays, peak windows, holiday and make-up workday dates). `prices`, `currency`, `note`, `source` and `id` are **not** hashed — they only affect the displayed conversion, never which period a sample belongs to. When a rule changes (window, timezone, holidays, entries added/removed, off-peak added/removed), `PricingStore` notifies its subscribers and the plugin tears down the old registration and installs a new one; the checkpoint's `ver` then no longer matches and DSH refolds the whole log from `seq 0`. **History therefore follows the current rule instead of staying frozen at the original verdict.** Editing a price or a note only refreshes the display and invalidates no checkpoints.

**The period label never defaults to peak**: the fold entry point is `tariffOf(entry, timestamp)`, which returns `flat` (no peak/off-peak split) when no entry matches, when the entry carries a single unit price only, or when the timestamp is unusable. The fallback used to be `peak`, so usage recorded before a price existed — or under a single unit price — was counted as peak, and once written into the checkpoint that label was frozen. That is exactly where "peak usage exceeds what the rule computes by a dozen points" came from. The breakdown panel reports `flat` usage separately as "without a period" rather than passing it off as peak.

## Pricing endpoints

**Loopback origins only**: reads and writes require the peer socket to be loopback and the `Host` header to be loopback or `localhost`. Reaching the GUI over a **remote address** such as Tailscale makes the endpoints return 403, the cost panel shows everything as unpriced, and the settings page reports the failure.

This is part of the CSRF and DNS-rebinding defense: relaxing it would mean reusing the connection plugin's trust decision, which lives in a client package that a link-installed plugin cannot resolve, and re-implementing it would duplicate security-critical logic. Over a remote address, edit `<DSH_HOME>/token-fee.json` directly.

Writes additionally require a custom action header; reads only decide on origin. Any exception thrown by an endpoint is converted into an error response on the spot — an escaped rejection would take `dsh web` down with it, and `test-process.mjs` watches that specifically.

## Known trade-offs

- **The holiday data is static package data, not hot-reloaded configuration**: the host reads `data/cn-holidays.json` **synchronously** once at load and treats it as a constant — both config validation and projection registration run at load time and must see it synchronously, otherwise `stateVersion` would register before the table fingerprint is available and the checkpoint could disagree with the real table. The cost is that changing the data needs a `dsh` restart; the benefit is that a holiday change alters the fingerprint, which invalidates the checkpoint and refolds the whole log against the new data — history follows, exactly as it does for a price edit.
- **A yearly update**: a year with no data falls back to the natural-weekday decision, so that year's public holidays count as peak.
- **No automatic cross-currency conversion**: the plugin makes no outbound requests and will not hard-code a rate that goes stale, so conversion rates can only come from the user via `exchangeRates`. Every currency is **always accumulated side by side** (no information dropped); and **if any foreign currency lacks a rate, no converted total is shown at all** — half a total is more dangerous than none, because it looks finished while quietly missing a currency. The rate direction is "one unit of that currency equals how many units of the display currency", and naming the display currency itself is rejected: it is the target, not a source, so listing it means the direction was misunderstood.
- **The countdown does not carry hours into days**: a long gap across a weekend is shown as total hours (for example `63:00:00`), which answers "how long left" more directly than "2 days 15 hours".
- **Amounts round to the cent**: the pill shows cents; the breakdown panel gives more precise figures.
- **The two "session scopes" are deliberately different**: the pill / breakdown figures for **this session** fold the whole log (matching the official `tokenUsage`), so a forked session carries its ancestor's usage — it is part of this session's context and will be sent to the model again. The **subagent endpoint** folds only the `seq >= inheritedEventCount` **suffix**, because the parent's share is already counted by the parent's own view and counting it again is exactly the 4× inflation bug. Both places carry comments and tests; do not "unify" them.
- **Usage without a route is not counted**: when neither `request/header` nor `request/context` yields a provider·model, the plugin cannot price that sample and skips it, while the official `tokenUsage` still accumulates the raw total. On logs of unknown provenance (migrated or hand-assembled) the plugin total can therefore be lower than the official token count — a deliberate "do not pretend to know the price" trade-off.
- **The endpoint's trust boundary is local processes**: `kind: 'exact'` routes match before the `/api` prefix, so they bypass DSH's web auth and rely only on the peer-loopback plus Host-loopback checks; any local process can read the pricing table and, with the custom action header, write it. If a reverse proxy rewrites `Host` to loopback, a remote caller can also reach it — over Tailscale or similar, edit the file directly.
- **The two halves are "semantically equivalent", not bit-identical**: host `computeCost` and browser `computeView` follow the same rules, but floating-point accumulation order can differ around 1e-13 (no difference once rounded to the cent), the unpriced count is grouped slightly differently, and out-of-range token values (negative, string, NaN) are handled by the browser side. The tests assert equal amounts and periods for the same input, not IEEE bit equality.
