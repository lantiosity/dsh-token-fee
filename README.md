# dsh-token-fee

[![CI](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml/badge.svg)](https://github.com/lantiosity/dsh-token-fee/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) | 中文 | [文档](docs/README.md)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端（`dsh web`）提供**会话实时花费**显示。

输入框下方会出现一枚费用胶囊：默认以人民币显示当前会话花费，精确到分（四舍五入）。点击后展开面板，按供应商与模型列出**缓存未命中、缓存命中、缓存写入、输出**四类 token 的数量与金额，并可就地编辑价目表。

> 面向 DSH `0.1.7-rc.1` 开发与验证，兼容 `0.1.5-rc.1` 起的所有版本（`0.1.6-alpha.1` 上胶囊与统计胶囊上下排列）。兼容性核对见 [`docs/dsh-integration.md`](docs/dsh-integration.md)。

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

三条路径任选其一。装完都**重启 `dsh web`，再硬刷新浏览器**。

### 插件管理器（DSH `0.1.6-alpha.2` 起）

侧栏 → **插件** → **添加插件**，在「包名或地址」里填下面任一种：

| 形式 | 填什么 |
| --- | --- |
| npm 包名 | `@lantiosity/dsh-token-fee` |
| GitHub 简写 | `github:lantiosity/dsh-token-fee` |
| 仓库地址 | `https://github.com/lantiosity/dsh-token-fee` |
| 本地检出 | 本仓库目录的绝对路径 |

点**安装**：Host 会先读出这个 spec 指向什么，确认是带 `dsh.bundle.patch` 的插件后才开始装；装完点**立即启用**，插件即被启用，列表也会滚动到它。

- 安装源默认是 pnpm 自身的注册表，中国大陆可切到 npmmirror。**包名**走的就是所选注册表，镜像可用；**仓库地址**则不然——镜像只提供注册表里的包与依赖，不代理 GitHub 仓库本身，所以那条路走的仍是 GitHub 直连，GitHub 不通时换镜像没有帮助。
- 安装成功不代表模块一定能激活。若重启后没有出现费用胶囊，请看 dsh 的启动日志。

### 命令行

```bash
# 从 npm 安装
dsh plugin --profile web add "@lantiosity/dsh-token-fee"

# 从 GitHub 安装
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"

# 或从本地检出安装（把路径换成本仓库所在目录）
dsh plugin --profile web add "/path/to/dsh-token-fee"
```

### 备选安装器

无法使用 `dsh plugin` 时：

```bash
node scripts/install.mjs            # 复制文件并幂等写入 profile patch
node scripts/install.mjs --dry-run  # 只打印将写入的路径
node scripts/install.mjs --check    # 校验既有安装
```

三条路径都会把 host 半并入 profile 的 bundle 层——本包声明了 `dsh.bundle.patch`，因此**不需要**手工编辑 profile 的 `cordis.patch.yml`。

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

配置在**装载期**校验：未知键、拼错的币种、结构不合法的条目都会让插件以 FAILED 结束，而不是被静默忽略——写错配置时应当立刻知道。

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

没有命中任何条目的模型，其 token 数照常展示，金额标记为「未配置价格」，**不计入合计**。

### 峰谷规则

`schedule` 描述高峰时段：

| 字段 | 含义 |
| --- | --- |
| `timezone` | IANA 时区名，例如 `Asia/Shanghai`。 |
| `peakDays` | 高峰星期，`0` 为周日。 |
| `peakWindows` | 高峰时段，`["HH:MM", "HH:MM"]` 的左闭右开区间。 |

插件内置一条名为 `deepseek` 的规则（北京时间周一至周五 09:00–12:00、14:00–18:00）。你可以在用户文件的 `schedules` 中定义同名规则来覆盖它，或新建自己的规则供条目引用——内置价目条目引用的是**规则名**而不是内联副本，因此覆盖会同时作用到内置条目上。

> 编辑器行为（建议列表、数字草稿与归零、保存前的本地拦截、规则卡片与改名、高峰时段的时/分输入框等）见 [`docs/configuration.md`](docs/configuration.md)。

## 内置价格

| 模型 | 时段 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| `deepseek-flash` | 高峰 | ¥0.04 | ¥2 | ¥8 |
| `deepseek-flash` | 空闲 | ¥0.02 | ¥1 | ¥4 |
| `deepseek-v4-pro` | 高峰 | ¥0.30 | ¥9 | ¥27 |
| `deepseek-v4-pro` | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |

单位均为「元 / 百万 token」，来源为 DeepSeek 官方定价页，仅适用于 `deepseek-official` 路由。

## 已知限制

- **远程访问时端点不可用**：价目表端点只接受回环来源。经 Tailscale 等远程地址访问 GUI 时读写端点返回 403，面板显示「未配置价格」。此时请直接编辑 `<DSH_HOME>/token-fee.json`。
- **中国法定节假日**：官方的高峰判定不含法定节假日，本插件按自然工作日判定，因此法定节假日会被高估为高峰价。需要精确计费时，请为节假日单独调整规则或改用固定单价。
- **跨币种**：不同币种的金额不会换算合并。胶囊与合计只统计展示币种，其他币种在明细中单独提示。
- **倒计时的小时不进位到天**：跨周末的长间隔按总小时数显示（例如 `63:00:00`）。

> 这些限制的成因与设计取舍见 [`docs/internals.md`](docs/internals.md)。

## 开发

```bash
npm run check         # 语法检查
npm test              # 三个离线套件
npm run test:process  # 进程级回归：用 --patch overlay 装进真实 dsh web 并探测端点
npm run verify        # 上面三个依次跑（CI 用的就是它）
```

本仓库无构建步骤，`lib/*.js` 就是发布的产物。测试套件、代码结构与文档索引见 [`docs/development.md`](docs/development.md)。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
