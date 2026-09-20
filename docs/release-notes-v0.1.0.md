# dsh-token-fee v0.1.0

首个发布版本。为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页端（`dsh web`）提供**会话实时花费**显示，面向 DSH `0.1.6-alpha.1` 开发与验证。

## 功能

- **费用胶囊**：输入框下方显示当前会话花费，精确到分（四舍五入），币种可配置（默认人民币）
- **费用明细**：点击展开，按供应商分组、按模型列出缓存未命中 / 缓存命中 / 缓存写入 / 输出的 token 数与金额
- **按供应商区分价格**：同一模型在不同供应商下可以有完全不同的单价；插件只为 DeepSeek 官方路由 `deepseek-official` 内置价格，其他供应商由你自行添加，不用官方价冒充
- **峰谷分时定价**：高峰 / 空闲两档单价，判定规则（时区、高峰星期、高峰时段）命名化后可自由设置与复用
- **价格配置面板**：dsh 设置中有独立页面，也能从费用面板直接打开；单价表格与内置条目同构
- **价目表即文件**：`<DSH_HOME>/token-fee.json`，手工编辑后即时生效，无需重启
- 界面中英双语

## 安装

```bash
dsh plugin --profile web add "github:lantiosity/dsh-token-fee"
```

本包声明了 `dsh.bundle.patch`，dsh 会把它并入 profile 的 bundle 层，无需手工编辑 `cordis.patch.yml`。安装后**重启 `dsh web`，再硬刷新浏览器**。

无法使用 `dsh plugin` 时，可用仓库内的备选安装器 `node scripts/install.mjs`。

## 设计要点

- 金额在浏览器侧换算，会话投影只携带 token 桶 —— 改价格立即生效，且不会让持久化的投影缓存失效
- 价目表三层合并：内置 → 用户文件 → 插件配置，后者覆盖前者
- 时段归属由事件时间在 host 侧判定并固化在投影里，改规则只影响此后用量
- 条目对命名调度的引用在编辑往返中原样保留（GET 同时返回归一化层与原始层）

## 验证

| 套件 | 用例 |
|---|---|
| `test-pricing` | 30 |
| `test-host` | 28 |
| `test-client` | 42 |
| `test-process`（真实 `dsh web` 装载） | 8 |

`npm run verify` 覆盖全部四个套件。CI 在 Node 22.19 / 24 上运行，并单独核对发布载荷闭合。

## 已知限制

- **胶囊独占一行**：`conversation.composer.dock` 的多个 occupant 各占一行是 dsh 的约定，费用胶囊因此显示在内置「轮次 / 速度」与「token 用量」胶囊下方
- **价目表端点只接受回环来源**：经 Tailscale 等远程地址访问 GUI 时端点返回 403，费用面板显示「未配置价格」；此时请直接编辑 `<DSH_HOME>/token-fee.json`
- **中国法定节假日**：官方高峰判定不含法定节假日，本插件按自然工作日判定，节假日会被高估为高峰价
- **跨币种**：不同币种的金额不会换算合并
- **配置 schema 是手写的 Standard Schema**：插件以 link 方式安装时解析不到 `@deepseek-ai/schemastery`，因此手写符合 Standard Schema 的校验器（装载期报错、填默认值、拒绝未知键）

详见 [README](https://github.com/lantiosity/dsh-token-fee#readme)。
