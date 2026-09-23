# dsh-token-fee

[![CI](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml/badge.svg)](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端（`dsh web`）提供**会话实时花费**显示。

输入框下方会出现一枚费用胶囊：默认以人民币显示当前会话花费，精确到分（四舍五入）。点击后展开面板，按供应商与模型列出**缓存未命中、缓存命中、缓存写入、输出**四类 token 的数量与金额，并可就地编辑价目表。

> 面向 DSH `0.1.7-rc.1` 开发与验证，兼容 `0.1.5-rc.1` 起的所有版本（`0.1.6-alpha.1` 上胶囊与统计胶囊上下排列）。

## 功能

| | 能力 |
| --- | --- |
| 💰 | 会话实时花费，精确到分，可切换展示币种 |
| 🧾 | 按供应商 / 模型分组的用量与费用明细 |
| 🏷️ | **按供应商区分价格**：同一个模型在不同供应商下可以有完全不同的单价 |
| 🕘 | **峰谷分时定价**：高峰 / 空闲两档单价，判定规则（时区、高峰星期、高峰时段）可自行设置；胶囊上实时显示当前时段与到下一次切换的剩余时间 |
| ⚙️ | 价格配置面板：既在 dsh 设置中有独立页面，也能从费用面板直接打开 |
| 📄 | 价目表落在 `<DSH_HOME>/token-fee.json`，手工编辑后即时生效，无需重启 |
| 🌐 | 界面中英双语 |

## 安装

标准安装路径（需要 `pnpm`）：

```bash
# 从 GitHub 安装
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"

# 或从本地检出安装（把路径换成本仓库所在目录）
dsh plugin --profile web add "/path/to/dsh-token-fee"
```

本包声明了 `dsh.bundle.patch`，dsh 会把它并入 profile 的 bundle 层，因此**不需要**手工编辑 profile 的 `cordis.patch.yml`。

无法使用 `dsh plugin` 时，可用备选安装器：

```bash
node scripts/install.mjs            # 复制文件并幂等写入 profile patch
node scripts/install.mjs --dry-run  # 只打印将写入的路径
node scripts/install.mjs --check    # 校验既有安装
```

两条路径只需其一。安装后**重启 `dsh web`，再硬刷新浏览器**。

## 使用

- **费用胶囊**：位于输入框下方，与内置的「轮次 / 速度」和「token 用量」胶囊并排。默认显示 `¥0.12` 这样的金额；会话中还有未配置价格的模型时，会额外标注未定价数量。
- **计费模式**：金额后面跟着当前正在使用的模型的计费模式。只有单一单价时显示 `· 计费模式：统一`；配置了空闲价时显示 `· 计费模式：峰谷 · 当前时段：高峰 · 剩余时间：01:22:32`，其中剩余时间每秒刷新，倒数到下一次时段切换。模式取自投影里最近一次请求的路由，因此切换模型后立刻跟着变。
- **费用明细**：点击胶囊打开。顶部是合计金额，下面按供应商分组、按模型列出四个计费桶的 token 数与金额。区分峰谷的条目会标注「区分峰谷」。
- **价格设置**：面板内的第二个标签页，或在 dsh 设置中打开「Token 费用」页。

## 价格配置

### 存储与优先级

价目表由三层合并而成，**后者覆盖前者**：

1. 插件内置层：只有 DeepSeek 官方路由 `deepseek-official` 的价格与峰谷规则；
2. 用户文件层：`<DSH_HOME>/token-fee.json`；
3. 插件配置层：cordis 配置中的 `pricing` / `schedules` 字段。

插件**不会**为其他供应商内置任何价格：同一模型经由中转商、聚合网关或自建代理调用时价格并不相同，用官方价冒充会得出错误的账单。其他供应商的价格请自行添加条目。

### 插件配置（cordis.yml）

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

### 文件格式

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
| `provider` | 路由 provider id，例如 `deepseek-official` 或你自己的中转商 id。`*` 表示通配。 |
| `model` | 模型 id，例如 `deepseek-flash`。`*` 表示通配。 |
| `currency` | 三位货币代码，决定金额的展示币种。 |
| `schedule` | 引用 `schedules` 中的名字，或直接内联一份规则，或 `null` 表示不分峰谷。 |
| `prices.peak` | 高峰（或唯一）单价，单位是**每百万 token**。 |
| `prices.offPeak` | 空闲单价；出现时必须配 `schedule`。 |
| `cacheWrite` | 未提供时按 0 处理。 |

配置界面里 `provider` 与 `model` 是自由输入框，同时带一份来自**当前 dsh 配置**的建议列表（`ctx.llm` 的已注册路由与模型）：`provider` 列出全部已配置路由，`model` 在 `provider` 匹配上之后收窄到该路由的模型，未匹配时列出全部模型。建议只是便利——adapter 允许接受未列出的模型 id，因此输入不受限。

单价在界面上以字符串草稿编辑，保存时才转成数字：`Number("1.")` 会得到 `1`，若在输入过程中就转换，小数点会被吞掉，用户根本敲不出小数。

无法解析或为负的输入在保存时**按 0 写入**并提示哪些字段被归零，而不是让整次保存失败——价格表是人工维护的，一个笔误不该连带其它条目的修改一起丢掉。输入框在敲错的那一刻就会标红，悬停有说明。若要让 host 直接拒绝，可手工编辑文件：端点校验是 fail-loud 的。

保存前客户端还会拦下三种「界面点得出来、host 必然拒绝」的状态并给出本地化提示：删光所有条目、条目没填模型 id、勾了「区分峰谷」却没选规则。

条目对命名调度（`schedules` 里的名字）的引用在编辑往返中原样保留：GET 端点同时返回归一化层与原始层，编辑器草稿用原始层，因此改一处规则仍然会传播到引用它的所有条目。

条目表单里的「峰谷规则」下拉框始终可用：选中一个规则就等于开启峰谷（空闲价以高峰价为初值，你只需改需要改的那一档），选回「统一单价」则清掉空闲价与引用。规则区里新增的规则**不要求先被条目引用**——「先建规则、再挂到条目上」是正常的操作顺序，未被引用的规则会照常写进文件，删除只由规则卡片上的 ✕ 触发。

规则卡片与条目卡片同构：默认收敛成「名字 + 一行摘要（时区 · 高峰星期 · 高峰时段）+ 编辑键」，点「编辑」展开，改完点「完成」收起。自定义规则的名字就在展开后的标题位置直接改，失焦或回车提交；改名会同步所有引用它的条目，重名或空名会就地标红并退回原名。

名字在内置表里的规则永远是「内置规则」：不能改名、没有删除键，即使已经被你覆盖（此时标记为「内置规则 · 已覆盖」并多出一个「恢复内置」键）。这是刻意的——内置条目按名字引用 `deepseek`，允许把这条覆盖改名，内置条目会悄悄退回出厂规则，而你只以为自己改了个名字。

删掉一条仍被引用的规则时，条目的引用会被清空但空闲价保留，保存前会提示重新选一条规则；连带删掉用户填好的价格比让他重选一次更伤人。

### 匹配规则

条目按 `(provider, model)` 匹配，优先级从高到低：**精确 → provider 通配 → model 通配 → 全通配**；同一优先级内先出现的条目获胜。

历史路由 id `deepseek` 会回退到 `deepseek-official`，已下线模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会回退到 `deepseek-flash`。

没有命中任何条目的模型，其 token 数照常展示，金额标记为「未配置价格」，**不计入合计**。

### 峰谷规则

`schedule` 描述高峰时段：

| 字段 | 含义 |
| --- | --- |
| `timezone` | IANA 时区名，例如 `Asia/Shanghai`。配置界面的下拉框按当前 UTC 偏移排序，同偏移内按名字排序且 `UTC` 居首。 |
| `peakDays` | 高峰星期，`0` 为周日。 |
| `peakWindows` | 高峰时段，`["HH:MM", "HH:MM"]` 的左闭右开区间。 |

配置界面里高峰时段按时、分两个窄输入框填写，只收数字：超过范围的两位输入（`25` 时、`61` 分）只保留后一位，所以非法时刻根本敲不出来；未补零的中间态（`9:5`）在保存时补齐为 `09:05`。结束不晚于开始的行会就地标红，并在保存前被拦下。

插件内置一条名为 `deepseek` 的规则（北京时间周一至周五 09:00–12:00、14:00–18:00）。你可以在用户文件的 `schedules` 中定义同名规则来覆盖它，或新建自己的规则供条目引用。

在界面上直接改这条内置规则即可：内置价目条目引用的是**规则名** `deepseek` 而不是内联的一份规则副本，因此你的覆盖会同时作用到内置条目上——官方调整高峰时段时，改一处就够了。内置规则卡片没有删除键（它总能被覆盖），自定义规则卡片有。

## 内置价格

| 模型 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 高峰 | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | 空闲 | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | 高峰 | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |

单位均为「元 / 百万 token」，来源为 DeepSeek 官方定价页，仅适用于 `deepseek-official` 路由。

## 已知限制

- **胶囊与官方统计胶囊同处一行**：0.1.6-alpha.2 起 `conversation.composer.dock` 是一行 flex（`.dock`），slot 的每个 occupant 都是它的直接子项，间距、居中与上边距由 dock 统一负责。本插件因此只把自己的根节点写成与官方 `StatsPills.root` 同规格的收缩节点（不写宽度与内距），绝不改写 InputBar 的布局——把并排改成上下、或反过来，都属于改写承载其他 occupant 的父容器，官方调整结构时会让输入区变形，那是破坏性失败而不只是降级。
- **半透明菜单表面都跟随官方的毛玻璃材质**：`--dsw-specific-menu` 在 0.1.7-alpha.1 起从不透明的 `var(--dsw-alias-bg-layer-3)` 变成了半透明（深色 0.5 / 浅色 0.58）。官方契约是「绘制该底色的高层级表面**同时**应用 `backdrop-filter: var(--dsw-menu-backdrop-filter)`」（`blur(40px) saturate(150%)`）——只画底色不加模糊，表面就是一层能看穿页面的玻璃。面板与吸顶的保存条（内容会从它下面滚过）都按这条配对。0.1.6-alpha.2 及更早没有这个变量，声明在计算值阶段失效、`backdrop-filter` 回到 `none`，正好是那边需要的降级（底色本就不透明），因此不需要版本判断；`test-client.mjs` 对**所有**绘制该底色的规则断言这组配对。
- **设计 token 逐个核对过**：插件引用的每个 `--dsw-*` 都在 DSH 的 `ui-theme`/`ui-primitives` 里确认存在。引用不存在的自定义属性会让**整条声明**在计算值阶段失效：曾用的 `--dsw-alias-fill-l1`/`-l2`、`--dsw-alias-separator-primary` 在 DSH 里从未定义，`--dsw-alias-state-warning-primary` 则是 `--dsw-alias-state-warn-primary` 的笔误，结果是选中态底色、徽章底色、分隔符颜色全部静默丢失。`test-client.mjs` 里冻结了这份白名单。
- **官方图标按名字可用性取用**：`ui-primitives` 的图标命名换过一次口径——0.1.5-rc.1 至 0.1.6-alpha.2 把尺寸写进名字（`IconDatabaseOutline16`），0.1.7-alpha.1 起改成写字重（`IconDatabaseOutlineRegular`/`Medium`）。插件两套名字都试（先取与旧命名观感一致的 `Regular` 档），都取不到时降级为不画图标。**缺图标不能连累胶囊**：把 `undefined` 当组件交给 React 会抛「Element type is invalid」，那会炸掉整个 occupant，整枚胶囊连同面板一起消失——而实际缺的只是一个装饰性图标。这条是按可用性回退而不是按版本分支，因为插件在浏览器侧拿不到 DSH 版本号。
- **价目表端点只接受回环来源**：读写端点要求 peer socket 是回环且 `Host` 头是回环或 `localhost`。经 Tailscale 等**远程地址**访问 GUI 时端点返回 403，费用面板会显示「未配置价格」并在设置页给出失败原因。这是 CSRF 与 DNS-rebinding 防线的一部分：放宽判据需要复用 connection 插件的信任判定，而该判定位于客户端包内，link 安装的插件解析不到它，重写一份又会重复安全关键逻辑。经远程地址使用时，请直接编辑 `<DSH_HOME>/token-fee.json`。
- **中国法定节假日**：官方的高峰判定不含法定节假日，本插件按自然工作日判定，因此法定节假日会被高估为高峰价。需要精确计费时，请为节假日单独调整规则或改用固定单价。
- **跨币种**：不同币种的金额不会换算合并。胶囊与合计只统计展示币种，其他币种在明细中单独提示。
- **金额在浏览器侧换算**：会话投影只携带 token 桶，因此修改价格立即生效、也不会让持久化的投影缓存失效。时段分桶是唯一被烘进投影状态的派生数据，它靠 `stateVersion` 里的表指纹触发重折（见上一条）。代价是 host 与浏览器各有一份换算实现（浏览器侧无法 import host 模块），峰谷判定与倒计时同样如此——`test-client.mjs` 里有数组断言把两侧的费用与时段结果钉在一起，避免它们悄悄漂移。
- **历史归属**：一个样本属于哪个时段是在**折叠时**按当时的价目表定下的，并写进投影状态。投影状态是持久化检查点，所以插件把有效价目表的内容指纹并进了投影的 `stateVersion`：**改价格、改规则、增删条目都会让检查点失效，整段日志按新表重折一遍**，历史因此跟着新规则走，而不是冻结在当初那次判定上。折叠时还没有可用两档价格的样本（条目尚未配置、或只有统一单价）记为 `flat`（不分峰谷），明细面板会单独标出「未记录时段」的用量，不会默默按高峰价冒充。
- **时段标签不写死成高峰**：兜底值曾是 `peak`，于是「还没配置价格」和「只填了统一单价」这两段用量都会被计成高峰，而标签一旦写进检查点就冻结——这正是「高峰用量比规则算出来的多出十几个百分点」的来源。
- **倒计时的小时不进位到天**：跨周末的长间隔按总小时数显示（例如 `63:00:00`），比「2 天 15 小时」更直接地回答「还剩多久」。
- **配置 schema 是手写的 Standard Schema**：契约要求插件导出 `Config`，而 cordis 只调用 `Config['~standard'].validate`（`vendor/cordis/src/fiber.ts`）。这里没有 `import '@deepseek-ai/schemastery'`，因为本插件以 link 方式安装，Node 从插件真实路径逐级向上找 `node_modules`，够不到 `$DSH_HOME/profiles/node_modules`（实测 `ERR_MODULE_NOT_FOUND`），引入该包会让插件装载失败。手写的校验器同样在装载期报错、填默认值并拒绝未知键。

## 开发

```bash
npm run check         # 语法检查
npm test              # 三个离线套件
npm run test:process  # 进程级回归：用 --patch overlay 装进真实 dsh web 并探测端点
```

| 套件 | 覆盖 |
| --- | --- |
| `scripts/test-pricing.mjs` | 价目表校验、匹配优先级、峰谷判定、时段切换倒计时、费用换算 |
| `scripts/test-host.mjs` | `apply` 的注册行为、投影折叠（含替换与重试）、价目表文件读写、端点鉴权与 Promise 归属 |
| `scripts/test-client.mjs` | 模块工厂装配、`apply` 的 slot 注册、真实 React 渲染（含胶囊上的计费模式），以及 host / 浏览器两侧费用与时段判定的一致性 |
| `scripts/test-process.mjs` | 经 `--patch` overlay 装进真实 `dsh web`：端点契约、异常路径，以及**端点出错后进程仍然存活** |

`test-client.mjs` 会从 `<DSH_HOME>/profiles/node_modules` 解析真实 React；找不到时退回替身并跳过渲染用例。`test-process.mjs` 需要 `dsh` 在 PATH 上，否则整体跳过（退出码 0），因此可安全地在无 dsh 的环境里运行。

代码结构：

| 文件 | 职责 |
| --- | --- |
| `lib/pricing.js` | 纯定价原语：内置表、命名调度、分层合并、条目匹配、时段判定与倒计时、费用换算 |
| `lib/index.js` | host 半：`tokenFee` 会话投影 + 价目表读写端点 |
| `lib/client.js` | 浏览器半：费用胶囊（含计费模式与倒计时）、明细面板、价格编辑器、设置页 |
| `cordis.patch.yml` | bundle 层 patch，挂载 host 半 |
