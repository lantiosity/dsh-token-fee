# dsh-token-fee

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端（`dsh web`）提供**会话实时花费**显示。

输入框下方会出现一枚费用胶囊：默认以人民币显示当前会话花费，精确到分（四舍五入）。点击后展开面板，按供应商与模型列出**缓存未命中、缓存命中、缓存写入、输出**四类 token 的数量与金额，并可就地编辑价目表。

> 面向 DSH `0.1.6-alpha.1` 开发与验证。

## 功能

| | 能力 |
| --- | --- |
| 💰 | 会话实时花费，精确到分，可切换展示币种 |
| 🧾 | 按供应商 / 模型分组的用量与费用明细 |
| 🏷️ | **按供应商区分价格**：同一个模型在不同供应商下可以有完全不同的单价 |
| 🕘 | **峰谷分时定价**：高峰 / 空闲两档单价，判定规则（时区、高峰星期、高峰时段）可自行设置 |
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
- **费用明细**：点击胶囊打开。顶部是合计金额，下面按供应商分组、按模型列出四个计费桶的 token 数与金额。区分峰谷的条目会标注「区分峰谷」。
- **价格设置**：面板内的第二个标签页，或在 dsh 设置中打开「Token 费用」页。

## 价格配置

### 存储与优先级

价目表由三层合并而成，**后者覆盖前者**：

1. 插件内置层：只有 DeepSeek 官方路由 `deepseek-official` 的价格与峰谷规则；
2. 用户文件层：`<DSH_HOME>/token-fee.json`；
3. 插件配置层：cordis 配置中的 `pricing` / `schedules` 字段。

插件**不会**为其他供应商内置任何价格：同一模型经由中转商、聚合网关或自建代理调用时价格并不相同，用官方价冒充会得出错误的账单。其他供应商的价格请自行添加条目。

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

### 匹配规则

条目按 `(provider, model)` 匹配，优先级从高到低：**精确 → provider 通配 → model 通配 → 全通配**；同一优先级内先出现的条目获胜。

历史路由 id `deepseek` 会回退到 `deepseek-official`，已下线模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 会回退到 `deepseek-flash`。

没有命中任何条目的模型，其 token 数照常展示，金额标记为「未配置价格」，**不计入合计**。

### 峰谷规则

`schedule` 描述高峰时段：

| 字段 | 含义 |
| --- | --- |
| `timezone` | IANA 时区名，例如 `Asia/Shanghai`。 |
| `peakDays` | 高峰星期，`0` 为周日。 |
| `peakWindows` | 高峰时段，`["HH:MM", "HH:MM"]` 的左闭右开区间。 |

插件内置一条名为 `deepseek` 的规则（北京时间周一至周五 09:00–12:00、14:00–18:00）。你可以在用户文件的 `schedules` 中定义同名规则来覆盖它，或新建自己的规则供条目引用。

## 内置价格

| 模型 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 高峰 | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | 空闲 | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | 高峰 | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |

单位均为「元 / 百万 token」，来源为 DeepSeek 官方定价页，仅适用于 `deepseek-official` 路由。

## 已知限制

- **胶囊独占一行**：`conversation.composer.dock` 的多个 occupant 各占一行是 dsh 的约定（ui-chat 的统计行也是靠 `data-composer-stats` 这个双向约定让输入框为它留出空间）。费用胶囊因此显示在内置「轮次 / 速度」与「token 用量」胶囊的下方。把两者并排需要改写 InputBar 根容器的布局并依赖其他插件的私有标记，官方一旦调整 dock 结构就会让输入区变形，因此插件不做这件事。
- **中国法定节假日**：官方的高峰判定不含法定节假日，本插件按自然工作日判定，因此法定节假日会被高估为高峰价。需要精确计费时，请为节假日单独调整规则或改用固定单价。
- **跨币种**：不同币种的金额不会换算合并。胶囊与合计只统计展示币种，其他币种在明细中单独提示。
- **金额在浏览器侧换算**：会话投影只携带 token 桶，因此修改价格立即生效、也不会让持久化的投影缓存失效；代价是同一份价目表在 host 与浏览器两侧各有一份匹配实现，二者由测试保持同构。
- **历史归属**：已记录用量的时段归属由事件时间决定并固化在投影里；修改峰谷规则只影响此后产生的用量。

## 开发

```bash
npm run check   # 语法检查
npm test        # 三个测试套件
```

| 套件 | 覆盖 |
| --- | --- |
| `scripts/test-pricing.mjs` | 价目表校验、匹配优先级、峰谷判定、费用换算 |
| `scripts/test-host.mjs` | `apply` 的注册行为、投影折叠（含替换与重试）、价目表文件读写 |
| `scripts/test-client.mjs` | 模块工厂装配、`apply` 的 slot 注册，以及用真实 React 渲染三个组件 |

`test-client.mjs` 会从 `<DSH_HOME>/profiles/node_modules` 解析真实 React；找不到时退回替身并跳过渲染用例。

代码结构：

| 文件 | 职责 |
| --- | --- |
| `lib/pricing.js` | 纯定价原语：内置表、命名调度、分层合并、条目匹配、费用换算 |
| `lib/index.js` | host 半：`tokenFee` 会话投影 + 价目表读写端点 |
| `lib/client.js` | 浏览器半：费用胶囊、明细面板、价格编辑器、设置页 |
| `cordis.patch.yml` | bundle 层 patch，挂载 host 半 |

## 许可

MIT
