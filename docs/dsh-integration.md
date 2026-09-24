# DSH 集成约束 / DSH integration constraints

[中文](#中文) | [English](#english)

<h2 id="中文">中文</h2>

本插件是第三方 bundle，靠 DSH 的**未稳定公共接口**工作（slot 契约、设计 token、官方组件导出、投影注册）。这里记下它依赖了什么、为什么这么写，以及跨版本核对的结果——这些是维护者约束，不是用户操作说明。

## 版本兼容

核对范围是 `dsh-v0.1.5-rc.1` 到 `dsh-v0.1.7-rc.1` 之间的 8 个 tag（`0.1.5-rc.1/rc.2/rc.3`、`0.1.6-alpha.1/alpha.2`、`0.1.7-alpha.1/alpha.2/rc.1`）。

**全程稳定的契约面**（8 个 tag 逐个核对）：

| 契约面 | 结果 |
| --- | --- |
| `conversation.composer.dock` | 一直是 `{ kind: 'list', scope: 'session' }`，由 `ui-conversation` 声明 |
| `useProjection` 标准座位 | 一直在会话作用域的标准 props 里 |
| `locale.register(ns, dicts)` / `locale.bind(ns)` | 一直在 |
| `Menu` / `Button` 导出与 props | 一直在（`Menu` 的 `items`/`footer`/`selectedId`/`portal`/`getAnchorRect` 等未变） |
| `--dsw-elevation-prominent`、`--dsw-elevation-stroke-color` | 一直有定义 |

**只有两条版本边界**，两处都做成了按可用性回退或按规范降级，**不做版本分支**——浏览器侧拿不到 DSH 版本号：

| 边界 | 变化 | 本插件的应对 |
| --- | --- | --- |
| `0.1.6-alpha.2` | `conversation.composer.dock` 从纵向容器变成一行 flex（`.dock`） | 根节点只做与官方 `StatsPills.root` 同规格的收缩节点，不写宽度与内距（v0.2.2） |
| `0.1.7-alpha.1` | 图标改名；`--dsw-specific-menu` 由不透明变半透明 | 图标按名字可用性回退；菜单表面配对毛玻璃，吸顶控件改用不透明底色 |

## Slot 与布局

**胶囊与官方统计胶囊同处一行**：0.1.6-alpha.2 起 `conversation.composer.dock` 是一行 flex（`.dock`），slot 的每个 occupant 都是它的直接子项，间距、居中与上边距由 dock 统一负责。本插件因此只把自己的根节点写成与官方 `StatsPills.root` 同规格的收缩节点（不写宽度与内距），绝不改写 InputBar 的布局——把并排改成上下、或反过来，都属于改写承载其他 occupant 的父容器，官方调整结构时会让输入区变形，那是破坏性失败而不只是降级。

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

## 模块解析

**配置 schema 是手写的 Standard Schema**：契约要求插件导出 `Config`，而 cordis 只调用 `Config['~standard'].validate`（`vendor/cordis/src/fiber.ts`）。这里没有 `import '@deepseek-ai/schemastery'`，因为本插件以 link 方式安装，Node 从插件真实路径逐级向上找 `node_modules`，够不到 `$DSH_HOME/profiles/node_modules`（实测 `ERR_MODULE_NOT_FOUND`），引入该包会让插件装载失败。手写的校验器同样在装载期报错、填默认值并拒绝未知键。

浏览器半是手写的 `window.__ModuleLoader__.load({ id, factory })` 包，无构建步骤。它只 `require` 平台模块表里的四个说明符（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`），因此不涉及 `dsh.client.external`。

<h2 id="english">English</h2>

This plugin is a third-party bundle riding on DSH's **pre-stable public interfaces** (slot contracts, design tokens, built-in component exports, projection registration). This page records what it depends on, why it is written that way, and what cross-version checks found — maintainer constraints, not user instructions.

## Version compatibility

The check covered the eight tags from `dsh-v0.1.5-rc.1` to `dsh-v0.1.7-rc.1` (`0.1.5-rc.1/rc.2/rc.3`, `0.1.6-alpha.1/alpha.2`, `0.1.7-alpha.1/alpha.2/rc.1`).

**Contracts that held throughout** (checked tag by tag):

| Contract | Result |
| --- | --- |
| `conversation.composer.dock` | Always `{ kind: 'list', scope: 'session' }`, declared by `ui-conversation` |
| The `useProjection` standard seat | Always among the session-scope standard props |
| `locale.register(ns, dicts)` / `locale.bind(ns)` | Always present |
| `Menu` / `Button` exports and props | Always present (`Menu`'s `items`/`footer`/`selectedId`/`portal`/`getAnchorRect` unchanged) |
| `--dsw-elevation-prominent`, `--dsw-elevation-stroke-color` | Always defined |

**Only two version boundaries**, and both are handled by availability fallbacks or spec-defined degradation rather than **version branches** — the browser side cannot read the DSH version:

| Boundary | Change | Response |
| --- | --- | --- |
| `0.1.6-alpha.2` | `conversation.composer.dock` went from a column container to a single flex row (`.dock`) | The root is only a shrink-wrapping node matching the built-in `StatsPills.root`, with no width or padding (v0.2.2) |
| `0.1.7-alpha.1` | Icons were renamed; `--dsw-specific-menu` went from opaque to translucent | Icons resolve by which name exists; menu surfaces pair with the backdrop filter and sticky controls use an opaque fill |

## Slots and layout

**The pill shares a row with the built-in stats pills**: since 0.1.6-alpha.2 `conversation.composer.dock` is a single flex row (`.dock`), and every slot occupant is a direct child of it — spacing, centering and the top pad belong to the dock. The plugin therefore only makes its own root a shrink-wrapping node matching the built-in `StatsPills.root` (no width, no padding) and never rewrites the InputBar layout: turning a row into a column, or the reverse, means rewriting the parent that carries other occupants, and a dock structure change would deform the composer — a destructive failure, not a degradation.

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
