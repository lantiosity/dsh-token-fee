[中文](#cn-v0.2.0) | [English](#en-v0.2.0)

<h3 id="cn-v0.2.0">新增功能</h3>

- 胶囊显示计费模式：费用金额后面标出当前正在使用的模型的计费方式——只有单一单价时显示 `计费模式：统一`。
- 峰谷倒计时：区分峰谷的条目额外显示 `当前时段：高峰 / 空闲` 与 `剩余时间：hh:mm:ss`，每秒刷新，倒数到下一次时段切换。
- 计费模式跟随当前路由，切换模型后立刻跟着变；当前模型没有匹配到价目条目时不显示这一段。

<h3 id="en-v0.2.0">New Features</h3>

- Billing mode on the pill: after the amount, the pill now reports how the model in use is billed — `Billing: flat` when it has a single unit price.
- Peak/off-peak countdown: an entry with off-peak prices also shows `Period: peak / off-peak` and `Left: hh:mm:ss`, ticking every second down to the next period change.
- The billing mode follows the current route, so it changes as soon as you switch models; it is omitted when the model in use matches no pricing entry.
