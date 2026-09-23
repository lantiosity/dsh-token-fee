# 配置参考 / Configuration reference

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

价目表与峰谷规则的完整参考：三层合并、文件格式、匹配优先级，以及面板与设置页里那个编辑器具体怎么行为。

## 存储与优先级

价目表由三层合并而成，**后者覆盖前者**：

1. 插件内置层：只有 DeepSeek 官方路由 `deepseek-official` 的价格与峰谷规则；
2. 用户文件层：`<DSH_HOME>/token-fee.json`；
3. 插件配置层：cordis 配置中的 `pricing` / `schedules` 字段。

插件**不会**为其他供应商内置任何价格：同一模型经由中转商、聚合网关或自建代理调用时价格并不相同，用官方价冒充会得出错误的账单。其他供应商的价格请自行添加条目。

用户文件在每次读取端点被触达时按 mtime 缓存校验，因此手工编辑 `token-fee.json` 后无需重启即可生效。

## 插件配置（cordis.yml）

`cordis.yml` 里该条目的 `config` 接受四个键：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `displayCurrency` | `CNY` | 胶囊与合计使用的展示币种，必须是 ICU 认识的 ISO 4217 代码。 |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | 用户价目表路径；相对路径按 `DSH_HOME` 解析。 |
| `schedules` | 无 | 额外或覆盖内置的命名峰谷规则。 |
| `pricing` | 无 | 额外或覆盖其它层的价目条目。 |

配置在**装载期**校验：未知键、拼错的币种、结构不合法的条目都会让插件以 FAILED 结束，而不是被静默忽略——写错配置时应当立刻知道。跨字段规则（条目引用不存在的调度名）同样在装载期报错。

```yaml
- id: token-fee
  config:
    displayCurrency: USD
    pricingFile: my-prices.json
```

## 文件格式

```json
{
  "version": 1,
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

### 建议列表

`provider` 与 `model` 是自由输入框，同时带一份来自**当前 dsh 配置**的建议列表（`ctx.llm` 的已注册路由与模型）：`provider` 列出全部已配置路由，`model` 在 `provider` 匹配上之后收窄到该路由的模型，未匹配时列出全部模型。建议只是便利——adapter 允许接受未列出的模型 id，因此输入不受限。

### 数字草稿

单价在界面上以字符串草稿编辑，保存时才转成数字：`Number("1.")` 会得到 `1`，若在输入过程中就转换，小数点会被吞掉，用户根本敲不出小数。

无法解析或为负的输入在保存时**按 0 写入**并提示哪些字段被归零，而不是让整次保存失败——价格表是人工维护的，一个笔误不该连带其它条目的修改一起丢掉。输入框在敲错的那一刻就会标红，悬停有说明。若要让 host 直接拒绝，可手工编辑文件：端点校验是 fail-loud 的。

### 保存前的本地拦截

保存前客户端会拦下三种「界面点得出来、host 必然拒绝」的状态并给出本地化提示：删光所有条目、条目没填模型 id、勾了「区分峰谷」却没选规则。

### 引用往返

条目对命名调度（`schedules` 里的名字）的引用在编辑往返中原样保留：GET 端点同时返回归一化层与原始层，编辑器草稿用原始层，因此改一处规则仍然会传播到引用它的所有条目。

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

历史路由 id `deepseek` 会回退到 `deepseek-official`，已下线模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会回退到 `deepseek-flash`。

没有命中任何条目的模型，其 token 数照常展示，金额标记为「未配置价格」，**不计入合计**。

## 峰谷规则

`schedule` 描述高峰时段：

| 字段 | 含义 |
| --- | --- |
| `timezone` | IANA 时区名，例如 `Asia/Shanghai`。配置界面的下拉框按当前 UTC 偏移排序，同偏移内按名字排序且 `UTC` 居首。 |
| `peakDays` | 高峰星期，`0` 为周日。 |
| `peakWindows` | 高峰时段，`["HH:MM", "HH:MM"]` 的左闭右开区间。 |

插件内置一条名为 `deepseek` 的规则（北京时间周一至周五 09:00–12:00、14:00–18:00）。你可以在用户文件的 `schedules` 中定义同名规则来覆盖它，或新建自己的规则供条目引用。

在界面上直接改这条内置规则即可：内置价目条目引用的是**规则名** `deepseek` 而不是内联的一份规则副本，因此你的覆盖会同时作用到内置条目上——官方调整高峰时段时，改一处就够了。内置规则卡片没有删除键（它总能被覆盖），自定义规则卡片有。

<h2 id="english">English</h2>

The complete reference for the pricing table and peak/off-peak schedules: the three-layer merge, the file format, matching precedence, and exactly how the editor in the panel and the settings page behaves.

## Storage and precedence

The pricing table is merged from three layers, **each overriding the previous one**:

1. Built-in layer: only the DeepSeek official route `deepseek-official` with its peak/off-peak rules;
2. User file layer: `<DSH_HOME>/token-fee.json`;
3. Plugin config layer: the `pricing` / `schedules` fields of the cordis config.

The plugin deliberately ships **no** pricing for other providers: the same model costs different amounts through a reseller, an aggregator or a self-hosted proxy, and passing official prices off as theirs produces a wrong bill. Add your own entries for every other provider.

The user file is revalidated against its mtime whenever a read endpoint is touched, so editing `token-fee.json` by hand takes effect without a restart.

## Plugin config (cordis.yml)

The entry's `config` in `cordis.yml` accepts four keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `displayCurrency` | `CNY` | Display currency for the pill and the total; must be an ISO 4217 code ICU recognizes. |
| `pricingFile` | `<DSH_HOME>/token-fee.json` | Path to the user pricing table; a relative path resolves against `DSH_HOME`. |
| `schedules` | none | Extra or overriding named peak/off-peak schedules. |
| `pricing` | none | Extra or overriding pricing entries. |

Config is validated **at load time**: unknown keys, a misspelled currency and structurally invalid entries all make the plugin end up FAILED rather than being silently ignored — a misconfiguration should be noticed immediately. Cross-field rules (an entry referencing a schedule name that does not exist) fail at load time too.

```yaml
- id: token-fee
  config:
    displayCurrency: USD
    pricingFile: my-prices.json
```

## File format

```json
{
  "version": 1,
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

### Suggestions

`provider` and `model` are free-text fields with a suggestion list drawn from the **current dsh configuration** (`ctx.llm`'s registered routes and models): `provider` lists every configured route, and `model` narrows to the models of that route once `provider` matches, falling back to all models when it does not. Suggestions are a convenience only — adapters accept model ids that are not listed, so input stays unrestricted.

### Numeric drafts

Unit prices are edited as string drafts and converted to numbers only on save: `Number("1.")` yields `1`, so converting while typing would swallow the decimal point and make decimals impossible to enter.

Inputs that cannot be parsed, or that are negative, are **written as 0** on save with a note listing the corrected fields, instead of failing the whole save — the pricing table is maintained by hand, and one typo should not take every other edit down with it. The field turns red the moment the value is wrong, with an explanation on hover. To have the host reject such input outright, edit the file by hand: endpoint validation is fail-loud.

### Blocked before saving

Before saving, the client also blocks three states that the UI can construct but the host would necessarily reject, each with a localized message: deleting every entry, an entry with no model id, and an entry with peak/off-peak prices but no schedule selected.

### Reference round-trips

An entry's reference to a named schedule (a name in `schedules`) survives editing round-trips verbatim: the GET endpoint returns both the normalized and the raw layer, and the editor draft uses the raw one, so editing a rule still propagates to every entry referencing it.

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

The historical route id `deepseek` falls back to `deepseek-official`, and the retired model names `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` fall back to `deepseek-flash`.

A model that matches no entry still shows its token counts, but its amount is marked as unpriced and is **excluded from the total**.

## Peak/off-peak schedules

A `schedule` describes the peak window:

| Field | Meaning |
| --- | --- |
| `timezone` | IANA timezone name, for example `Asia/Shanghai`. The editor's dropdown is ordered by current UTC offset, ties broken by name with `UTC` first. |
| `peakDays` | Peak weekdays, `0` being Sunday. |
| `peakWindows` | Peak windows, half-open `["HH:MM", "HH:MM"]` intervals. |

The plugin ships one schedule named `deepseek` (Beijing time, Monday to Friday 09:00–12:00 and 14:00–18:00). Define a schedule of the same name in the user file's `schedules` to override it, or add your own for entries to reference.

You can also edit that built-in rule directly in the UI: the built-in pricing entries reference the schedule **name** `deepseek` rather than an inlined copy of the rule, so your override applies to the built-in entries too — when the official peak windows change, one edit is enough. The built-in rule card has no delete button (it can always be overridden); custom rule cards do.
