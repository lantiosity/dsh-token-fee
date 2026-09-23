# 文档 / Documentation

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

用户手册在仓库根的 [`README.md`](../README.md)（[English](../README.en.md)）；这里是维护者与进阶用户的参考。

| 文档 | 读它来了解 |
| --- | --- |
| [`configuration.md`](configuration.md) | 价目表与峰谷规则的完整参考：三层合并、文件格式与字段、匹配优先级，以及编辑器具体怎么行为 |
| [`internals.md`](internals.md) | 费用与时段算在哪里、怎么算：投影只携带 token 桶、时段归属与 `stateVersion` 指纹、端点防线、已知取舍 |
| [`dsh-integration.md`](dsh-integration.md) | 插件依赖的 DSH 未稳定接口：slot 契约、表面材质、设计 token、官方组件导出，以及 `0.1.5-rc.1` ~ `0.1.7-rc.1` 的兼容矩阵 |
| [`development.md`](development.md) | 本地命令、四个测试套件、代码结构 |
| [`release-notes/`](release-notes/) | 每个版本的发版说明（双语） |

本仓库的文档都是**双语同文件**：中文在前、英文在后，顶部有语言切换链接。这样两种语言不可能各写各的。

<h2 id="english">English</h2>

The user manual is the repository root's [`README.md`](../README.md) ([中文](../README.md)); this directory holds reference material for maintainers and advanced users.

| Document | Read it for |
| --- | --- |
| [`configuration.md`](configuration.md) | The complete reference for the pricing table and peak/off-peak schedules: the three-layer merge, file format and fields, matching precedence, and exactly how the editor behaves |
| [`internals.md`](internals.md) | Where and how the cost and period are computed: the projection carrying token buckets only, period attribution and the `stateVersion` fingerprint, endpoint defenses, known trade-offs |
| [`dsh-integration.md`](dsh-integration.md) | The pre-stable DSH interfaces this plugin rides on: slot contracts, surface material, design tokens, built-in component exports, and the `0.1.5-rc.1` ~ `0.1.7-rc.1` compatibility matrix |
| [`development.md`](development.md) | Local commands, the four test suites, code structure |
| [`release-notes/`](release-notes/) | Release notes per version (bilingual) |

Documentation here is **bilingual in one file**: Chinese first, English after, with a language switcher at the top. That way the two languages cannot drift apart.
