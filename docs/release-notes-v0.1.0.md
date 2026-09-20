[中文](#cn-v0.1.0) | [English](#en-v0.1.0)

<h3 id="cn-v0.1.0">新增功能</h3>

- 会话实时花费胶囊：输入框下方显示当前会话花费，精确到分（四舍五入），展示币种可配置。
- 费用明细面板：点击胶囊展开，按供应商分组、按模型列出缓存未命中 / 缓存命中 / 缓存写入 / 输出的 token 数量与金额。
- 按供应商区分价格：同一模型在不同供应商下可以有完全不同的单价；内置价目只覆盖 DeepSeek 官方路由 `deepseek-official`，其他供应商由用户自行添加。
- 峰谷分时定价：高峰 / 空闲两档单价，判定规则（时区、高峰星期、高峰时段）命名化后可自由设置并供多条价目复用。
- 价格配置面板：既在 dsh 设置中有独立页面，也能从费用面板直接打开；单价以表格呈现，与内置条目同构。
- 价目表即文件：存放在 `<DSH_HOME>/token-fee.json`，手工编辑后即时生效，无需重启。
- 界面中英双语。

<h3 id="en-v0.1.0">New Features</h3>

- Session cost pill: shows the current session's cost under the composer, rounded to the cent, with a configurable display currency.
- Cost breakdown panel: opens on click and lists cache-miss, cache-hit, cache-write and output token counts and amounts, grouped by provider and model.
- Per-provider pricing: the same model can carry a different unit price under each provider; built-in pricing covers only DeepSeek's official route `deepseek-official`, and every other provider is configured by the user.
- Peak/off-peak pricing: separate unit prices for peak and off-peak hours, with named schedules (timezone, peak weekdays, peak windows) that can be edited and shared across entries.
- Pricing editor: a dedicated page in dsh settings, also reachable from the cost panel, presenting unit prices in the same table layout as the built-in entries.
- Pricing as a file: stored at `<DSH_HOME>/token-fee.json`, editable by hand and applied immediately without a restart.
- Bilingual UI (Chinese and English).
