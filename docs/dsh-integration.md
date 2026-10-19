# DSH 集成约束 / DSH integration constraints

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

本插件是第三方 bundle，靠 DSH 的**未稳定公共接口**工作（slot 契约、设计 token、官方组件导出、投影注册）。这里记下它依赖了什么、为什么这么写，以及跨版本核对的结果——这些是维护者约束，不是用户操作说明。

## 版本兼容

核对范围是 `dsh-v0.1.5-rc.1` 到 `dsh-v0.1.7-rc.1` 之间的 8 个 tag（`0.1.5-rc.1/rc.2/rc.3`、`0.1.6-alpha.1/alpha.2`、`0.1.7-alpha.1/alpha.2/rc.1`），并在 **`dsh-v0.1.7-rc.2`、`dsh-v0.2.0-rc.1`、`dsh-v0.2.0-rc.2`**，以及 0.2.1 线上的 **`alpha.1`–`alpha.5`、`rc.1`、`rc.2`** 上对同一组契约面做了复核对（0.2.1 线共 7 个 tag）。上游从 `0.1.6-alpha.2` 到 `0.2.1-rc.2` 之间改动很大（`0.1.7-rc.1`→`0.2.0-rc.2` 就有 794 个提交、1155 个文件），但**本插件依赖的表面全部没有变**：图标导出名、`conversation.composer.dock` 的 `{ kind: 'list', scope: 'session' }`、`Menu`/`Button` 的导出与 props、`--dsw-alias-*`/`--dsw-specific-menu`/`--dsw-menu-backdrop-filter` 这些设计 token、`useProjection` 标准座位、以及 host 侧的 `sessionProjections.register`、`ctx.inject`、`ctx.get('llm')`、`ctx.webServer.register`、`ctx.locale.register`、`settings.section` 与 `ctx.slots.inject`——逐一在每个 tag 上确认存在，`Menu`/`Button` 的 props 接口还与 `0.1.7-rc.1` 逐字一致。`package.json` 里 `dsh.client.inject` 声明的 6 个宿主包在 0.2.1-rc.2 上也全部还在。

0.2.1 线带来两条**新的版本边界，但都是视觉层面的**（见下表）：官方统计胶囊拆成两条 dock 条目、胶囊圆角由全圆角改为 `--dsw-radius-sm`。**没有任何一条会打断插件**——胶囊仍照旧独立占一条 dock 条目，dock 的行布局也没变。

**全程稳定的契约面**（8 个 tag 逐个核对）：

| 契约面 | 结果 |
| --- | --- |
| `conversation.composer.dock` | 一直是 `{ kind: 'list', scope: 'session' }`，由 `ui-conversation` 声明 |
| `useProjection` 标准座位 | 一直在会话作用域的标准 props 里 |
| `locale.register(ns, dicts)` / `locale.bind(ns)` | 一直在 |
| `Menu` / `Button` 导出与 props | 一直在（`Menu` 的 `items`/`footer`/`selectedId`/`portal`/`getAnchorRect` 等未变） |
| `--dsw-elevation-prominent`、`--dsw-elevation-stroke-color` | 一直有定义 |

**一共四条版本边界**，两处按可用性回退或按规范降级，两处是纯视觉变化且其中之一有意不跟随（下述）——**全程不做版本分支**，因为浏览器侧拿不到 DSH 版本号：

| 边界 | 变化 | 本插件的应对 |
| --- | --- | --- |
| `0.1.6-alpha.2` | `conversation.composer.dock` 从纵向容器变成一行 flex（`.dock`） | 根节点只做与官方 `StatsPills.root` 同规格的收缩节点，不写宽度与内距（v0.2.2） |
| `0.1.7-alpha.1` | 图标改名；`--dsw-specific-menu` 由不透明变半透明 | 图标按名字可用性回退；菜单表面配对毛玻璃，吸顶控件改用不透明底色 |
| `0.2.1-alpha.1` | 官方统计胶囊由「一条 dock 条目里放两枚」拆成**每条目一枚**（`activity` / `usage`，带 `data-composer-stat`） | **无需改动**：插件本来就自占一条条目。`.dock` 容器（`display:flex;justify-content:center;gap:12px`）继续负责行布局，与旧 `.root` 同规格，条目间距仍是 12px；`.tf_root` 上那套收缩节点配方因此变成冗余但无害——不能删，`0.2.0-rc.2` 及更早还需要它 |
| `0.2.1-alpha.3` | 官方胶囊圆角由 `999px` + `corner-shape: round` 改为 `var(--dsw-radius-sm)`（`8px`） | **有意不跟随**：`--dsw-radius-sm` 在 0.2.0-rc.2 就已存在（两版都是 8px），拿它当版本标记做分支不成立；而 `latest` 仍是 0.2.0-rc.2（官方全圆角），此时改成 8px 反而与同排的官方胶囊不一致。插件保持 `24px`（≈ 全圆角，与 ≤0.2.0 的官方一致）。等 0.2.1 成为 `latest` 时改一行即可 |

## Slot 与布局

**胶囊与官方统计胶囊同处一行**：0.1.6-alpha.2 起 `conversation.composer.dock` 是一行 flex（`.dock`），slot 的每个 occupant 都是它的直接子项，间距、居中与上边距由 dock 统一负责。本插件因此只把自己的根节点写成与官方 `StatsPills.root` 同规格的收缩节点（不写宽度与内距），绝不改写 InputBar 的布局——把并排改成上下、或反过来，都属于改写承载其他 occupant 的父容器，官方调整结构时会让输入区变形，那是破坏性失败而不只是降级。

0.2.1-alpha.1 起官方把统计胶囊拆成每条目一枚，`.root` 那层行包装随之消失、行布局完全交给 `.dock`（`justify-content:center;gap:12px`，与旧 `.root` 同规格），因此本插件根节点上那套配方**变成冗余但无害**：它是单子项的收缩盒，自身的 `justify-content` 不产生效果，条目间距仍由 dock 的 12px 决定。**不删**——`0.2.0-rc.2` 及更早的官方 `.root` 还在，那套配方在那边仍是必需的。

**胶囊内部的分隔符与官方同规格**：官方 `StatsPills` 把 `·` 放在 `.label` **内部**（同一个 flex 子项），所以两段之间只吃 `.sep` 自己的 `margin:0 6px`；把分隔符做成胶囊的直接子项，两侧会各多付一次 `gap:6px`，同一个点从约 15px 撑到约 27px。本插件因此把金额与各段收进一个 `.tf_text` 分组，分隔符只做它的子项。字色也照抄官方的**结果**：官方 `.sep` 指向 `--dsw-alias-separator-primary`，而该 token 在 DSH 里从未定义，声明在计算值阶段失效后 `color` 继承胶囊自身（静止 `label-tertiary`、悬停 `label-secondary`）——所以这里**不写 `color`**，写死任何一个 token 都会让点不再跟随悬停、也会比官方更淡。

## 表面材质

**半透明菜单表面跟随官方的毛玻璃材质**：`--dsw-specific-menu` 在 0.1.7-alpha.1 起从不透明的 `var(--dsw-alias-bg-layer-3)` 变成了半透明（深色 0.5 / 浅色 0.58）。官方契约是「绘制该底色的高层级表面**同时**应用 `backdrop-filter: var(--dsw-menu-backdrop-filter)`」（`blur(40px) saturate(150%)`，见 `ui-theme/README` 与 `Menu.module.css`）——只画底色不加模糊，表面就是一层能看穿页面的玻璃。弹出面板按这条配对。0.1.6-alpha.2 及更早没有这个变量，声明在计算值阶段失效、`backdrop-filter` 回到 `none`，正好是那边需要的降级（底色本就不透明），因此不需要版本判断。

**吸顶控件用不透明底色**：价格设置页的保存条 `position:sticky` 常驻顶部、正文从它下面滚过，因此用不透明的 `--dsw-alias-bg-layer-3`（正是 0.1.7-alpha.1 之前 `--dsw-specific-menu` 的值，分主题）。这里不能照抄面板的毛玻璃：保存条嵌在**已经有** `backdrop-filter` 的面板里，嵌套的滤镜不会再去模糊祖先之外的内容，半透明底色会直接透出滚过去的正文。官方对 sticky 控件也是这条规矩（`TerminalBlock.module.css`：「Card surface, not transparent」）。

## 表单控件

面板与设置页里的输入框、下拉框、组合框、时钟框、规则名输入框、星期按钮统一用官方 `ConfigField.module.css` 与 `settings-form/fields.module.css` 的配方：

```css
border: 0.5px solid var(--dsw-alias-border-l4);
border-radius: 8px;
background: var(--dsw-alias-bg-layer-3);
```

对焦换成品牌色描边（`--dsw-alias-brand-primary`，组合框用 `:focus-within`），非法值用官方的 `aria-invalid='true'` 换成 `--dsw-alias-state-error-primary`。高度取官方紧凑档 28px（`Button.module.css` 的 `.sm`），与按钮同高。

此前是 `1px solid var(--dsw-alias-border-l2)` + 7px 圆角 + `bg-overlay`，对焦只把描边从 l2 换成 l1——那是一圈「稍深一点的灰边」，比 DSH 其余控件重，对焦时又几乎没反应。`test-client.mjs` 把这条配方钉住了。

## 设计 token

插件引用的每个 `--dsw-*` 都在 DSH 的 `ui-theme`/`ui-primitives` 里确认存在。引用不存在的自定义属性会让**整条声明**在计算值阶段失效：曾用的 `--dsw-alias-fill-l1`/`-l2`、`--dsw-alias-separator-primary` 在 DSH 里从未定义，`--dsw-alias-state-warning-primary` 则是 `--dsw-alias-state-warn-primary` 的笔误，结果是选中态底色、徽章底色、分隔符颜色全部静默丢失。

`test-client.mjs` 里冻结了这份白名单，并断言：所有绘制 `--dsw-specific-menu` 的规则都配了毛玻璃滤镜；所有 `position:sticky` 规则都用不透明层级底色。两条判据都取自 DSH 自己的 `elevation-styles` / `TerminalBlock` 约定。

注意 DSH 官方代码里也有同类悬空引用（`ui-jobs` 引用 `--dsw-alias-fill-l2`、`StatsPills` 引用 `--dsw-alias-separator-primary`），因此「官方也这么写」不能当作 token 存在的证据，必须逐个核对。

## 官方组件

**图标按名字可用性取用**：`ui-primitives` 的图标命名换过一次口径——0.1.5-rc.1 至 0.1.6-alpha.2 把尺寸写进名字（`IconDatabaseOutline16`），0.1.7-alpha.1 起改成写字重（`IconDatabaseOutlineRegular`/`Medium`）。插件两套名字都试（先取与旧命名观感一致的 `Regular` 档），都取不到时降级为不画图标。**缺图标不能连累胶囊**：把 `undefined` 当组件交给 React 会抛「Element type is invalid」，那会炸掉整个 occupant，整枚胶囊连同面板一起消失——而实际缺的只是一个装饰性图标。这条是按可用性回退而不是按版本分支，因为插件在浏览器侧拿不到 DSH 版本号。

## 子代理用量的取数面

子代理跑在**自己的会话**里，用量不在父会话的事件流中——所以 `tokenFee` 投影（以及官方的 `tokenUsage`）天然只统计本会话。要让子代理计入合计，就得按会话 id 另外去读，插件为此用了两个内部面，都**可选**（缺失时降级为「读不到」，面板里如实列出未计入的数量，不抛错也不当成 0）：

| 面 | 用途 | 缺失时 |
|---|---|---|
| 客户端 `useProjection('subagentCatalog')` | 直接子会话的 `id` / `label` / `mode` | 返回 `undefined`，按「没有子代理」处理（投影套件对未装载的能力统一返回 `undefined`，不抛） |
| host `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })` | 该会话的完整观测：日志、`header`、`inheritedEventCount`，活会话与已结束会话走同一条路 | 该行记 `no-query` |

端点 `GET /api/token-fee/subagents?ids=…` 只回原始用量行，换算仍由浏览器半用与自身用量**完全相同**的那套 `computeView` 做——因此子代理的峰谷判定、多币种、未定价计数与主会话口径一致，不会各算一套（投影子系统也明确「不做客户端折叠」）。目录投影只给**直接**子会话，嵌套子代理由各自的父会话计入，因此合计天然覆盖整棵子树。

**seeded 子会话只折自己那段**。DSH 以「新建会话 id + 把父会话的事件当种子写进子会话日志」的方式启动 fork 与子代理会话。整段折叠会把父会话的用量在每个子会话里各重放一遍：实测一条会话带四个子代理时，四张卡片各自显示同样的 `1068.6M token`，合计被放大到四千多万倍之外（实为 1.37M）。因此端点只用 `seq >= inheritedEventCount` 的**后缀**折叠，但**保留**种子里的非用量事件（`request/header` 决定路由，整段跳掉会让子会话自己的请求折不出任何行）。父会话那一份永远由父会话自己的视图负责——`dsh-usage-stats` 处理同一问题时要额外判断「父会话存活日志是否仍覆盖种子范围」（它的场景是跨会话总账，压缩后子会话可能是唯一副本），本插件不需要这段判断。

还有一处坑：`tokenFee` 的投影视图是 `{ rows, route }` **对象**而不是裸数组。端点早先把整块当 `rows` 回给客户端，客户端的 `Array.isArray` 判定失败，于是所有子代理都显示「读不到用量」。

## 模块解析

**配置 schema 是手写的 Standard Schema**：契约要求插件导出 `Config`，而 cordis 只调用 `Config['~standard'].validate`（`vendor/cordis/src/fiber.ts`）。这里没有 `import '@deepseek-ai/schemastery'`，因为本插件以 link 方式安装，Node 从插件真实路径逐级向上找 `node_modules`，够不到 `$DSH_HOME/profiles/node_modules`（实测 `ERR_MODULE_NOT_FOUND`），引入该包会让插件装载失败。手写的校验器同样在装载期报错、填默认值并拒绝未知键。

浏览器半是手写的 `window.__ModuleLoader__.load({ id, factory })` 包，无构建步骤。它只 `require` 平台模块表里的四个说明符（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`），因此不涉及 `dsh.client.external`。

<h2 id="english">English</h2>

This plugin is a third-party bundle riding on DSH's **pre-stable public interfaces** (slot contracts, design tokens, built-in component exports, projection registration). This page records what it depends on, why it is written that way, and what cross-version checks found — maintainer constraints, not user instructions.

## Version compatibility

The check covered the eight tags from `dsh-v0.1.5-rc.1` to `dsh-v0.1.7-rc.1` (`0.1.5-rc.1/rc.2/rc.3`, `0.1.6-alpha.1/alpha.2`, `0.1.7-alpha.1/alpha.2/rc.1`), and **re-audited the same contract surfaces on `dsh-v0.1.7-rc.2`, `dsh-v0.2.0-rc.1`, `dsh-v0.2.0-rc.2` and the seven tags of the 0.2.1 line (`alpha.1`–`alpha.5`, `rc.1`, `rc.2`)**. The upstream change from `0.1.7-rc.1` to `0.2.1-rc.2` is large — `0.1.7-rc.1` to `0.2.0-rc.2` alone is 794 commits and 1155 files — but **every surface this plugin touches stayed put**: the icon export names, `conversation.composer.dock`'s `{ kind: 'list', scope: 'session' }`, the exports and props of `Menu`/`Button`, the design tokens `--dsw-alias-*`/`--dsw-specific-menu`/`--dsw-menu-backdrop-filter`, the `useProjection` standard seat, and on the host side `sessionProjections.register`, `ctx.inject`, `ctx.get('llm')`, `ctx.webServer.register`, `ctx.locale.register`, `settings.section` and `ctx.slots.inject` — each confirmed present on every tag, with the `Menu`/`Button` props identical to `0.1.7-rc.1` verbatim. The six host packages declared in `dsh.client.inject` are all still present on 0.2.1-rc.2 as well.

The 0.2.1 line brings **two new boundaries, both visual** (see the table below): the built-in stats pills split into two dock entries, and the pill corner radius went from fully round to `--dsw-radius-sm`. **Neither breaks the plugin** — the pill still occupies a dock entry of its own and the dock's row layout is unchanged.

**Contracts that held throughout** (checked tag by tag):

| Contract | Result |
| --- | --- |
| `conversation.composer.dock` | Always `{ kind: 'list', scope: 'session' }`, declared by `ui-conversation` |
| The `useProjection` standard seat | Always among the session-scope standard props |
| `locale.register(ns, dicts)` / `locale.bind(ns)` | Always present |
| `Menu` / `Button` exports and props | Always present (`Menu`'s `items`/`footer`/`selectedId`/`portal`/`getAnchorRect` unchanged) |
| `--dsw-elevation-prominent`, `--dsw-elevation-stroke-color` | Always defined |

**Four version boundaries in total.** Two are handled by availability fallbacks or spec-defined degradation; two are purely visual, and one of those is deliberately not followed (below). None uses a **version branch** — the browser side cannot read the DSH version:

| Boundary | Change | Response |
| --- | --- | --- |
| `0.1.6-alpha.2` | `conversation.composer.dock` went from a column container to a single flex row (`.dock`) | The root is only a shrink-wrapping node matching the built-in `StatsPills.root`, with no width or padding (v0.2.2) |
| `0.1.7-alpha.1` | Icons were renamed; `--dsw-specific-menu` went from opaque to translucent | Icons resolve by which name exists; menu surfaces pair with the backdrop filter and sticky controls use an opaque fill |
| `0.2.1-alpha.1` | The built-in stats went from "two pills inside one dock entry" to **one entry per pill** (`activity` / `usage`, carrying `data-composer-stat`) | **Nothing to do**: the plugin already owns an entry. The `.dock` container (`display:flex;justify-content:center;gap:12px`) still owns the row layout and matches the old `.root`, so the 12px gap between entries is unchanged; the shrink-wrapping recipe on `.tf_root` becomes redundant but harmless — it cannot be deleted, since `0.2.0-rc.2` and earlier still need it |
| `0.2.1-alpha.3` | The built-in pill's corner radius went from `999px` + `corner-shape: round` to `var(--dsw-radius-sm)` (`8px`) | **Deliberately not followed**: `--dsw-radius-sm` already exists on 0.2.0-rc.2 (8px on both), so it cannot serve as a version marker; and `latest` is still 0.2.0-rc.2 (fully round), where switching to 8px would *diverge* from the built-in pills in the same row. The plugin keeps `24px` (≈ fully round, matching the built-ins on ≤0.2.0). A one-line change once 0.2.1 becomes `latest` |

## Slots and layout

**The pill shares a row with the built-in stats pills**: since 0.1.6-alpha.2 `conversation.composer.dock` is a single flex row (`.dock`), and every slot occupant is a direct child of it — spacing, centering and the top pad belong to the dock. The plugin therefore only makes its own root a shrink-wrapping node matching the built-in `StatsPills.root` (no width, no padding) and never rewrites the InputBar layout: turning a row into a column, or the reverse, means rewriting the parent that carries other occupants, and a dock structure change would deform the composer — a destructive failure, not a degradation.

Since 0.2.1-alpha.1 the built-in stats are one pill per entry, so that `.root` row wrapper is gone and the row layout falls entirely to `.dock` (`justify-content:center;gap:12px`, the same spec as the old `.root`). The recipe on the plugin's root therefore becomes **redundant but harmless**: it is a shrink box with a single child, its own `justify-content` has no effect, and the 12px gap between entries still comes from the dock. It is **not deleted** — `0.2.0-rc.2` and earlier still ship the built-in `.root`, where the recipe is still required.

**The pill's separators match the built-in spec**: the built-in `StatsPills` puts `·` **inside** `.label` (the same flex item), so the two runs are separated only by `.sep`'s own `margin: 0 6px`; making the separator a direct child of the pill pays the `gap: 6px` twice more, stretching one dot from roughly 15px to roughly 27px. This plugin therefore groups the amount and every part into one `.tf_text`, with the separators as its children. The colour copies the built-in **result** too: the built-in `.sep` points at `--dsw-alias-separator-primary`, a token DSH never defines, so the declaration is invalid at computed-value time and `color` is inherited from the pill (resting `label-tertiary`, hover `label-secondary`) — hence **no `color` here**; pinning any token would stop the dot following hover and leave it fainter than the built-in.

## Surface material

**Translucent menu surfaces follow the built-in frosted-glass material**: from 0.1.7-alpha.1 `--dsw-specific-menu` changed from the opaque `var(--dsw-alias-bg-layer-3)` to a translucent colour (0.5 dark / 0.58 light). The built-in contract is that an elevated surface painting that fill **also** applies `backdrop-filter: var(--dsw-menu-backdrop-filter)` (`blur(40px) saturate(150%)`, see `ui-theme/README` and `Menu.module.css`) — painting the fill alone leaves a pane you can see the page through. The popup panel follows that pairing. 0.1.6-alpha.2 and earlier have no such variable, so the declaration is invalid at computed-value time and `backdrop-filter` falls back to `none`, which is exactly the degradation needed there (the fill is opaque); no version branch is required.

**Sticky controls use an opaque fill**: the pricing page's save bar is `position:sticky` at the top with content scrolling beneath it, so it uses the opaque `--dsw-alias-bg-layer-3` (exactly what `--dsw-specific-menu` was before 0.1.7-alpha.1, and palette-aware). It cannot copy the panel's frosted glass: the bar sits **inside** a panel that already has a `backdrop-filter`, and a nested filter does not reach beyond its ancestor, so a translucent fill would simply show the scrolling text through. The built-in rule for sticky controls is the same (`TerminalBlock.module.css`: "Card surface, not transparent").

## Form controls

The panel's and the settings page's inputs, selects, comboboxes, clock fields, rule-name fields and weekday buttons all use the recipe from the built-in `ConfigField.module.css` and `settings-form/fields.module.css`:

```css
border: 0.5px solid var(--dsw-alias-border-l4);
border-radius: 8px;
background: var(--dsw-alias-bg-layer-3);
```

Focus switches to a brand-coloured stroke (`--dsw-alias-brand-primary`; the combobox uses `:focus-within`), and invalid values use the built-in `aria-invalid='true'` to switch to `--dsw-alias-state-error-primary`. The height is the built-in compact step, 28px (`Button.module.css`'s `.sm`), so controls and buttons line up.

They used to be `1px solid var(--dsw-alias-border-l2)` with a 7px radius on `bg-overlay`, focusing by moving the stroke from l2 to l1 — a slightly darker grey ring, heavier than the rest of DSH and with almost no visible focus response. `test-client.mjs` pins the recipe.

## Design tokens

Every `--dsw-*` the plugin references was confirmed to exist in DSH's `ui-theme`/`ui-primitives`. Referencing an undefined custom property invalidates the **whole declaration** at computed-value time: the `--dsw-alias-fill-l1`/`-l2` and `--dsw-alias-separator-primary` this plugin used to name were never defined by DSH, and `--dsw-alias-state-warning-primary` was a typo for `--dsw-alias-state-warn-primary`, so selected-tab fills, badge fills and the separator colour were all silently dropped.

`test-client.mjs` freezes that allowlist and asserts two rules: every rule painting `--dsw-specific-menu` also carries the backdrop filter, and every `position:sticky` rule uses an opaque layer fill. Both criteria come from DSH's own `elevation-styles` / `TerminalBlock` conventions.

Note that DSH's own code carries dangling references of the same kind (`ui-jobs` names `--dsw-alias-fill-l2`, `StatsPills` names `--dsw-alias-separator-primary`), so "the built-in code does it too" is no evidence that a token exists — each one has to be checked.

## Built-in components

**Icons are resolved by which name exists**: `ui-primitives` renamed its icons once — 0.1.5-rc.1 through 0.1.6-alpha.2 spelled the size into the name (`IconDatabaseOutline16`), while 0.1.7-alpha.1 onwards spells the weight (`IconDatabaseOutlineRegular`/`Medium`). The plugin tries both namings (preferring `Regular`, which matches the old look) and degrades to drawing no icon when neither exists. **A missing icon must not take the pill down with it**: handing `undefined` to React as a component throws "Element type is invalid", which kills the whole occupant — the pill and its panel both vanish over a decorative glyph. The fallback is by availability rather than by version branch, because a browser-side plugin cannot read the DSH version.

## Module resolution

**The config schema is a hand-written Standard Schema**: the contract requires the plugin to export `Config`, and cordis only calls `Config['~standard'].validate` (`vendor/cordis/src/fiber.ts`). There is no `import '@deepseek-ai/schemastery'` here because the plugin is link-installed: Node walks up from the plugin's real path looking for `node_modules` and never reaches `$DSH_HOME/profiles/node_modules` (measured as `ERR_MODULE_NOT_FOUND`), so importing that package would make the plugin fail to load. The hand-written validator still errors at load time, fills defaults and rejects unknown keys.

The browser half is a hand-written `window.__ModuleLoader__.load({ id, factory })` bundle with no build step. It only `require`s four specifiers from the platform module table (`react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/dsh-client-ui-primitives`), so it needs no `dsh.client.external`.

## Reading subagent usage

A subagent runs in **its own session**, so its usage never enters the parent's event stream — the `tokenFee` projection (like the built-in `tokenUsage`) therefore only ever counts this session. Counting subagents means reading them by session id, which uses two internal surfaces, both **optional** (a missing service degrades to "unreadable", the panel states how many were left out, and nothing throws or silently reads as zero):

| Surface | Purpose | When absent |
|---|---|---|
| Client `useProjection('subagentCatalog')` | Direct children's `id` / `label` / `mode` | Returns `undefined`, treated as "no subagents" (the projection kit returns `undefined` for every unmounted capability rather than throwing) |
| Host `ctx.sessionQuery.observeSession(id, { projectionMode: 'all' })` | The complete observation — log, `header`, `inheritedEventCount` — through one path for live and finished sessions alike | Row is marked `no-query` |

The `GET /api/token-fee/subagents?ids=…` endpoint returns raw usage rows only; the conversion still happens in the browser half through the **same** `computeView` used for its own usage — so peak/off-peak decisions, multi-currency handling and unpriced counts match the main session exactly, with no second implementation (the projection subsystem explicitly forbids client-side folding). The catalog lists **direct** children only; nested subagents are counted by their own parent, so the total naturally covers the whole subtree.

**A seeded child is folded over its own suffix only.** DSH starts a fork or a subagent session by minting a new session id and writing the parent's events into the child's log as a seed. Folding the whole log replays the parent's usage inside every child: one session with four subagents made each card report the same `1068.6M` tokens, inflating the group roughly three thousandfold (the real figure was 1.37M). The endpoint therefore folds only `seq >= inheritedEventCount`, while **keeping** the seeded non-usage events such as `request/header`, which establish the route — dropping the whole seed leaves the child's own requests without a route and yields no rows at all. The parent's own share is never re-derived here; the parent's view owns it, which is also why `dsh-usage-stats` needs an extra "does the parent's surviving log still cover the seed" test for its cross-session ledger and this plugin does not.

One more trap: the `tokenFee` projection view is a `{ rows, route }` **object**, not a bare array. The endpoint originally forwarded it whole as `rows`, the client's `Array.isArray` check failed, and every subagent showed "usage unavailable".
