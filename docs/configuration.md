# 配置参考 / Configuration reference

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

价目表与峰谷规则的完整参考：三层合并、文件格式、匹配优先级，以及面板与设置页里那个编辑器具体怎么行为。

## 存储与优先级

价目表由三层合并而成，**后者覆盖前者**：

1. 插件内置层：DeepSeek 官方定价——`deepseek-flash`、`deepseek-v4-pro` 两个模型各一条，共 2 条；**一条覆盖 `deepseek-official` 与 `deepseek-account` 两条路由**；
2. 用户文件层：`<DSH_HOME>/token-fee.json`；
3. 插件配置层：cordis 配置中的 `pricing` / `schedules` 字段。

插件**不会**为其他供应商内置任何价格：同一模型经由中转商、聚合网关或自建代理调用时价格并不相同，用官方价冒充会得出错误的账单。其他供应商的价格请自行添加条目。

用户文件在每次读取端点被触达时按 mtime 缓存校验，因此手工编辑 `token-fee.json` 后无需重启即可生效。

## 插件配置（cordis.yml）

`cordis.yml` 里该条目的 `config` 接受五个键：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `displayCurrency` | `CNY` | 胶囊与合计使用的展示币种，必须是 ICU 认识的 ISO 4217 代码。 |
| `exchangeRates` | 无 | 折算汇率表，见下文「多币种」。形状 `{ 币种代码: 数值 }`，含义为 **1 单位该币种等于多少展示币种**。**通常写在 `token-fee.json` 里**（改完即生效）；这里的一份作为管理员覆盖，同币种优先。 |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | 用户价目表路径；相对路径按 `DSH_HOME` 解析。 |
| `schedules` | 无 | 额外或覆盖内置的命名峰谷规则。 |
| `pricing` | 无 | 额外或覆盖其它层的价目条目。 |

配置在**装载期**校验：未知键、拼错的币种、结构不合法的条目都会让插件以 FAILED 结束，而不是被静默忽略——写错配置时应当立刻知道。跨字段规则（条目引用不存在的调度名）同样在装载期报错。

```yaml
- id: token-fee
  config:
    displayCurrency: CNY
    exchangeRates:
      USD: 7.2
    pricingFile: my-prices.json
```

## 多币种

价目条目各带 `currency`，因此同一个会话里可能同时存在人民币与美元用量。插件**不做任何外发请求**，也不会硬编码一个会过期的汇率，所以分两层处理：

1. **并列显示（始终生效）**：胶囊、合计、明细里的**每个供应商行**与每个模型各自按币种累加，形如 `¥1.23 + US$0.56`。展示币种排在前面，其余按金额降序。任何币种的用量都不会被丢掉——只按展示币种累加的话，一个只跑过美元路由的供应商会在那一行显示成 `¥0.00`。模型行只有一种币（一条条目一种币），因此它显示的本来就是自己的币种。
2. **折算合计（需要你配汇率）**：在插件配置里写了 `exchangeRates` 之后，再额外给出一个折算成展示币种的合计，形如 `≈ ¥5.26`。用 `≈` 而不是 `=`，因为那是按你给的汇率算出来的参考值，不是任何一方的实际入账金额。

**只要有一种外币没有配汇率，就不给折算合计**——半个合计比没有合计更危险：它看起来像「全部算完了」，实际漏掉了一种币。明细会点名缺汇率的币种。

汇率是**相对展示币种**的方向（`USD: 7.2` 表示 1 美元 = 7.2 元），并且不该包含展示币种自身（它是折算目标，写了会报错）。改了 `displayCurrency` 之后汇率要按新目标重新填。

**汇率写在用户文件 `token-fee.json` 的 `exchangeRates` 里**（见下文「文件格式」）：文件按 mtime 热读，**改完不用重启 dsh**（打开「价格设置」页会重新拉取，胶囊刷新页面后更新）。`cordis.yml` 里的 `exchangeRates` 仍然有效，保留给管理员覆盖——同一币种以配置为准，没写的沿用文件里的值。设置页的保存会把文件层那份汇率原样带回去，因此不会因为改了一次价目表就把汇率清空。

## 文件格式

```json
{
  "version": 1,
  "exchangeRates": {
    "USD": 7.2
  },
  "schedules": {
    "my-peak": {
      "timezone": "Asia/Shanghai",
      "peakDays": [1, 2, 3, 4, 5],
      "peakWindows": [["09:00", "12:00"], ["14:00", "18:00"]]
    }
  },
  "entries": [
    {
      "id": "my-gateway-flash",
      "provider": "my-gateway",
      "model": "deepseek-flash",
      "currency": "CNY",
      "schedule": "my-peak",
      "prices": {
        "peak": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
        "offPeak": { "input": 1, "cacheRead": 0.02, "cacheWrite": 0, "output": 4 }
      }
    }
  ]
}
```

字段说明：

| 字段 | 含义 |
| --- | --- |
| `exchangeRates` | 折算汇率表：`{ 币种代码: 数值 }`，含义是 1 单位该币种等于多少展示币种。写在文件里改完即生效；`cordis.yml` 那份作为管理员覆盖，同币种以配置为准。空表不必写。 |
| `id` | 条目标识；省略时由插件生成。同一层内用于去重与覆盖。 |
| `provider` | 路由 provider id，例如 `deepseek-official` 或你自己的中转商 id。`*` 表示通配。 |
| `model` | 模型 id，例如 `deepseek-flash`。`*` 表示通配。 |
| `currency` | 三位货币代码，决定金额的展示币种。 |
| `schedule` | 引用 `schedules` 中的名字，或直接内联一份规则，或 `null` 表示不分峰谷。 |
| `prices.peak` | 高峰（或唯一）单价，单位是**每百万 token**。 |
| `prices.offPeak` | 空闲单价；出现时必须配 `schedule`。 |
| `cacheWrite` | 未提供时按 0 处理。 |

## 编辑器行为

面板的「价格设置」页签与 dsh 设置里的「Token 费用」页用的是同一个编辑器，因此下面这些行为两处一致。

### 按供应商折叠

价目条目（自定义与只读内置两段都是）**按供应商分组**，每组一个整宽的表头，写着供应商 id、该组条目数与一个折叠箭头。**默认全部折叠**：先给一张「供应商 · 条数」的清单，要看具体条目再展开——条目一多，一屏铺开的卡片反而更难扫。

**列表按供应商、模型名的首字母排序**，组内同理。比较忽略大小写（`alpha` 排在 `Beta` 前），但**分组按原样**——provider id 大小写敏感，`Beta` 与 `beta` 是两条不同的路由，不会被并成一组。用码位而不是 `localeCompare` 比较：列表顺序不该随运行环境的 locale 变化，否则同一份配置在两台机器上看到的顺序会不一样。

**排序与折叠都只作用于展示**：底层数组的顺序决定同优先级通配条目的匹配顺序（先出现的胜出），因此展示层排的是副本，编辑与删除仍按条目在原始数组里的下标回写。

几条细节：

- **正在编辑的条目所在分组强制展开**：否则点了「编辑」或「新增条目」却看不到表单，用户只会以为按钮坏了。折叠的意图让位于正在进行的编辑。
- 表头是**按钮**而不是装饰性标题：折叠是交互，得能用键盘触发，`aria-expanded` 与实际状态始终一致。
- `provider` 还没填的新条目自成一组，表头显示「（未填供应商）」；它同时处在编辑态，所以那一组会被强制展开。
- **点「新增条目」时新条目排在第一位**，不是追加到最后：它的 `provider` / `model` 都是空的，本来就该在最显眼处填写；条目一多，追加到末尾会让人还得往下滚才能找到那个刚出现的编辑框。顺序同时决定同优先级通配条目的匹配顺序（先出现的胜出），因此排在最前也符合「刚加的优先」。
- 自定义条目与只读内置条目各折各的，即使两段里有同名供应商。

### 明细面板按模型折叠

费用明细面板里，**每个模型默认只显示模型名、总 token 数与费用**，点一下才展开四个计费桶各自的 token 数与金额。一个会话常有十几个模型，先摆出总量、要看细节再展开，面板一打开就能扫完总额。

折叠时仍会显示**警示**徽章（未记录时段、缺少价目条目）：它们关乎账单准不准，不该藏在一次点击之后。中性的身份徽章（区分峰谷、通配条目）随明细一起收起，因为它们只是补充说明。

### 建议列表

`provider` 与 `model` 是自由输入框，同时带一份来自**当前 dsh 配置**的建议列表（`ctx.llm` 的已注册路由与模型）：`provider` 列出全部已配置路由，`model` 在 `provider` 匹配上之后收窄到该路由的模型，未匹配时列出全部模型。建议只是便利——adapter 允许接受未列出的模型 id，因此输入不受限。

### 数字草稿

单价在界面上以字符串草稿编辑，保存时才转成数字：`Number("1.")` 会得到 `1`，若在输入过程中就转换，小数点会被吞掉，用户根本敲不出小数。

无法解析或为负的输入在保存时**按 0 写入**并提示哪些字段被归零，而不是让整次保存失败——价格表是人工维护的，一个笔误不该连带其它条目的修改一起丢掉。输入框在敲错的那一刻就会标红，悬停有说明。若要让 host 直接拒绝，可手工编辑文件：端点校验是 fail-loud 的。

### 保存前的本地拦截

保存前客户端会拦下两种「界面点得出来、host 必然拒绝」的状态并给出本地化提示：条目没填模型 id、勾了「区分峰谷」却没选规则。

**删光所有条目不再是错误**：规则区与条目区各自独立，只写 `schedules`、一条条目都没有的文件现在存得下去（内置价目与插件配置层照常生效）。此前这条被当成错误拦下，与文档自己承诺的「先建规则、再挂到条目上」相矛盾——全新安装时想先建一条规则，就只能先造一条用不上的条目。要回到纯内置价目，仍用「恢复内置价目」。

### 引用往返

条目对命名调度（`schedules` 里的名字）的引用在编辑往返中原样保留：GET 端点同时返回归一化层与原始层，编辑器草稿用原始层，因此改一处规则仍然会传播到引用它的所有条目。

### 规则表单的排布

规则表单里**时区与法定节假日并排一行，高峰星期独占一行**。这不是随手排的：7 个星期按钮本身要 214px（7 × 28px + 6 × 3px 间距），挤在两列网格的一列里，价格设置面板的宽度下限会被顶到 460px 以上；独占一行之后下限回到四列单价表那边（约 380px），面板因此能收到 440px。`test-client.mjs` 断言了「星期按钮行之前网格必须已闭合」，把它放回网格里会立刻失败。

### 规则下拉框

条目表单里的「峰谷规则」下拉框始终可用：选中一个规则就等于开启峰谷（空闲价以高峰价为初值，你只需改需要改的那一档），选回「统一单价」则清掉空闲价与引用。规则区里新增的规则**不要求先被条目引用**——「先建规则、再挂到条目上」是正常的操作顺序，未被引用的规则会照常写进文件，删除只由规则卡片上的 ✕ 触发。

### 规则卡片

规则卡片与条目卡片同构：默认收敛成「名字 + 一行摘要（时区 · 高峰星期 · 高峰时段）+ 编辑键」，点「编辑」展开，改完点「完成」收起。自定义规则的名字就在展开后的标题位置直接改，失焦或回车提交；改名会同步所有引用它的条目，重名或空名会就地标红并退回原名。

名字在内置表里的规则永远是「内置规则」：不能改名、没有删除键，即使已经被你覆盖（此时标记为「内置规则 · 已覆盖」并多出一个「恢复内置」键）。这是刻意的——内置条目按名字引用 `deepseek`，允许把这条覆盖改名，内置条目会悄悄退回出厂规则，而你只以为自己改了个名字。

删掉一条仍被引用的规则时，条目的引用会被清空但空闲价保留，保存前会提示重新选一条规则；连带删掉用户填好的价格比让他重选一次更伤人。

### 高峰时段输入

配置界面里高峰时段按时、分两个窄输入框填写，只收数字：超过范围的两位输入（`25` 时、`61` 分）只保留后一位，所以非法时刻根本敲不出来；未补零的中间态（`9:5`）在保存时补齐为 `09:05`。结束不晚于开始的行会就地标红，并在保存前被拦下。

## 匹配规则

条目按 `(provider, model)` 匹配，优先级从高到低：**精确 → provider 通配 → model 通配 → 全通配**；同一优先级内先出现的条目获胜。

历史路由 id `deepseek`、以及 DSH 的 **DeepSeek 账号路由 `deepseek-account`**（`@deepseek-ai/dsh-llm-deepseek-account`，界面里叫「DeepSeek 账号」），都会回退到 `deepseek-official`；已下线模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会回退到 `deepseek-flash`。

两条 DeepSeek 路由共用同一套 Messages 传输、同一份模型目录（`deepseek-flash` / `deepseek-v4-pro`）与同一份价目，因此内置表**每个模型只列一条**，账号路由经别名命中同一条。回退**只在精确命中失败后发生**——想给账号路由单独定价，按 `provider: "deepseek-account"` 加一条即可，它会优先获胜。

没有命中任何条目的模型，其 token 数照常展示，金额标记为「未配置价格」，**不计入合计**。

## 峰谷规则

`schedule` 描述高峰时段：

| 字段 | 含义 |
| --- | --- |
| `timezone` | IANA 时区名，例如 `Asia/Shanghai`。配置界面的下拉框按当前 UTC 偏移排序，同偏移内按名字排序且 `UTC` 居首。 |
| `peakDays` | 高峰星期，`0` 为周日。 |
| `peakWindows` | 高峰时段，`["HH:MM", "HH:MM"]` 的左闭右开区间。 |
| `holidays` | 节假日集合名或 `YYYY-MM-DD` 日期数组；这些日期**不算高峰**。 |
| `workdays` | 调休上班集合名或日期数组；这些日期**算高峰**。 |

判定顺序是：先看 `holidays`（命中即空闲，即使落在高峰星期），再看它是不是高峰日——`peakDays` 命中的星期，或 `workdays` 命中的日期——最后才看是否落在某个 `peakWindows` 区间内。同一天同时出现在 `holidays` 与 `workdays` 里时**以假期为准**。

集合名指向随包发布的 [`data/cn-holidays.json`](../data/cn-holidays.json)：

```json
{
  "version": 1,
  "sets": {
    "cn": {
      "name": "中国大陆法定节假日",
      "source": "https://www.gov.cn/zhengce/content/202511/content_7047090.htm",
      "updated": "2025-11-04",
      "holidays": ["2026-01-01", "2026-02-15", "..."],
      "workdays": ["2026-01-04", "2026-02-14", "..."]
    }
  }
}
```

数据取自国务院办公厅的年度放假安排通知，**需要逐年更新**：新年度的通知通常在上一年的 11 月发布，文件里没有的年份会退回「按自然工作日判定」。引用一个不存在的集合名会在装载期报错——那是配置错误，不是缺数据。

官方口径是「法定节假日除外」，**连调休上班的周末也按空闲计**。因此内置 `deepseek` 规则只引用 `cn` 的 `holidays`、**不**引用 `workdays`——按官方价计费时不要给 `deepseek` 挂 `workdays`。`workdays` 是给「你的提供方确实把调休周末算高峰」这种场景留的通用开关，对官方计费不要用。

插件内置一条名为 `deepseek` 的规则（北京时间周一至周五 09:00–12:00、14:00–18:00，法定节假日除外，调休上班的周末也按空闲计）。你可以在用户文件的 `schedules` 中定义同名规则来覆盖它，或新建自己的规则供条目引用。

在界面上直接改这条内置规则即可：内置价目条目引用的是**规则名** `deepseek` 而不是内联的一份规则副本，因此你的覆盖会同时作用到内置条目上——官方调整高峰时段时，改一处就够了。内置规则卡片没有删除键（它总能被覆盖），自定义规则卡片有。

<h2 id="english">English</h2>

The complete reference for the pricing table and peak/off-peak schedules: the three-layer merge, the file format, matching precedence, and exactly how the editor in the panel and the settings page behaves.

## Storage and precedence

The pricing table is merged from three layers, **each overriding the previous one**:

1. Built-in layer: DeepSeek's official pricing — one entry per model (`deepseek-flash`, `deepseek-v4-pro`), two in total; **one entry covers both `deepseek-official` and `deepseek-account`**;
2. User file layer: `<DSH_HOME>/token-fee.json`;
3. Plugin config layer: the `pricing` / `schedules` fields of the cordis config.

The plugin deliberately ships **no** pricing for other providers: the same model costs different amounts through a reseller, an aggregator or a self-hosted proxy, and passing official prices off as theirs produces a wrong bill. Add your own entries for every other provider.

The user file is revalidated against its mtime whenever a read endpoint is touched, so editing `token-fee.json` by hand takes effect without a restart.

## Plugin config (cordis.yml)

The entry's `config` in `cordis.yml` accepts five keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `displayCurrency` | `CNY` | Display currency for the pill and the total; must be an ISO 4217 code ICU recognizes. |
| `exchangeRates` | none | Conversion rates, see "Multiple currencies" below. Shaped `{ currency code: number }`, meaning **one unit of that currency equals how many units of the display currency**. **Normally written in `token-fee.json`** (applies as soon as you save); the copy here is the administrator override and wins per currency. |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | Path to the user pricing table; a relative path resolves against `DSH_HOME`. |
| `schedules` | none | Extra or overriding named peak/off-peak schedules. |
| `pricing` | none | Extra or overriding pricing entries. |

Config is validated **at load time**: unknown keys, a misspelled currency and structurally invalid entries all make the plugin end up FAILED rather than being silently ignored — a misconfiguration should be noticed immediately. Cross-field rules (an entry referencing a schedule name that does not exist) fail at load time too.

```yaml
- id: token-fee
  config:
    displayCurrency: CNY
    exchangeRates:
      USD: 7.2
    pricingFile: my-prices.json
```

## Multiple currencies

Every pricing entry carries its own `currency`, so one session can mix, say, CNY and USD usage. The plugin **makes no outbound requests** and will not hard-code an exchange rate that goes stale, so it handles this in two layers:

1. **Side by side (always on)**: the pill, the total, **each provider row** in the breakdown and each model accumulate per currency independently, as in `¥1.23 + US$0.56`. The display currency comes first and the rest follow by amount, largest first. No currency's usage is dropped — accumulating by display currency alone would show `¥0.00` on the row of a provider that only ever ran a USD route. A model row has a single currency (one currency per entry), so it already shows its own.
2. **Converted total (needs your rates)**: once `exchangeRates` is configured, the plugin additionally gives one total converted into the display currency, as in `≈ ¥5.26`. It uses `≈` rather than `=` because that figure comes from the rates you supplied — it is a reference, not an actual charge from either side.

**If any foreign currency has no rate, no converted total is shown at all** — half a total is more dangerous than no total: it looks finished while quietly missing a currency. The breakdown names the currencies that lack a rate.

Rates are **relative to the display currency** (`USD: 7.2` means one US dollar = 7.2 yuan), and must not include the display currency itself (it is the target; naming it fails validation). If you change `displayCurrency`, refill the rates against the new target.

**Rates live in the user file `<DSH_HOME>/token-fee.json` under `exchangeRates`** (see "File format" below). That file is read by mtime, so **no dsh restart is needed** — opening the pricing page refetches, and the pill updates on a page refresh. `exchangeRates` in `cordis.yml` still works and remains the administrator override — the config value wins per currency, and currencies it omits fall back to the file. Saving from the settings page carries the file's own rates back, so editing the price table never wipes them.

## File format

```json
{
  "version": 1,
  "exchangeRates": {
    "USD": 7.2
  },
  "schedules": {
    "my-peak": {
      "timezone": "Asia/Shanghai",
      "peakDays": [1, 2, 3, 4, 5],
      "peakWindows": [["09:00", "12:00"], ["14:00", "18:00"]]
    }
  },
  "entries": [
    {
      "id": "my-gateway-flash",
      "provider": "my-gateway",
      "model": "deepseek-flash",
      "currency": "CNY",
      "schedule": "my-peak",
      "prices": {
        "peak": { "input": 2, "cacheRead": 0.04, "cacheWrite": 0, "output": 8 },
        "offPeak": { "input": 1, "cacheRead": 0.02, "cacheWrite": 0, "output": 4 }
      }
    }
  ]
}
```

Field reference:

| Field | Meaning |
| --- | --- |
| `exchangeRates` | Conversion table: `{ currency code: number }`, where the number is how many display-currency units one unit of that currency is worth. Editing it in this file applies immediately; the `cordis.yml` copy remains the administrator override and wins per currency. An empty table can be omitted. |
| `id` | Entry identity; generated by the plugin when omitted. Used for de-duplication and overriding within one layer. |
| `provider` | Route provider id, for example `deepseek-official` or your own reseller id. `*` is a wildcard. |
| `model` | Model id, for example `deepseek-flash`. `*` is a wildcard. |
| `currency` | Three-letter currency code deciding the displayed currency of the amount. |
| `schedule` | A name from `schedules`, an inline schedule object, or `null` for a flat price. |
| `prices.peak` | Peak (or sole) unit price, **per million tokens**. |
| `prices.offPeak` | Off-peak unit price; requires a `schedule` when present. |
| `cacheWrite` | Treated as 0 when omitted. |

## Editor behaviour

The panel's "Pricing" tab and the "Token fee" page in dsh settings use the same editor, so everything below holds in both places.

### Folded by provider

Pricing entries — in both the custom and the read-only built-in section — are **grouped by provider**, each group with a full-width header showing the provider id, that group's entry count and a collapse caret. **All groups start collapsed**: you get a "provider · count" list first and expand the one you care about — once the list grows, a screenful of open cards is harder to scan, not easier.

**The list is sorted by provider and then model name**, and so are the entries inside a group. Comparison ignores case (`alpha` before `Beta`), but **grouping does not** — provider ids are case-sensitive, so `Beta` and `beta` are two different routes and are never merged. Comparison is by code unit rather than `localeCompare`: list order must not shift with the runtime locale, or the same configuration would look different on two machines.

**Sorting and folding are presentation only**: the underlying array order decides matching among wildcard entries of the same priority (the earlier one wins), so the view sorts a copy and editing/deleting still write back by each entry's index in the original array.

A few details:

- **A group holding the entry being edited is forced open**: otherwise clicking "Edit" or "Add entry" would show no form and the user would think the button was broken. The intent to fold yields to an edit in progress.
- The header is a **button**, not a decorative title: folding is an interaction and has to be keyboard-reachable, so `aria-expanded` always matches the real state.
- A new entry whose `provider` is still empty forms its own group, headed "(no provider yet)"; it is also in edit mode, so that group is forced open.
- **Clicking "Add entry" puts the new entry first**, not last: its `provider` / `model` are empty and belong where they are most visible, and with a long list appending would force a scroll to find the edit box that just appeared. Order also decides matching among wildcard entries of the same priority (the earlier one wins), so being first matches the intuition that the entry you just added takes precedence.
- Custom and read-only built-in entries fold independently, even when both contain the same provider.

### The breakdown folds per model

In the cost breakdown, **each model shows only its name, total token count and cost** until you click it, which reveals the token count and amount for each of the four billing buckets. A session often spans a dozen models, so leading with the totals keeps the panel scannable the moment it opens.

Collapsed cards still show **warning** badges (usage without a period, no matching entry) — they bear on whether the bill is right and should not hide behind a click. Neutral identity badges (peak/off-peak, wildcard entry) fold away with the detail, since they are only annotations.

### Suggestions

`provider` and `model` are free-text fields with a suggestion list drawn from the **current dsh configuration** (`ctx.llm`'s registered routes and models): `provider` lists every configured route, and `model` narrows to the models of that route once `provider` matches, falling back to all models when it does not. Suggestions are a convenience only — adapters accept model ids that are not listed, so input stays unrestricted.

### Numeric drafts

Unit prices are edited as string drafts and converted to numbers only on save: `Number("1.")` yields `1`, so converting while typing would swallow the decimal point and make decimals impossible to enter.

Inputs that cannot be parsed, or that are negative, are **written as 0** on save with a note listing the corrected fields, instead of failing the whole save — the pricing table is maintained by hand, and one typo should not take every other edit down with it. The field turns red the moment the value is wrong, with an explanation on hover. To have the host reject such input outright, edit the file by hand: endpoint validation is fail-loud.

### Blocked before saving

Before saving, the client blocks two states that the UI can construct but the host would necessarily reject, each with a localized message: an entry with no model id, and an entry with peak/off-peak prices but no schedule selected.

**Deleting every entry is no longer an error**: the rule area and the entry area are independent, so a file carrying only `schedules` and no entries now saves (built-in pricing and the plugin config layer still apply). Treating it as an error contradicted this document's own promise that "create the rule first, attach it to an entry later" is a normal order — on a fresh install, creating a rule first required fabricating a throwaway entry. To go back to purely built-in pricing, still use "Restore built-in pricing".

### Reference round-trips

An entry's reference to a named schedule (a name in `schedules`) survives editing round-trips verbatim: the GET endpoint returns both the normalized and the raw layer, and the editor draft uses the raw one, so editing a rule still propagates to every entry referencing it.

### How the schedule form is laid out

In the schedule form, **timezone and public holidays share one row, and the peak weekdays get a row of their own**. That is deliberate: the seven weekday buttons need 214px (7 × 28px plus 6 × 3px of gap), and squeezing them into one column of a two-column grid pushes the pricing panel's width floor above 460px; on their own row the floor drops back to the four-column price table (about 380px), which is what lets the panel sit at 440px. `test-client.mjs` asserts that the grid has closed before the weekday row, so nesting it back inside fails immediately.

### The schedule dropdown

The entry form's "Tariff schedule" dropdown is always enabled: picking a rule turns peak/off-peak on (the off-peak prices start as a copy of the peak ones, so you only edit the tier you care about), and picking "Flat price" clears both the off-peak prices and the reference. A rule added in the schedules section does **not** have to be referenced by an entry first — building the rule and attaching it afterwards is the natural order, so an unreferenced rule is written to the file as-is; deletion happens only through the ✕ on the rule card.

### Rule cards

Rule cards mirror entry cards: collapsed by default into "name + one-line summary (timezone · peak weekdays · peak windows) + Edit", expanding on Edit and collapsing on Done. A custom rule's name is edited in place at the title, committed on blur or Enter; renaming updates every entry that references it, while an empty or duplicate name is flagged in place and reverts.

A rule whose name exists in the built-in table is always a "Built-in" rule: no rename, no delete button, even once you have overridden it (then it reads "Built-in · overridden" and gains a "Restore built-in" button). That is deliberate — the built-in entries reference `deepseek` by name, so letting that override be renamed would silently drop the built-in entries back to the factory rule while you thought you had only renamed something.

Deleting a rule that entries still reference clears those references but keeps the off-peak prices, and saving reports that a rule must be picked again; silently discarding prices the user typed would hurt more than re-picking a rule.

### Peak window input

In the UI each peak window is entered as two narrow fields per clock, digits only: a two-digit value out of range (`25` hours, `61` minutes) keeps only the last digit, so an impossible time cannot be typed at all, while an unpadded intermediate (`9:5`) is padded to `09:05` on save. A row that does not end after it starts is flagged in place and blocked before saving.

## Matching rules

Entries match on `(provider, model)`, highest priority first: **exact → provider wildcard → model wildcard → full wildcard**; within one priority the earliest entry wins.

The historical route id `deepseek`, and DSH's **DeepSeek account route `deepseek-account`** (`@deepseek-ai/dsh-llm-deepseek-account`, shown as "DeepSeek Account" in the UI), both fall back to `deepseek-official`; the retired model names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` fall back to `deepseek-flash`.

The two DeepSeek routes share one Messages transport, one model catalog (`deepseek-flash` / `deepseek-v4-pro`) and one set of prices, so the built-in layer lists **one entry per model** and the account route matches it through the alias. The fallback happens **only after an exact match fails** — to price the account route separately, add an entry with `provider: "deepseek-account"` and it wins.

A model that matches no entry still shows its token counts, but its amount is marked as unpriced and is **excluded from the total**.

## Peak/off-peak schedules

A `schedule` describes the peak window:

| Field | Meaning |
| --- | --- |
| `timezone` | IANA timezone name, for example `Asia/Shanghai`. The editor's dropdown is ordered by current UTC offset, ties broken by name with `UTC` first. |
| `peakDays` | Peak weekdays, `0` being Sunday. |
| `peakWindows` | Peak windows, half-open `["HH:MM", "HH:MM"]` intervals. |
| `holidays` | A holiday set name or an array of `YYYY-MM-DD` dates; those dates are **not peak**. |
| `workdays` | A make-up-workday set name or date array; those dates **are peak**. |

The decision order is: `holidays` first (a hit means off-peak, even on a peak weekday), then whether it is a peak day at all — a weekday in `peakDays`, or a date in `workdays` — and only then whether the time falls inside a `peakWindows` interval. When one date appears in both `holidays` and `workdays`, **the holiday wins**.

A set name points at the packaged [`data/cn-holidays.json`](../data/cn-holidays.json):

```json
{
  "version": 1,
  "sets": {
    "cn": {
      "name": "中国大陆法定节假日",
      "source": "https://www.gov.cn/zhengce/content/202511/content_7047090.htm",
      "updated": "2025-11-04",
      "holidays": ["2026-01-01", "2026-02-15", "..."],
      "workdays": ["2026-01-04", "2026-02-14", "..."]
    }
  }
}
```

The dates come from the State Council's annual holiday notice and **need updating every year**: a new year's notice usually lands in the previous November, and a year with no data falls back to the natural-weekday decision. Referencing a set that does not exist fails at load time — that is a configuration error, not missing data.

The built-in `deepseek` schedule references `cn`'s `holidays` but **not** its `workdays`: the official rule is "public holidays excluded", and **make-up workdays on weekends are priced as off-peak too**. To match the official rate, do not attach `workdays` to `deepseek`. `workdays` is a general switch for providers that do charge peak on make-up weekends; do not use it for the official rate.

The plugin ships one schedule named `deepseek` (Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00, public holidays excluded, and make-up workdays on weekends priced as off-peak). Define a schedule of the same name in the user file's `schedules` to override it, or add your own for entries to reference.

You can also edit that built-in rule directly in the UI: the built-in pricing entries reference the schedule **name** `deepseek` rather than an inlined copy of the rule, so your override applies to the built-in entries too — when the official peak windows change, one edit is enough. The built-in rule card has no delete button (it can always be overridden); custom rule cards do.
