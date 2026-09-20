[中文](#cn-v0.2.2) | [English](#en-v0.2.2)

<h3 id="cn-v0.2.2">问题修复</h3>

- 跟随 DSH `0.1.6-alpha.2` 的 composer dock 行布局：费用胶囊不再吃掉整行的剩余宽度，与内置统计胶囊、上下文表盘紧凑地居中成一行。此前胶囊会浮在中间，把内置统计胶囊与上下文表盘挤到两端。
- 计费模式、当前时段与剩余时间三段在宽度不够时会收缩并打省略号，而不是把胶囊撑出 composer。

<h3 id="en-v0.2.2">Bug fixes</h3>

- Follows the composer dock's single-row layout in DSH `0.1.6-alpha.2`: the cost pill no longer consumes the row's remaining width, and sits packed and centered with the built-in stats pills and the context meter. It used to float in the middle and push both of them to the edges.
- The billing mode, current period and time left now shrink with an ellipsis when space runs short, instead of pushing the pill out of the composer.
