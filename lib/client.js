/**
 * dsh-token-fee — 浏览器半。
 *
 * 手写的 `__ModuleLoader__` 包（无构建步骤），提供三处界面：
 *   1. 输入框下方的费用胶囊：显示当前会话花费（精确到分）、当前正在使用的模型
 *      的计费模式（统一 / 峰谷），峰谷时再给出当前时段与切换到下一时段的剩余时间；
 *   2. 胶囊弹出的面板：「费用明细」按供应商/模型列出缓存未命中、缓存命中、
 *      缓存写入与输出的 token 数与金额，「价格设置」就地编辑价目表；
 *   3. dsh 设置中的「Token 费用」页：同一套价格与峰谷规则编辑器。
 *
 * 会话用量来自 host 半注册的 `tokenFee` 投影；价目表来自 host 半的回环端点。
 * 金额在浏览器侧换算，因此改价格立即生效，无需重启 dsh。
 */

window.__ModuleLoader__.load({
	id: "@lantiosity/dsh-token-fee",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const reactDom = require("react-dom");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const { jsx, jsxs } = jsxRuntime;
		const { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } = react;
		const { createPortal } = reactDom;
		const { IconDatabaseOutline16, IconChevronDownOutline14, Menu, Button } = primitives;

		/**
		 * 统一的元素构造器。
		 *
		 * `jsxs` 要求 children 是数组，且 `key` 必须作为独立实参传入而不是混在
		 * props 里展开——这两条都是 React 开发模式会报警的约束。没有子节点时
		 * 完全省略 `children`，否则 `<input>` 这类自闭合标签会渲染失败。
		 */
		function el(type, props, ...children) {
			const { key, ...rest } = props === null || props === undefined ? {} : props;
			const elementProps = children.length === 0 ? rest : { ...rest, children };
			return key === undefined ? jsxs(type, elementProps) : jsxs(type, elementProps, key);
		}

		//#region css
		const css = [
			// pill 行与官方 StatsPills 的 .root 完全同规格：同样的居中、间距、
			// 侧向留白与 13/20 次级文本档，因此两行在输入框下观感一致。
			".tf_root{display:flex;justify-content:center;gap:12px;max-width:var(--dsh-chat-content-width);width:100%;margin:0 auto;box-sizing:border-box;padding:4px calc(var(--dsh-composer-side-clearance) + 16px) 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}",
			// 胶囊本体逐项对齐官方 .pill：1px 8px 内距、24px 圆角、透明底、
			// 三级文本色、14px 图标、tabular-nums。
			".tf_pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;padding:1px 8px;border:none;border-radius:24px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;cursor:pointer}",
			".tf_pill svg{width:14px;height:14px;flex:none}",
			".tf_pill:hover,.tf_pill[data-active]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".tf_pill[data-unpriced]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary))}",
			// 金额沿用胶囊自身的字色与字重，不额外加粗提色，否则会在同排中显得突兀。
			".tf_amount{min-width:0;overflow:hidden;text-overflow:ellipsis}",
			".tf_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			// 计费模式、当前时段与剩余时间沿用胶囊自身的字色，只保证不折行；
			// 倒计时另外用等宽数字，否则每秒重排会让整行胶囊抖动。
			".tf_mode,.tf_tariff,.tf_countdown{white-space:nowrap}",
			".tf_countdown{font-variant-numeric:tabular-nums}",
			// 面板用官方 stat-dialog 的皮肤：菜单底色 + 12px 圆角 + prominent 投影，
			// 与内置「轮次/速度」「token 用量」胶囊展开后的观感一致。
			// 宽度按标签页给：明细只有合计与几张卡片，撑到价格设置的宽度会显得空；
			// 价格设置有四列单价表与操作按钮，需要更宽。
			".tf_panel{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;max-height:min(74vh,680px);padding:0;border:0;border-radius:12px;background:var(--dsw-specific-menu);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:default;overflow:hidden}",
			".tf_panel[data-tab=detail]{width:max-content;min-width:min(320px,calc(100vw - 24px));max-width:min(420px,calc(100vw - 24px))}",
			".tf_panel[data-tab=pricing]{width:min(560px,calc(100vw - 24px))}",
			".tf_panelHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;min-height:42px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".tf_panelTitle{display:inline-flex;align-items:center;gap:7px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}",
			".tf_panelActions{display:inline-flex;align-items:center;gap:2px}",
			".tf_tabs{display:flex;gap:2px;flex:none;padding:6px 10px 0}",
			".tf_tab{border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;padding:4px 9px;border-radius:7px;cursor:pointer}",
			".tf_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tf_tab[data-active]{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-weight:500}",
			".tf_body{flex:1;min-height:0;overflow-y:auto;padding:10px 14px 14px}",
			".tf_iconButton{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;cursor:pointer}",
			".tf_iconButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".tf_total{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:9px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-fill-l1,transparent)}",
			".tf_totalLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".tf_totalValue{color:var(--dsw-alias-label-primary);font-size:20px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}",
			".tf_totalExact{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tf_group{margin-top:12px}",
			".tf_groupHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:5px}",
			".tf_groupName{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".tf_groupMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}",
			".tf_card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px;margin-bottom:6px}",
			".tf_cardHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}",
			".tf_model{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px;word-break:break-all}",
			".tf_cardAmount{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".tf_cardAmount[data-unpriced]{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-tertiary));font-weight:500}",
			".tf_rows{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:2px 10px;font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}",
			".tf_rows2{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}",
			".tf_priceTable{display:grid;grid-template-columns:auto repeat(4,minmax(0,1fr));gap:2px 10px;font-size:11px;line-height:17px;font-variant-numeric:tabular-nums}",
			".tf_priceHead{color:var(--dsw-alias-label-tertiary);text-align:right;white-space:nowrap}",
			".tf_priceRowLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding-right:2px}",
			".tf_priceValue{color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap}",
			".tf_rowLabel{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
			".tf_rowTokens{color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap}",
			".tf_rowCost{color:var(--dsw-alias-label-secondary);text-align:right;white-space:nowrap;min-width:64px}",
			".tf_badges{display:inline-flex;gap:4px;flex-wrap:wrap;margin-top:6px}",
			".tf_badge{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}",
			".tf_badge[data-warn]{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}",
			".tf_note{margin:8px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}",
			".tf_error{margin:8px 0 0;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px;word-break:break-word}",
			// 非法输入被归零后的提示：警示色而非报错色，因为保存本身已经成功。
			".tf_warn{margin:8px 0 0;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary));font-size:11px;line-height:17px;word-break:break-word}",
			".tf_empty{margin:10px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".tf_section{margin-top:14px}",
			".tf_sectionHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}",
			".tf_sectionTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px}",
			".tf_sectionHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin:0 0 6px}",
			".tf_field{display:flex;flex-direction:column;gap:3px;min-width:0}",
			".tf_fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}",
			".tf_input,.tf_select{box-sizing:border-box;width:100%;min-width:0;height:26px;padding:0 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}",
			".tf_input:focus,.tf_select:focus{outline:none;border-color:var(--dsw-alias-border-l1)}",
			".tf_input[data-invalid]{border-color:var(--dsw-alias-state-error-primary)}",
			".tf_grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}",
			".tf_grid4{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}",
			".tf_grid5{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}",
			".tf_checkRow{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;cursor:pointer;user-select:none}",
			".tf_days{display:flex;gap:3px;flex-wrap:wrap}",
			".tf_day{width:26px;height:24px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}",
			".tf_day[data-active]{border-color:transparent;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);font-weight:600}",
			".tf_windows{display:flex;flex-direction:column;gap:5px}",
			".tf_window{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto;align-items:center;gap:6px}",
			".tf_windowDash{color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".tf_entryHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:6px}",
			".tf_entryName{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;line-height:18px;word-break:break-all}",
			".tf_entryScope{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}",
			// 卡片页脚：说明文字占左侧，操作按钮靠右下，与内置卡片的说明行同一高度。
			".tf_cardFoot{display:flex;align-items:flex-end;justify-content:space-between;gap:10px;margin-top:6px}",
			".tf_cardActions{display:inline-flex;gap:6px;flex:none;margin-left:auto}",
			".tf_footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l2)}",
			".tf_footerHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".tf_footerActions{display:inline-flex;gap:6px;flex:none}",
			// provider / model 组合框：输入框 + 右侧箭头，下拉列表复用官方 Menu。
			".tf_combo{display:flex;align-items:center;box-sizing:border-box;width:100%;min-width:0;height:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base));overflow:hidden}",
			".tf_combo:focus-within{border-color:var(--dsw-alias-border-l1)}",
			".tf_comboInput{box-sizing:border-box;flex:1;min-width:0;height:100%;padding:0 4px 0 7px;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;outline:none}",
			".tf_comboToggle{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:100%;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
			".tf_comboToggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".tf_menuList{min-width:220px;max-width:min(360px,calc(100vw - 24px));max-height:min(320px,50vh)}",
			// 保存条常驻顶部且吸顶，因此必须用与面板一致的不透明底色，
			// 否则内容从它下面滚过时会透出来，读数被干扰。
			".tf_saveBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none;padding:8px 10px;margin-bottom:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-menu);position:sticky;top:0;z-index:2}",
			".tf_saveState{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-left:auto}",
			".tf_settings{padding:0}",
			// 费用胶囊独占 composer dock 的一行，与内置统计胶囊上下排列。
			//
			// 曾尝试用 :has() 把两者所在父级改成横向布局以并排显示，已放弃：
			// 那需要改写 InputBar 根容器的 display/flex-direction，并依赖
			// ui-chat 的私有标记 data-composer-stats。官方调整 dock 布局、
			// 更换标记，或在根容器新增需要并排的子元素时，输入区会被强制
			// 独占整行而变形——这是破坏性失败，不只是降级。独占一行是官方
			// 为 dock 多 occupant 设定的约定（data-composer-stats 就是为此
			// 预留的双向约定），插件不越界改写其他插件的组件布局。
		].join("");
		const tagId = "dsh-token-fee/TokenFee.module.css";

		/**
		 * 注入本插件唯一的样式表，返回释放函数。
		 *
		 * 已有的同 id 标签会复用（HMR 后重新 apply 时不会堆积），但只有本次真正
		 * 创建的那个才由返回的释放函数移除——移除别人的标签会让仍在挂载的实例
		 * 丢样式。注册即效果：插件卸载时样式随之撤销。
		 * @returns 释放函数，移除本次创建的标签。
		 */
		function installStyles() {
			if (typeof document === "undefined") return () => {};
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) {
				return () => {};
			}
			const tag = document.createElement("style");
			tag.dataset.plugin = "@lantiosity/dsh-token-fee";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		const S = {
			root: "tf_root",
			pill: "tf_pill",
			amount: "tf_amount",
			sep: "tf_sep",
			mode: "tf_mode",
			tariff: "tf_tariff",
			countdown: "tf_countdown",
			panel: "tf_panel",
			panelHeader: "tf_panelHeader",
			panelTitle: "tf_panelTitle",
			panelActions: "tf_panelActions",
			tabs: "tf_tabs",
			tab: "tf_tab",
			body: "tf_body",
			iconButton: "tf_iconButton",
			button: "tf_button",
			total: "tf_total",
			totalLabel: "tf_totalLabel",
			totalValue: "tf_totalValue",
			totalExact: "tf_totalExact",
			group: "tf_group",
			groupHead: "tf_groupHead",
			groupName: "tf_groupName",
			groupMeta: "tf_groupMeta",
			card: "tf_card",
			cardHead: "tf_cardHead",
			model: "tf_model",
			cardAmount: "tf_cardAmount",
			rows: "tf_rows",
			rows2: "tf_rows2",
			priceTable: "tf_priceTable",
			priceHead: "tf_priceHead",
			priceRowLabel: "tf_priceRowLabel",
			priceValue: "tf_priceValue",
			rowLabel: "tf_rowLabel",
			rowTokens: "tf_rowTokens",
			rowCost: "tf_rowCost",
			badges: "tf_badges",
			badge: "tf_badge",
			note: "tf_note",
			error: "tf_error",
			warn: "tf_warn",
			empty: "tf_empty",
			section: "tf_section",
			sectionHead: "tf_sectionHead",
			sectionTitle: "tf_sectionTitle",
			sectionHint: "tf_sectionHint",
			field: "tf_field",
			fieldLabel: "tf_fieldLabel",
			input: "tf_input",
			select: "tf_select",
			grid2: "tf_grid2",
			grid4: "tf_grid4",
			grid5: "tf_grid5",
			checkRow: "tf_checkRow",
			days: "tf_days",
			day: "tf_day",
			windows: "tf_windows",
			window: "tf_window",
			windowDash: "tf_windowDash",
			entryHead: "tf_entryHead",
			entryName: "tf_entryName",
			entryScope: "tf_entryScope",
			cardFoot: "tf_cardFoot",
			cardActions: "tf_cardActions",
			footer: "tf_footer",
			footerHint: "tf_footerHint",
			footerActions: "tf_footerActions",
			combo: "tf_combo",
			comboInput: "tf_comboInput",
			comboToggle: "tf_comboToggle",
			menuList: "tf_menuList",
			saveBar: "tf_saveBar",
			saveState: "tf_saveState",
		};
		//#endregion

		//#region 定价换算（与 host 半同构的只读子集）
		const TOKENS_PER_MILLION = 1000000;
		/** 计费桶顺序，同时是详情面板的行顺序。 */
		const BUCKETS = ["input", "cacheRead", "cacheWrite", "output"];
		const DEFAULT_CURRENCY = "CNY";
		const PRICING_PATH = "/api/token-fee/pricing";
		const PRICING_RESET_PATH = "/api/token-fee/pricing/reset";
		const ACTION_HEADER = "x-dsh-token-fee-action";

		/** 历史路由 id 到官方路由 id 的别名，与 host 半保持一致。 */
		const PROVIDER_ALIASES = { deepseek: "deepseek-official" };
		/** 已下线模型名到在售模型名的别名。 */
		const MODEL_ALIASES = {
			"deepseek-v4-flash": "deepseek-flash",
			"deepseek-v4-flash-vision-exp": "deepseek-flash",
		};

		/** 条目对给定身份的匹配得分：精确 0，provider 通配 1，model 通配 2，全通配 3。 */
		function matchScore(entry, provider, model) {
			const providerHit = entry.provider === "*" || entry.provider === provider;
			const modelHit = entry.model === "*" || entry.model === model;
			if (!providerHit || !modelHit) return null;
			if (entry.provider !== "*" && entry.model !== "*") return 0;
			if (entry.model !== "*") return 1;
			if (entry.provider !== "*") return 2;
			return 3;
		}

		/** 在给定身份上取最优条目。 */
		function bestMatch(entries, provider, model) {
			let best = null;
			let bestScore = Infinity;
			for (const entry of entries) {
				const score = matchScore(entry, provider, model);
				if (score === null || score >= bestScore) continue;
				best = entry;
				bestScore = score;
				if (score === 0) break;
			}
			return best;
		}

		/** 解析 provider/model 的价目条目，未命中时依次回退到路由别名与模型别名。 */
		function matchEntry(entries, provider, model) {
			const providerAlias = PROVIDER_ALIASES[provider];
			const modelAlias = MODEL_ALIASES[model];
			const candidates = [[provider, model]];
			if (providerAlias !== undefined) candidates.push([providerAlias, model]);
			if (modelAlias !== undefined) candidates.push([provider, modelAlias]);
			if (providerAlias !== undefined && modelAlias !== undefined) candidates.push([providerAlias, modelAlias]);
			for (const [candidateProvider, candidateModel] of candidates) {
				const hit = bestMatch(entries, candidateProvider, candidateModel);
				if (hit !== null) return hit;
			}
			return null;
		}

		/** 一个用量行的四个桶归零。 */
		function zeroBuckets() {
			return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
		}

		/** 取某条目在某时段下的单位价格块。 */
		function unitPricesOf(entry, tariff) {
			return entry.prices.offPeak !== undefined && tariff === "offPeak" ? entry.prices.offPeak : entry.prices.peak;
		}

		/** 星期缩写到 `Date.getDay()` 的编号，与 host 半一致。 */
		const WEEKDAY_NUMBER = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

		/** 把 `HH:MM` 解析成当日分钟数；非法时为 null。 */
		function minuteOf(clock) {
			const match = /^(\d{2}):(\d{2})$/.exec(String(clock));
			if (match === null) return null;
			const hour = Number(match[1]);
			const minute = Number(match[2]);
			if (hour > 23 || minute > 59) return null;
			return hour * 60 + minute;
		}

		/** 把时间戳换成调度时区下的墙上时间（含秒）。 */
		function zonedParts(timestamp, timezone) {
			const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
				timeZone: timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				weekday: "short",
				hour: "2-digit",
				minute: "2-digit",
				second: "2-digit",
				hourCycle: "h23",
			}).formatToParts(new Date(timestamp))
				.filter(part => part.type !== "literal")
				.map(part => [part.type, part.value]));
			return {
				year: Number(parts.year),
				month: Number(parts.month),
				day: Number(parts.day),
				weekday: WEEKDAY_NUMBER[parts.weekday],
				minute: Number(parts.hour) * 60 + Number(parts.minute),
				second: Number(parts.second),
			};
		}

		/** 某时刻在调度时区下的 UTC 偏移（毫秒）。 */
		function zoneOffsetMs(timestamp, timezone) {
			const clock = zonedParts(timestamp, timezone);
			const wall = Date.UTC(
				clock.year,
				clock.month - 1,
				clock.day,
				Math.floor(clock.minute / 60),
				clock.minute % 60,
				clock.second,
			);
			return wall - Math.floor(timestamp / 1000) * 1000;
		}

		/**
		 * 把调度时区下的墙上时间换算成绝对时间戳。
		 *
		 * 先假设墙上时间就是 UTC 并据此修正一次，再用修正后的时刻复核偏移：夏令时
		 * 切换当天两个偏移不同，第二次的结果才是正确的那一侧。
		 */
		function wallClockToTimestamp(wall, timezone) {
			const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
			return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timezone), timezone);
		}

		/**
		 * 判定一个时间戳落在条目调度的哪个时段。
		 *
		 * 与 host 半 `pricing.js` 的 `tariffAt` 逐字同构：host 用它给每个用量样本
		 * 定档，浏览器用它渲染「当前时段」，两侧不一致会让倒计时指向错误的时刻。
		 */
		function tariffAt(entry, timestamp) {
			if (entry.prices.offPeak === undefined || entry.schedule === null || entry.schedule === undefined) return "peak";
			if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "peak";
			const clock = zonedParts(timestamp, entry.schedule.timezone);
			if (!entry.schedule.peakDays.includes(clock.weekday)) return "offPeak";
			const inWindow = entry.schedule.peakWindows.some(([start, end]) => {
				const from = minuteOf(start);
				const to = minuteOf(end);
				return from !== null && to !== null && clock.minute >= from && clock.minute < to;
			});
			return inWindow ? "peak" : "offPeak";
		}

		/**
		 * 找出一个时刻之后的下一次时段切换。
		 *
		 * 时段只可能在窗口起点、窗口终点与零点这三类边界上变化，因此只枚举这些
		 * 边界，从当天起逐日推进到第一个判定结果不同的边界。上限 8 天覆盖最稀疏
		 * 的规则（例如只在周一 09:00-12:00 计高峰，从周一 12:00 起要等近 7 天）。
		 */
		function nextTariffBoundary(entry, timestamp) {
			const schedule = entry.schedule;
			const current = tariffAt(entry, timestamp);
			const clock = zonedParts(timestamp, schedule.timezone);
			const boundaries = new Set([0]);
			for (const [start, end] of schedule.peakWindows) {
				boundaries.add(minuteOf(start));
				boundaries.add(minuteOf(end));
			}
			const minutes = [...boundaries].filter(value => value !== null).sort((a, b) => a - b);
			for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
				const date = new Date(Date.UTC(clock.year, clock.month - 1, clock.day + dayOffset));
				for (const minute of minutes) {
					const at = wallClockToTimestamp({
						year: date.getUTCFullYear(),
						month: date.getUTCMonth() + 1,
						day: date.getUTCDate(),
						hour: Math.floor(minute / 60),
						minute: minute % 60,
						second: 0,
					}, schedule.timezone);
					if (at <= timestamp) continue;
					const tariff = tariffAt(entry, at);
					if (tariff !== current) return { at, tariff };
				}
			}
			return null;
		}

		/** 条目在某一时刻的计费状态，与 host 半 `tariffStateAt` 同构。 */
		function tariffStateAt(entry, timestamp) {
			if (entry.prices.offPeak === undefined || entry.schedule === null || entry.schedule === undefined) {
				return { split: false, tariff: "peak", nextTariff: null, remainingMs: null };
			}
			const tariff = tariffAt(entry, timestamp);
			const next = nextTariffBoundary(entry, timestamp);
			return {
				split: true,
				tariff,
				nextTariff: next === null ? null : next.tariff,
				remainingMs: next === null ? null : Math.max(0, next.at - timestamp),
			};
		}

		/**
		 * 本会话的计费模式：取决于**当前正在使用的模型**。
		 *
		 * 投影里的 `route` 是最近一次请求的路由，因此它命中的价目条目就是此刻
		 * 在计价的条目：该条目只有单一单价时为 `flat`（统一），配了空闲价时为
		 * `split`（峰谷），此时再给出当前时段与下一次切换的剩余时间。
		 *
		 * 不按「会话里出现过的所有条目」判定：一个会话可以先后用多个模型，混在
		 * 一起只能得到「既统一又峰谷」这种没有意义的结论，而用户要问的是「我
		 * 现在按哪种价在烧钱」。
		 * @param entry - 当前路由命中的价目条目，未命中为 null。
		 * @param now - 当前时间戳。
		 * @returns `null`（当前模型没有价目条目）或 {@link tariffStateAt} 的结果。
		 */
		function describeBilling(entry, now) {
			if (entry === null || entry === undefined) return null;
			return tariffStateAt(entry, now);
		}

		/**
		 * 倒计时文本 `hh:mm:ss`。
		 *
		 * 小时不进位到天：跨周末的长间隔按总小时数显示（例如 63:00:00），比
		 * 「2 天 15 小时」更贴近「还剩多久」这一个问题。向上取整，最后一秒不会
		 * 提前显示 00:00:00。
		 */
		function formatCountdown(ms) {
			const total = Math.max(0, Math.ceil((Number.isFinite(ms) ? ms : 0) / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			return String(hours).padStart(2, "0")
				+ ":" + String(minutes).padStart(2, "0")
				+ ":" + String(seconds).padStart(2, "0");
		}

		/**
		 * 把 `tokenFee` 投影换算成展示视图。
		 *
		 * 行按供应商分组，组内按模型聚合：同一模型的高峰与空闲行合并为一条，
		 * 四个桶的 token 数相加、金额按各自时段单价分别计算后相加，因此卡片上
		 * 的分桶金额之和恒等于该模型的合计。未配置价格的模型照常展示 token 数，
		 * 金额为空且不计入总计。
		 */
		function computeView(usage, entries, displayCurrency) {
			const rows = usage?.rows ?? [];
			const models = new Map();
			for (const row of rows) {
				const key = row.provider + "\u0000" + row.model;
				const previous = models.get(key);
				const entry = previous === undefined ? matchEntry(entries, row.provider, row.model) : previous.entry;
				const buckets = previous === undefined ? zeroBuckets() : previous.buckets;
				const amounts = previous === undefined ? zeroBuckets() : previous.amounts;
				const nextBuckets = {};
				const nextAmounts = {};
				const unit = entry === null ? null : unitPricesOf(entry, row.tariff);
				let rowAmount = previous === undefined ? 0 : previous.amount;
				for (const bucket of BUCKETS) {
					const tokens = (row[bucket] ?? 0);
					nextBuckets[bucket] = buckets[bucket] + tokens;
					const cost = unit === null ? 0 : tokens / TOKENS_PER_MILLION * (unit[bucket] ?? 0);
					nextAmounts[bucket] = amounts[bucket] + cost;
					rowAmount += cost;
				}
				models.set(key, {
					provider: row.provider,
					model: row.model,
					buckets: nextBuckets,
					amounts: nextAmounts,
					entry,
					priced: entry !== null,
					currency: entry === null ? null : entry.currency,
					amount: rowAmount,
				});
			}
			const groups = new Map();
			const byCurrency = {};
			let amount = 0;
			let tokens = 0;
			let unpricedCount = 0;
			for (const item of models.values()) {
				const rowTokens = BUCKETS.reduce((sum, bucket) => sum + item.buckets[bucket], 0);
				tokens += rowTokens;
				if (item.priced && item.currency !== null) {
					byCurrency[item.currency] = (byCurrency[item.currency] ?? 0) + item.amount;
					if (item.currency === displayCurrency) amount += item.amount;
				} else {
					unpricedCount += 1;
				}
				const group = groups.get(item.provider) ?? { provider: item.provider, models: [], tokens: 0, amount: 0 };
				group.models.push({ ...item, tokens: rowTokens });
				group.tokens += rowTokens;
				if (item.priced && item.currency === displayCurrency) group.amount += item.amount;
				groups.set(item.provider, group);
			}
			return {
				currency: displayCurrency,
				amount,
				tokens,
				unpricedCount,
				byCurrency,
				mixedCurrency: Object.keys(byCurrency).some(code => code !== displayCurrency && byCurrency[code] > 0),
				groups: [...groups.values()].sort((a, b) => b.tokens - a.tokens),
			};
		}

		//#endregion

		//#region 格式化
		/** 货币格式化器缓存；非法币种码回退到 `代码 + 数字`。 */
		const moneyFormatters = new Map();

		/** 高精度金额格式化器缓存，键为 `币种|小数位`。 */
		const preciseFormatters = new Map();

		/** 千分位整数格式化器：无参数，构造一次即可。 */
		const tokenFormatter = new Intl.NumberFormat(undefined);

		/** 币种名称格式化器缓存：每次渲染都新建一个会白白付出构造开销。 */
		const currencyNames = new Map();

		/** 精确到分的金额文本（四舍五入）。 */
		function formatMoney(value, currency) {
			const code = currency ?? DEFAULT_CURRENCY;
			let formatter = moneyFormatters.get(code);
			if (formatter === undefined) {
				try {
					formatter = new Intl.NumberFormat(undefined, {
						style: "currency",
						currency: code,
						minimumFractionDigits: 2,
						maximumFractionDigits: 2,
					});
				} catch {
					formatter = null;
				}
				moneyFormatters.set(code, formatter);
			}
			if (formatter === null) return value.toFixed(2) + " " + code;
			return formatter.format(value);
		}

		/** 高精度金额文本：小于一分钱时保留到不再出现前导零为止，最多 6 位。 */
		function formatPreciseMoney(value, currency) {
			if (value === 0) return formatMoney(0, currency);
			const magnitude = Math.abs(value);
			const digits = magnitude >= 0.01 ? 4 : magnitude >= 0.0001 ? 6 : 8;
			const code = currency ?? DEFAULT_CURRENCY;
			let formatter = preciseFormatters.get(code + "|" + digits);
			if (formatter === undefined) {
				try {
					formatter = new Intl.NumberFormat(undefined, {
						style: "currency",
						currency: code,
						minimumFractionDigits: 2,
						maximumFractionDigits: digits,
					});
				} catch {
					formatter = null;
				}
				preciseFormatters.set(code + "|" + digits, formatter);
			}
			if (formatter === null) return value.toFixed(digits) + " " + code;
			return formatter.format(value);
		}

		/** 千分位整数文本。 */
		function formatTokens(value) {
			return tokenFormatter.format(Math.round(value));
		}

		/** 紧凑 token 文本：1.2M / 34.5K / 812。 */
		function formatCompactTokens(value) {
			if (value < 1000) return String(Math.round(value));
			if (value < 1000000) return (Math.round(value / 100) / 10) + "K";
			return (Math.round(value / 100000) / 10) + "M";
		}

		/** 单位价格文本：每百万 token 的金额。 */
		function formatUnitPrice(value, currency) {
			return formatPreciseMoney(value, currency) + "/M";
		}

		//#endregion

		//#region 价目表客户端
		/**
		 * 价目表读写句柄。由 `apply` 创建并注入组件，因此不是模块级单例。
		 */
		function createPricingApi() {
			let state = { status: "idle", data: null, error: null };
			const listeners = new Set();
			// 每次发起的请求各带一个代际号；只有最新一代的结果才允许落库，
			// 否则 GET 与 POST 重叠时旧快照会盖掉新结果。
			let generation = 0;
			const publish = (next) => {
				state = next;
				for (const listener of [...listeners]) listener();
			};
			const request = async (path, init) => {
				const response = await fetch(path, init);
				let body = null;
				try {
					body = await response.json();
				} catch {
					body = null;
				}
				if (!response.ok || body === null || body.ok !== true) {
					throw new Error((body && (body.message || body.error)) || "HTTP " + response.status);
				}
				return body;
			};
			return {
				get: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				/** 拉取有效价目表；`force` 为真时绕过已就绪缓存并抢占代际。 */
				async load(force) {
					// 只有 force 才抢占代际：普通加载在请求中时静默丢弃是刻意的
					// （避免重复请求），但显式重载必须能打断它。
					if (state.status === "loading" && force !== true) return;
					if (force !== true && state.status === "ready") return;
					const ticket = ++generation;
					publish({ ...state, status: "loading" });
					try {
						const body = await request(PRICING_PATH, { headers: { accept: "application/json" } });
						if (ticket !== generation) return;
						publish({ status: "ready", data: body, error: null });
					} catch (error) {
						if (ticket !== generation) return;
						publish({ status: "error", data: state.data, error: String((error && error.message) || error) });
					}
				},
				/** 覆盖保存用户价目表。 */
				async save(entries, schedules) {
					const ticket = ++generation;
					const body = await request(PRICING_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", [ACTION_HEADER]: "save" },
						body: JSON.stringify({ entries, schedules }),
					});
					if (ticket !== generation) return body;
					// 保存响应不携带路由建议，沿用上一次 GET 的结果，
					// 否则编辑一次之后 provider / model 的建议列表就空了。
					publish({ status: "ready", data: { ...body, routes: state.data?.routes ?? [] }, error: null });
					return body;
				},
				/** 删除用户价目表文件，回到内置层。 */
				async reset() {
					const ticket = ++generation;
					const body = await request(PRICING_RESET_PATH, {
						method: "POST",
						headers: { "content-type": "application/json", [ACTION_HEADER]: "reset" },
						body: "{}",
					});
					if (ticket !== generation) return body;
					publish({ status: "ready", data: { ...body, routes: state.data?.routes ?? [] }, error: null });
					return body;
				},
			};
		}

		/** 订阅价目表句柄的 React 绑定；挂载时按需触发一次加载。 */
		function usePricingState(pricing) {
			const [snapshot, setSnapshot] = useState(() => pricing.get());
			useEffect(() => {
				setSnapshot(pricing.get());
				const unsubscribe = pricing.subscribe(() => setSnapshot(pricing.get()));
				void pricing.load(false);
				return unsubscribe;
			}, [pricing]);
			return snapshot;
		}

		/** 测量阶段的占位样式：面板先以隐藏态挂载，量到尺寸后再摆正。 */
		const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };

		/** 面板与视口边缘的最小间距。 */
		const VIEWPORT_MARGIN = 12;

		/**
		 * 计算面板的固定定位坐标。
		 *
		 * 水平以锚点（pill）中线居中，再夹进视口；当面板比可用宽度还宽时以左边距
		 * 为准，宁可右侧溢出也不让左侧跑出屏幕——左边界丢失会让面板无法点击。
		 * 垂直方向贴着锚点上沿往上排。
		 * @param anchor - 锚点的视口矩形。
		 * @param panelWidth - 面板实测宽度。
		 * @param viewport - 视口尺寸。
		 * @returns 可直接写入 `style` 的 `left` / `bottom`。
		 */
		function panelPosition(anchor, panelWidth, viewport) {
			const centered = anchor.left + anchor.width / 2 - panelWidth / 2;
			const maxLeft = viewport.width - panelWidth - VIEWPORT_MARGIN;
			return {
				left: Math.max(VIEWPORT_MARGIN, Math.min(centered, Math.max(VIEWPORT_MARGIN, maxLeft))),
				bottom: Math.max(VIEWPORT_MARGIN, viewport.height - anchor.top + 8),
			};
		}

		/**
		 * 把 pill 的屏幕位置换算成固定定位面板的坐标。
		 *
		 * 面板水平**以 pill 中线居中**，因此必须知道面板自身的宽度，而宽度又由
		 * 内容与当前标签页决定（明细窄、价格设置宽）。做法与官方 stat-dialog 一致：
		 * 面板先以 {@link MEASURE_STYLE} 挂载，测量后再写入最终坐标，避免出现
		 * 一次可见的错位跳动。
		 * @param open - 面板是否打开。
		 * @param anchorRef - pill 的 ref。
		 * @param panelRef - 面板的 ref。
		 * @param revision - 会改变面板宽度的依赖（如当前标签页）。
		 * @returns 固定定位坐标，测量完成前为 null。
		 */
		function useAnchoredPosition(open, anchorRef, panelRef, revision) {
			const [position, setPosition] = useState(null);
			useLayoutEffect(() => {
				if (!open) {
					setPosition(null);
					return;
				}
				const measure = () => {
					const rect = anchorRef.current?.getBoundingClientRect();
					if (rect === undefined || rect === null) return;
					setPosition(panelPosition(
						rect,
						panelRef.current?.offsetWidth ?? 0,
						{ width: window.innerWidth, height: window.innerHeight },
					));
				};
				measure();
				window.addEventListener("resize", measure);
				window.addEventListener("scroll", measure, true);
				// 明细页宽度是 max-content：会话继续跑时模型增多会把面板撑宽，
				// 只看窗口尺寸变化不够，必须盯面板自身的尺寸。
				const observer = typeof ResizeObserver === "function"
					? new ResizeObserver(measure)
					: null;
				if (observer !== null && panelRef.current !== null) observer.observe(panelRef.current);
				return () => {
					window.removeEventListener("resize", measure);
					window.removeEventListener("scroll", measure, true);
					observer?.disconnect();
				};
			}, [open, anchorRef, panelRef, revision]);
			return position;
		}

		/**
		 * 事件目标是否落在给定的任一根节点内。
		 *
		 * 面板经 portal 渲染到 `document.body`，不在锚点的 DOM 子树里，因此
		 * 「点击外部关闭」必须同时把锚点和面板都当成内部，否则面板里的每一次
		 * 点击（标签切换、输入、按钮）都会先把它关掉。
		 * @param target - 事件目标。
		 * @param roots - 需要视为内部的 ref 列表。
		 * @returns 目标落在任一根节点内时为 true。
		 */
		function isInsideRoots(target, roots) {
			if (target === null || target === undefined) return false;
			for (const root of roots) {
				const node = root?.current;
				if (node === null || node === undefined) continue;
				if (typeof node.contains === "function" && node.contains(target)) return true;
			}
			return false;
		}

		/**
		 * 打开期间监听外部点击与 Escape。
		 *
		 * 面板经 portal 渲染到 `document.body`，不在锚点的 DOM 子树里，因此
		 * 「点击外部关闭」必须同时把锚点和面板都当成内部，否则面板里的每一次
		 * 点击（标签切换、输入、按钮）都会先把它关掉。
		 *
		 * `overlayRef` 记录面板内当前展开的候选列表数量。这些列表由 Menu 自己
		 * portal 到 body 并自行处理外部点击，面板必须在这期间让位，否则选中一个
		 * 候选的那次点击会先把整个面板关掉。
		 * @param open - 面板是否打开。
		 * @param onClose - 关闭回调。
		 * @param roots - 需要视为内部的 ref 列表。
		 * @param overlayRef - 面板内展开的浮层计数。
		 */
		function useDismiss(open, onClose, roots, overlayRef) {
			useEffect(() => {
				if (!open) return;
				const onPointerDown = (event) => {
					if ((overlayRef?.current ?? 0) > 0) return;
					if (isInsideRoots(event.target, roots)) return;
					onClose();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") onClose();
				};
				document.addEventListener("pointerdown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open, onClose, roots, overlayRef]);
		}

		/**
		 * 每秒推进一次的当前时间戳。
		 *
		 * `active` 为假时不挂计时器：统一单价的会话没有倒计时可显示，让胶囊每秒
		 * 重渲染纯属浪费。
		 * @param active - 是否需要持续走时。
		 * @returns 最近一次的当前时间戳。
		 */
		function useNow(active) {
			const [now, setNow] = useState(() => Date.now());
			useEffect(() => {
				if (!active) return;
				setNow(Date.now());
				const timer = setInterval(() => setNow(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [active]);
			return now;
		}

		//#endregion

		//#region 费用明细
		/** 一个模型卡片：分桶的 token 数与金额。 */
		function ModelCard({ item, currency, t }) {
			const rows = BUCKETS.filter((bucket) => bucket !== "cacheWrite" || item.buckets[bucket] > 0);
			return el("div", { className: S.card },
				el("div", { className: S.cardHead },
					el("span", { className: S.model, title: item.model }, item.model),
					el("span", {
						className: S.cardAmount,
						"data-unpriced": item.priced ? undefined : "true",
					}, item.priced ? formatPreciseMoney(item.amount, item.currency ?? currency) : t("detail.unpriced")),
				),
				el("div", { className: S.rows },
					rows.flatMap((bucket) => [
						el("span", { key: bucket + "-l", className: S.rowLabel }, t("bucket." + bucket)),
						el("span", { key: bucket + "-n", className: S.rowTokens }, formatTokens(item.buckets[bucket])),
						el("span", { key: bucket + "-c", className: S.rowCost },
							item.priced ? formatPreciseMoney(item.amounts[bucket], item.currency ?? currency) : "—"),
					]),
				),
				el("div", { className: S.badges },
					item.priced && item.entry !== null && item.entry.prices.offPeak !== undefined
						? el("span", { className: S.badge }, t("detail.tariffSplit"))
						: null,
					item.priced && item.entry !== null && item.entry.provider === "*"
						? el("span", { className: S.badge }, t("detail.wildcard"))
						: null,
					item.priced ? null : el("span", { className: S.badge, "data-warn": "true" }, t("detail.noPrice")),
				),
			);
		}

		/** 费用明细视图。 */
		function FeeDetail({ view, t, pricingError, onConfigure }) {
			if (view.groups.length === 0) {
				return el("div", null,
					pricingError === null ? null : el("p", { className: S.error }, pricingError),
					el("p", { className: S.empty }, t("detail.empty")),
				);
			}
			return el("div", null,
				pricingError === null ? null : el("p", { className: S.error }, pricingError),
				el("div", { className: S.total },
					el("div", null,
						el("div", { className: S.totalLabel }, t("detail.totalLabel")),
						el("div", { className: S.totalExact }, t("detail.totalExact", { value: formatPreciseMoney(view.amount, view.currency), tokens: formatTokens(view.tokens) })),
					),
					el("div", { className: S.totalValue }, formatMoney(view.amount, view.currency)),
				),
				view.unpricedCount > 0
					? el("p", { className: S.note },
						t("detail.unpricedNote", { count: view.unpricedCount }),
						el(Button, { variant: "outline", size: "sm", onClick: onConfigure, style: { marginLeft: "8px" } }, t("detail.configure")))
					: null,
				view.mixedCurrency
					? el("p", { className: S.note }, t("detail.mixedCurrency", {
						value: Object.entries(view.byCurrency)
							.filter(([code, amount]) => code !== view.currency && amount > 0)
							.map(([code, amount]) => formatPreciseMoney(amount, code))
							.join(t("editor.listSeparator")),
					}))
					: null,
				view.groups.map((group) => el("div", { key: group.provider, className: S.group },
					el("div", { className: S.groupHead },
						el("span", { className: S.groupName }, group.provider),
						el("span", { className: S.groupMeta }, t("detail.groupMeta", {
							tokens: formatCompactTokens(group.tokens),
							value: formatPreciseMoney(group.amount, view.currency),
						})),
					),
					group.models.map((item) => el(ModelCard, { key: item.model, item, currency: view.currency, t })),
				)),
			);
		}

		//#endregion

		//#region 价格编辑器
		/** 星期标签，索引与 `Date.getDay()` 一致。 */
		const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

		/**
		 * 新建条目的默认形状：默认不分峰谷。
		 *
		 * 不预设 `schedule`：新条目只填一条统一单价，强绑一个峰谷规则会让用户
		 * 在没填空闲价的情况下白得一个用不上的规则。用户勾选「区分峰谷」时
		 * 才由 {@link toggleSplit} 关联规则。
		 */
		function blankEntry() {
			return {
				id: "custom-" + Math.random().toString(36).slice(2, 10),
				provider: "deepseek-official",
				model: "",
				currency: DEFAULT_CURRENCY,
				schedule: null,
				prices: {
					peak: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
				},
			};
		}

		/** 深拷贝一个条目，避免编辑器直接改写 store 里的冻结对象。 */
		function cloneEntry(entry) {
			return {
				id: entry.id,
				provider: entry.provider,
				model: entry.model,
				currency: entry.currency,
				schedule: entry.schedule === null || entry.schedule === undefined ? null : entry.schedule,
				note: entry.note,
				source: entry.source,
				prices: {
					peak: { ...entry.prices.peak },
					...(entry.prices.offPeak === undefined ? {} : { offPeak: { ...entry.prices.offPeak } }),
				},
			};
		}

		/**
		 * 把用户文件的条目与调度装载成编辑草稿。
		 *
		 * **必须传原始层**（`file.rawEntries`），不能传归一化层：host 归一化时会把
		 * `schedule: "my-peak"` 展开成内联对象，拿它当草稿会让命名引用每次往返都被
		 * 改写成新的 `inline-N` 副本，同一条规则按条目数复制，且 `schedules` 里真正
		 * 被引用的名字被逐个丢弃。原始层不存在时（旧 host）退回归一化层。
		 * @param file - 端点的 `file` 段落。
		 * @returns `{ entries, schedules }` 编辑草稿。
		 */
		function adoptFileLayer(file) {
			const source = file?.rawEntries ?? file?.entries;
			return adoptPricing(source, file?.schedules);
		}

		/**
		 * 把条目与调度装载成编辑草稿。
		 *
		 * 内联调度对象无法在下拉框里表达，因此为它生成一个命名规则并让条目改为
		 * 引用该名字，用户仍能在界面上编辑它，而不是在保存时悄悄丢掉。两种条目
		 * 不做这个提升：命名引用已经可以直接编辑；没有空闲价的条目用不到峰谷
		 * 判定，提升只会凭空造出一个 `inline-N` 规则。
		 * @param fileEntries - 用户文件条目（优先原始层）。
		 * @param fileSchedules - 用户文件的命名调度表。
		 * @returns `{ entries, schedules }`。
		 */
		function adoptPricing(fileEntries, fileSchedules) {
			const schedules = { ...(fileSchedules ?? {}) };
			const entries = (fileEntries ?? []).map((entry) => {
				const clone = cloneEntry(entry);
				if (clone.schedule === null || typeof clone.schedule === "string") return clone;
				if (clone.prices.offPeak === undefined) return { ...clone, schedule: null };
				let index = Object.keys(schedules).length + 1;
				let name = "inline-" + index;
				while (schedules[name] !== undefined) name = "inline-" + (++index);
				schedules[name] = clone.schedule;
				return { ...clone, schedule: name };
			});
			return { entries, schedules };
		}

		/** 新建调度规则的默认形状（与内置 DeepSeek 规则一致，便于直接改）。 */
		function blankSchedule() {
			return {
				timezone: "Asia/Shanghai",
				peakDays: [1, 2, 3, 4, 5],
				peakWindows: [["09:00", "12:00"], ["14:00", "18:00"]],
			};
		}

		/** 运行时无法枚举货币时的回退列表。 */
		const FALLBACK_CURRENCIES = ["CNY", "USD", "EUR", "JPY", "HKD", "GBP", "KRW", "SGD", "AUD", "CAD", "CHF", "TWD"];

		/** 运行时无法枚举时区时的回退列表。 */
		const FALLBACK_TIMEZONES = [
			"UTC", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul",
			"Asia/Singapore", "Asia/Bangkok", "Asia/Kolkata", "Asia/Dubai",
			"Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
			"America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Sao_Paulo",
			"Australia/Sydney", "Pacific/Auckland",
		];

		/** 可用时区列表，惰性求值一次。 */
		let timezoneList = null;

		/** 时区 → 当前 UTC 偏移（分钟）；惰性填充，`null` 表示无法解析。 */
		const timezoneOffsets = new Map();

		/**
		 * 取某时区当前的 UTC 偏移（分钟）。
		 *
		 * 偏移随夏令时变化，因此按调用时刻计算；结果缓存到会话结束，
		 * 一次枚举 400 余个时区约 30ms，只在首次排序与渲染标签时付出。
		 * @param zone - IANA 时区名。
		 * @returns 相对 UTC 的分钟偏移，无法解析时为 null。
		 */
		function timezoneOffsetMinutes(zone) {
			if (timezoneOffsets.has(zone)) return timezoneOffsets.get(zone);
			let minutes = null;
			try {
				const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(new Date());
				const name = parts.find(part => part.type === "timeZoneName")?.value ?? "";
				const match = /GMT([+-])(\d{1,2}):(\d{2})/.exec(name);
				if (match === null) minutes = name === "GMT" ? 0 : null;
				else minutes = (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
			} catch {
				minutes = null;
			}
			timezoneOffsets.set(zone, minutes);
			return minutes;
		}

		/**
		 * 取按 UTC 偏移升序排列的可用时区列表，惰性求值一次。
		 *
		 * ICU 的枚举是字母序，跨时区查找时很别扭；这里改为按偏移排列，
		 * 同一偏移内按名字排序并让 `UTC` 居首，便于按「差几个小时」定位。
		 * 运行时不提供枚举时退回常见时区，同样按偏移排列。
		 */
		function supportedTimezones() {
			if (timezoneList === null) {
				let zones;
				try {
					// ICU 的枚举里没有裸 `UTC`（只有 Etc/UTC 之类），但它是合法的
					// 时区标识且最常用，因此显式加入。
					zones = typeof Intl.supportedValuesOf === "function"
						? ["UTC", ...Intl.supportedValuesOf("timeZone")]
						: FALLBACK_TIMEZONES;
				} catch {
					zones = FALLBACK_TIMEZONES;
				}
				timezoneList = [...new Set(zones)].sort((a, b) => {
					const diff = (timezoneOffsetMinutes(a) ?? 0) - (timezoneOffsetMinutes(b) ?? 0);
					if (diff !== 0) return diff;
					if (a === "UTC") return -1;
					if (b === "UTC") return 1;
					return a.localeCompare(b);
				});
			}
			return timezoneList;
		}

		/** 时区选项文本：名字加当前 UTC 偏移，便于辨认。 */
		function timezoneLabel(zone) {
			const minutes = timezoneOffsetMinutes(zone);
			if (minutes === null) return zone;
			const sign = minutes < 0 ? "-" : "+";
			const absolute = Math.abs(minutes);
			const hours = Math.floor(absolute / 60);
			const rest = absolute % 60;
			return zone + " (GMT" + sign + hours + (rest === 0 ? "" : ":" + String(rest).padStart(2, "0")) + ")";
		}

		/** 货币代码列表，惰性求值一次；`CNY` 排首位，其余按代码排序。 */
		let currencyList = null;

		/** 取 ISO 4217 货币代码列表；运行时不提供枚举时退回常见币种。 */
		function supportedCurrencies() {
			if (currencyList === null) {
				try {
					const list = typeof Intl.supportedValuesOf === "function"
						? Intl.supportedValuesOf("currency")
						: FALLBACK_CURRENCIES;
					currencyList = [...new Set([DEFAULT_CURRENCY, ...list])];
				} catch {
					currencyList = [...new Set([DEFAULT_CURRENCY, ...FALLBACK_CURRENCIES])];
				}
			}
			return currencyList;
		}

		/** 币种选项：文件里的自定义代码会补进列表，避免选择时被丢掉。 */
		function currencyOptions(current) {
			const list = supportedCurrencies();
			return current === "" || list.includes(current) ? list : [current, ...list];
		}

		/** 币种选项文本：代码加本地化名称，便于辨认。 */
		function currencyLabel(code) {
			if (currencyNames.has(code)) return currencyNames.get(code);
			let label = code;
			try {
				const name = new Intl.DisplayNames(undefined, { type: "currency" }).of(code);
				if (name !== undefined && name !== code) label = code + " " + name;
			} catch {
				label = code;
			}
			currencyNames.set(code, label);
			return label;
		}

		/** 时区下拉框；文件里的自定义时区会补进选项，避免选择时被丢掉。 */		function TimezoneSelect({ value, onChange }) {
			const options = useMemo(() => {
				const list = supportedTimezones();
				return list.includes(value) ? list : [value, ...list];
			}, [value]);
			return el("select", {
				className: S.select,
				value,
				onChange: (event) => onChange(event.target.value),
			}, options.map(zone => el("option", { key: zone, value: zone }, timezoneLabel(zone))));
		}

		/**
		 * 把价格草稿转成可展示的数字。
		 *
		 * 编辑器里的草稿是字符串（可能是「1.」这样的中间态），而内置条目来自
		 * host，本来就是数字。展示层两者都要能吃下，非法值返回 null 由调用方
		 * 显示占位符，而不是把 NaN 印到界面上。
		 * @param raw - 价格草稿。
		 * @returns 有限非负数字，或 null。
		 */
		function priceNumber(raw) {
			if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
			const text = String(raw ?? "").trim();
			if (text === "") return null;
			const value = Number(text);
			return Number.isFinite(value) && value >= 0 ? value : null;
		}

		/**
		 * 单价表格：列是四个计费桶，行是高峰与空闲；条目没有空闲价时只有一行。
		 */
		function PriceTable({ entry, t }) {
			const rows = entry.prices.offPeak === undefined
				? [["editor.tariffFlat", entry.prices.peak]]
				: [["editor.tariffPeak", entry.prices.peak], ["editor.tariffOffPeak", entry.prices.offPeak]];
			return el("div", { className: S.priceTable },
				el("span", { className: S.priceHead }, ""),
				BUCKETS.map(bucket => el("span", { key: bucket, className: S.priceHead }, t("bucket." + bucket))),
				rows.flatMap(([labelKey, prices]) => [
					el("span", { key: labelKey + "-label", className: S.priceRowLabel }, t(labelKey)),
					...BUCKETS.map((bucket) => {
						const value = priceNumber(prices[bucket]);
						return el("span", {
							key: labelKey + "-" + bucket,
							className: S.priceValue,
						}, value === null ? t("editor.invalidPriceShort") : formatUnitPrice(value, entry.currency));
					}),
				]),
			);
		}

		/**
		 * 只读价目卡片：内置条目与已保存的自定义条目共用同一种呈现。
		 *
		 * 自定义条目保存后收敛成这个形态，需要改动时再点「编辑」展开表单，
		 * 因此列表始终是紧凑可读的，而不是一排常开的输入框。
		 * @param props.entry - 归一化后的条目（价格可能是草稿字符串）。
		 * @param props.badge - 右上角的身份标记。
		 * @param props.actions - 右下角的操作按钮。
		 * @param props.t - 本地化函数。
		 */
		function PriceCard({ entry, badge, actions, t }) {
			return el("div", { className: S.card },
				el("div", { className: S.entryHead },
					el("span", { className: S.entryName }, entry.provider + " / " + entry.model),
					el("span", { className: S.entryScope }, badge),
				),
				el(PriceTable, { entry, t }),
				el("div", { className: S.cardFoot },
					el("span", { className: S.note }, entry.note ?? ""),
					el("span", { className: S.cardActions }, actions),
				),
			);
		}

		/** 价格输入：草稿保持字符串，非法输入就地标红提示。 */
		function NumberInput({ value, onChange, label, invalidHint }) {
			const text = String(value ?? "");
			const invalid = priceNumber(text) === null && text.trim() !== "";
			return el("label", { className: S.field },
				el("span", { className: S.fieldLabel }, label),
				el("input", {
					className: S.input,
					type: "text",
					inputMode: "decimal",
					value: text,
					"data-invalid": invalid ? "true" : undefined,
					title: invalid ? invalidHint : undefined,
					onChange: (event) => onChange(event.target.value),
				}),
			);
		}

		/** 四个价格桶的输入组。 */
		function PriceGrid({ prices, onChange, t }) {
			return el("div", { className: S.grid4 },
				BUCKETS.map((bucket) => el(NumberInput, {
					key: bucket,
					label: t("bucket." + bucket),
					value: prices[bucket] ?? "",
					onChange: (raw) => onChange(bucket, raw),
					invalidHint: t("editor.invalidPriceHint"),
				})),
			);
		}

		/**
		 * 找出 host 必然拒绝、但界面允许构造的状态。
		 *
		 * 这些状态都点得出来：删光条目、新增条目直接保存、勾了「区分峰谷」又把
		 * 规则选回「不区分」。不先拦下的话，用户只能看到 host 抛出的技术报错。
		 * @param entries - 当前编辑草稿。
		 * @param t - 本地化函数。
		 * @returns 问题描述列表，全部合法时为空数组。
		 */
		function collectProblems(entries, t) {
			const problems = [];
			if (entries.length === 0) problems.push(t("editor.errorNoEntries"));
			for (const entry of entries) {
				const provider = entry.provider.trim() === "" ? "*" : entry.provider.trim();
				const model = entry.model.trim();
				const label = provider + " / " + (model === "" ? t("editor.untitledModel") : model);
				if (model === "") problems.push(t("editor.errorNoModel", { entry: label }));
				if (entry.prices.offPeak !== undefined && (entry.schedule === null || entry.schedule === "")) {
					problems.push(t("editor.errorNoSchedule", { entry: label }));
				}
			}
			return problems;
		}

		/**
		 * 把一次价格输入落到草稿上。
		 *
		 * 原样保留字符串，不做数字转换：输入「1.」时 `Number("1.")` 得到 1，
		 * 小数点会被吞掉，用户因此根本敲不出小数。转换与校验在保存时进行。
		 * @param prices - 当前价格草稿。
		 * @param tariff - `peak` 或 `offPeak`。
		 * @param bucket - 计费桶名。
		 * @param raw - 输入框的原始文本。
		 * @returns 新的价格草稿。
		 */
		function applyPriceDraft(prices, tariff, bucket, raw) {
			return { ...prices, [tariff]: { ...prices[tariff], [bucket]: raw } };
		}

		/**
		 * 把编辑器里的价格草稿转成数字，无法解析的输入就地归零。
		 *
		 * 价格表是人工维护的，一个笔误不该阻塞整次保存、连带其它条目一起丢掉。
		 * 因此非法值按 0 写入，并把被归零的桶报回给调用方提示用户；保存成功后
		 * 草稿会从文件重新装载，输入框随即显示被修正后的 0。
		 * @param block - 四个桶的草稿值（字符串或数字）。
		 * @returns `{ prices, corrected }`，`corrected` 是被归零的桶名。
		 */
		function toPriceBlock(block) {
			const prices = {};
			const corrected = [];
			for (const bucket of BUCKETS) {
				const text = String(block[bucket] ?? "").trim();
				if (text === "") {
					prices[bucket] = 0;
					continue;
				}
				const value = Number(text);
				if (!Number.isFinite(value) || value < 0) {
					prices[bucket] = 0;
					corrected.push(bucket);
					continue;
				}
				prices[bucket] = value;
			}
			return { prices, corrected };
		}

		/**
		 * provider / model 选择框：官方 Menu 皮肤的下拉列表 + 自由输入。
		 *
		 * adapter 允许接受未列出的模型 id，所以输入必须保持自由；下拉只是把当前
		 * dsh 配置里已有的路由与模型变成可点选项。列表用 ui-primitives 的 Menu
		 * （与其它下拉同一套皮肤、定位与外部点击行为），触发器是一个带箭头的输入
		 * 框，点箭头开列表、直接输入则按原文生效。
		 * @param props.label - 字段名。
		 * @param props.value - 当前值。
		 * @param props.onChange - 值变更回调。
		 * @param props.options - 建议选项。
		 * @param props.placeholder - 输入占位文本。
		 * @param props.emptyHint - 没有建议时列表里显示的说明。
		 * @param props.onOverlayToggle - 展开/收起列表时通知外层，让外层面板在这期间
		 *   让出外部点击处理：Menu 的列表经 portal 渲染到 body，外层面板的关闭判定
		 *   会把它当成「面板之外」，从而在选中候选的那一次点击上先关掉整个面板。
		 * @param props.t - 本地化函数。
		 */
		function RouteField({ label, value, onChange, options, placeholder, emptyHint, onOverlayToggle, t }) {
			const [open, setOpen] = useState(false);
			// 用 effect 而不是在事件里配对增减：Menu 自己也会因外部点击或 Escape
			// 关闭，只有跟随 open 状态才能保证计数不会漏减。
			useEffect(() => {
				if (!open) return;
				onOverlayToggle?.(true);
				return () => onOverlayToggle?.(false);
			}, [open, onOverlayToggle]);
			const items = options.length === 0
				? [{ type: "label", id: "empty", text: emptyHint }]
				: options.map(option => ({ id: option, label: option }));
			return el("div", { className: S.field },
				el("span", { className: S.fieldLabel }, label),
				el(Menu, {
					open,
					items,
					selectedId: options.includes(value) ? value : undefined,
					onSelect: (id) => {
						onChange(id);
						setOpen(false);
					},
					onClose: () => setOpen(false),
					align: "start",
					portal: true,
					compact: true,
					className: S.menuList,
					anchor: el("span", { className: S.combo },
						el("input", {
							className: S.comboInput,
							type: "text",
							value,
							placeholder,
							onChange: (event) => onChange(event.target.value),
						}),
						el("button", {
							type: "button",
							className: S.comboToggle,
							"aria-haspopup": "listbox",
							"aria-expanded": open,
							"aria-label": t("editor.toggleOptions", { label }),
							onClick: () => setOpen(!open),
						}, el(IconChevronDownOutline14, null)),
					),
				}),
			);
		}

		/** 单条价目的编辑卡片。 */
		function EntryEditor({ entry, index, scheduleNames, routes, onOverlayToggle, onChange, onRemove, onCollapse, t }) {
			const split = entry.prices.offPeak !== undefined;
			const update = (patch) => onChange(index, { ...entry, ...patch });
			const updatePrices = (tariff, bucket, raw) => {
				onChange(index, { ...entry, prices: applyPriceDraft(entry.prices, tariff, bucket, raw) });
			};
			const toggleSplit = (enabled) => {
				const next = { ...entry.prices };
				let schedule = entry.schedule;
				if (enabled) {
					next.offPeak = { ...entry.prices.peak };
					if (schedule === null || schedule === "") schedule = scheduleNames[0] ?? null;
				} else {
					// 取消峰谷后清掉引用，否则条目会继续挂着一个用不到的规则。
					delete next.offPeak;
					schedule = null;
				}
				onChange(index, { ...entry, schedule, prices: next });
			};
			// provider 一旦匹配上已配置的路由，模型建议就收窄到该路由的模型；
			// 未匹配时退回全部模型，保持「先填模型再填 provider」也能用。
			const matched = routes.find(route => route.id === entry.provider);
			const providerOptions = routes.map(route => route.id);
			const modelOptions = matched === undefined
				? [...new Set(routes.flatMap(route => route.models.map(model => model.id)))]
				: matched.models.map(model => model.id);
			return el("div", { className: S.card },
				el("div", { className: S.entryHead },
					el("span", { className: S.entryName }, entry.model === "" ? t("editor.newEntry") : entry.model),
					el("span", { className: S.panelActions },
						el(Button, {
							variant: "ghost",
							size: "sm",
							onClick: () => onCollapse(index),
						}, t("editor.collapse")),
						el("button", { type: "button", className: S.iconButton, title: t("editor.remove"), onClick: () => onRemove(index) }, "✕"),
					),
				),
				el("div", { className: S.grid2 },
					el(RouteField, {
						label: t("editor.provider"),
						value: entry.provider,
						onChange: (next) => update({ provider: next }),
						options: providerOptions,
						placeholder: "deepseek-official",
						emptyHint: t("editor.noProviderOptions"),
						onOverlayToggle,
						t,
					}),
					el(RouteField, {
						label: t("editor.model"),
						value: entry.model,
						onChange: (next) => update({ model: next }),
						options: modelOptions,
						placeholder: "deepseek-flash",
						emptyHint: t("editor.noModelOptions"),
						onOverlayToggle,
						t,
					}),
				),
				el("div", { className: S.grid2, style: { marginTop: "6px" } },
					el("label", { className: S.field },
						el("span", { className: S.fieldLabel }, t("editor.currency")),
						el("select", {
							className: S.select,
							value: entry.currency,
							onChange: (event) => update({ currency: event.target.value }),
						}, currencyOptions(entry.currency).map(code => el("option", { key: code, value: code }, currencyLabel(code)))),
					),
					el("label", { className: S.field },
						el("span", { className: S.fieldLabel }, t("editor.schedule")),
						el("select", {
							className: S.select,
							disabled: !split,
							value: entry.schedule ?? "",
							onChange: (event) => update({ schedule: event.target.value === "" ? null : event.target.value }),
						},
							el("option", { value: "" }, t("editor.scheduleNone")),
							scheduleNames.map((name) => el("option", { key: name, value: name }, name)),
						),
					),
				),
				el("div", { className: S.section },
					el("div", { className: S.sectionTitle }, split ? t("editor.peakPrices") : t("editor.prices")),
					el("div", { style: { marginTop: "5px" } },
						el(PriceGrid, {
							prices: entry.prices.peak,
							onChange: (bucket, raw) => updatePrices("peak", bucket, raw),
							t,
						}),
					),
				),
				el("label", { className: S.checkRow, style: { marginTop: "8px" } },
					el("input", {
						type: "checkbox",
						checked: split,
						onChange: (event) => toggleSplit(event.target.checked),
					}),
					t("editor.splitTariff"),
				),
				split
					? el("div", { className: S.section },
						el("div", { className: S.sectionTitle }, t("editor.offPeakPrices")),
						el("div", { style: { marginTop: "5px" } },
							el(PriceGrid, {
								prices: entry.prices.offPeak,
								onChange: (bucket, raw) => updatePrices("offPeak", bucket, raw),
								t,
							}),
						),
					)
					: null,
			);
		}

		/** 命名调度规则的编辑卡片。 */
		function ScheduleEditor({ name, schedule, onChange, onRemove, builtin, t }) {
			const toggleDay = (day) => {
				const days = schedule.peakDays.includes(day)
					? schedule.peakDays.filter((value) => value !== day)
					: [...schedule.peakDays, day].sort((a, b) => a - b);
				onChange({ ...schedule, peakDays: days });
			};
			const setWindow = (index, side, value) => {
				const windows = schedule.peakWindows.map((window, position) => (
					position === index ? (side === 0 ? [value, window[1]] : [window[0], value]) : window
				));
				onChange({ ...schedule, peakWindows: windows });
			};
			return el("div", { className: S.card },
				el("div", { className: S.entryHead },
					el("span", { className: S.entryName }, name),
					el("span", { className: S.panelActions },
						builtin ? el("span", { className: S.entryScope }, t("editor.builtinSchedule")) : null,
						builtin ? null : el("button", { type: "button", className: S.iconButton, title: t("editor.remove"), onClick: onRemove }, "✕"),
					),
				),
				el("div", { className: S.grid2 },
					el("label", { className: S.field },
						el("span", { className: S.fieldLabel }, t("editor.timezone")),
						el(TimezoneSelect, {
							value: schedule.timezone,
							onChange: (zone) => onChange({ ...schedule, timezone: zone }),
						}),
					),
					el("div", { className: S.field },
						el("span", { className: S.fieldLabel }, t("editor.peakDays")),
						el("div", { className: S.days },
							WEEKDAY_KEYS.map((key, day) => el("button", {
								key,
								type: "button",
								className: S.day,
								"data-active": schedule.peakDays.includes(day) ? "true" : undefined,
								onClick: () => toggleDay(day),
							}, t("weekday." + key))),
						),
					),
				),
				el("div", { className: S.section },
					el("div", { className: S.sectionTitle }, t("editor.peakWindows")),
					el("div", { className: S.windows, style: { marginTop: "5px" } },
						schedule.peakWindows.map((window, index) => el("div", { key: index, className: S.window },
							el("input", {
								className: S.input,
								type: "text",
								value: window[0],
								placeholder: "09:00",
								onChange: (event) => setWindow(index, 0, event.target.value),
							}),
							el("span", { className: S.windowDash }, "–"),
							el("input", {
								className: S.input,
								type: "text",
								value: window[1],
								placeholder: "12:00",
								onChange: (event) => setWindow(index, 1, event.target.value),
							}),
							el("button", {
								type: "button",
								className: S.iconButton,
								title: t("editor.remove"),
								onClick: () => onChange({
									...schedule,
									peakWindows: schedule.peakWindows.filter((_, position) => position !== index),
								}),
							}, "✕"),
						)),
					),
					el(Button, {
						variant: "outline",
						size: "sm",
						style: { marginTop: "6px" },
						onClick: () => onChange({ ...schedule, peakWindows: [...schedule.peakWindows, ["09:00", "12:00"]] }),
					}, t("editor.addWindow")),
				),
			);
		}

		/**
		 * 价格与峰谷规则编辑器。
		 *
		 * 编辑草稿只在保存时写回 host，因此内置条目始终只读展示，
		 * 用户文件承载全部改动。
		 */
		function PricingEditor({ pricing, t, onOverlayToggle }) {
			const store = usePricingState(pricing);
			const data = store.data;
			const [busy, setBusy] = useState(false);
			const [message, setMessage] = useState(null);
			/** 上一条提示是否为「非法输入已归零」的警示。 */
			const [corrected, setCorrected] = useState(false);
			const [failure, setFailure] = useState(null);
			// 草稿为 null 表示尚未编辑，直接展示从文件装载的内容。
			//
			// 用派生值而不是在 effect 里 setState：effect 在服务端渲染下不执行，
			// 首帧会渲染成空编辑器；渲染期 setState 在服务端渲染下同样不会重渲染。
			const [draft, setDraft] = useState(null);
			const loaded = useMemo(
				() => (data === null ? null : adoptFileLayer(data.file)),
				[data],
			);
			const entries = draft === null ? (loaded?.entries ?? []) : draft.entries;
			const schedules = draft === null ? (loaded?.schedules ?? {}) : draft.schedules;
			// 正在展开编辑的条目 id。其余条目收敛成只读价目卡片，与内置条目同一形态。
			const [editingIds, setEditingIds] = useState(() => new Set());
			// 单桶更新各自只改一个字段，避免两次 setDraft 互相覆盖。
			const setEntries = (next) => setDraft({ entries: next, schedules });
			const setSchedules = (next) => setDraft({ entries, schedules: next });
			/** 重新装载草稿：丢弃本地编辑并拉取最新文件内容。 */
			const reload = useCallback(async (force) => {
				setDraft(null);
				setFailure(null);
				setMessage(null);
				setCorrected(false);
				await pricing.load(force === true);
			}, [pricing]);
			const builtinNames = Object.keys(data?.builtinSchedules ?? {});
			const scheduleNames = [...new Set([...builtinNames, ...Object.keys(schedules)])];
			/** 当前已配置的路由，供 provider / model 输入做建议；缺失时退化为纯输入。 */
			const routes = data?.routes ?? [];
			/** 展开一条条目的编辑表单。 */
			const startEditing = (id) => setEditingIds(previous => new Set(previous).add(id));
			/** 收起一条条目的编辑表单，回到只读卡片。 */
			const stopEditing = (id) => setEditingIds((previous) => {
				const next = new Set(previous);
				next.delete(id);
				return next;
			});
			const save = async () => {
				setBusy(true);
				setFailure(null);
				setMessage(null);
				setCorrected(false);
				// host 的校验是 fail-loud 的（正确），但界面上这些状态都点得出来，
				// 撞上去只能看到 host 的中文技术报错。在本地先拦下并说清哪里不对。
				const problems = collectProblems(entries, t);
				if (problems.length > 0) {
					setFailure(problems.join(t("editor.listSeparator")));
					setBusy(false);
					return;
				}
				try {
					// 被归零的非法输入，用于保存后提示用户。
					const corrected = [];
					// 只有真正带空闲价的条目才写 schedule：没有 offPeak 的条目用不到
					// 峰谷判定，留着引用会在文件里留下一条无意义的规则关联。
					const payload = entries.map((entry) => {
						const provider = entry.provider.trim() === "" ? "*" : entry.provider.trim();
						const model = entry.model.trim();
						const label = provider + " / " + (model === "" ? t("editor.untitledModel") : model);
						const split = entry.prices.offPeak !== undefined;
						const schedule = split ? entry.schedule : null;
						const peak = toPriceBlock(entry.prices.peak);
						const offPeak = split ? toPriceBlock(entry.prices.offPeak) : null;
						for (const bucket of [...peak.corrected, ...(offPeak?.corrected ?? [])]) {
							corrected.push(label + " · " + t("bucket." + bucket));
						}
						return {
							id: entry.id,
							provider,
							model,
							currency: entry.currency.trim() === "" ? DEFAULT_CURRENCY : entry.currency.trim().toUpperCase(),
							...(schedule === null || schedule === "" ? {} : { schedule }),
							prices: {
								peak: peak.prices,
								...(offPeak === null ? {} : { offPeak: offPeak.prices }),
							},
							...(entry.note === undefined ? {} : { note: entry.note }),
							...(entry.source === undefined ? {} : { source: entry.source }),
						};
					});
					// 只提交仍被引用的规则，避免文件里堆积孤儿规则。
					const referenced = new Set(payload.map(entry => entry.schedule).filter(Boolean));
					const keptSchedules = Object.fromEntries(
						Object.entries(schedules).filter(([name]) => referenced.has(name)),
					);
					const body = await pricing.save(payload, Object.keys(keptSchedules).length === 0 ? null : keptSchedules);
					setDraft(adoptFileLayer(body.file));
					// 保存后全部收敛成只读卡片：列表回到紧凑可读的形态，
					// 与内置条目一致，需要再改时重新点「编辑」。
					setEditingIds(new Set());
					setMessage(corrected.length === 0
						? t("editor.saved")
						: t("editor.savedWithCorrections", { fields: corrected.join(t("editor.listSeparator")) }));
					setCorrected(corrected.length > 0);
				} catch (error) {
					setFailure(String((error && error.message) || error));
				} finally {
					setBusy(false);
				}
			};
			const reset = async () => {
				setBusy(true);
				setFailure(null);
				setMessage(null);
				setCorrected(false);
				try {
					const body = await pricing.reset();
					setDraft(adoptFileLayer(body.file));
					setMessage(t("editor.reset"));
				} catch (error) {
					setFailure(String((error && error.message) || error));
				} finally {
					setBusy(false);
				}
			};
			if (data === null) {
				// 首次拉取失败时必须把原因露出来，否则设置页永远停在「正在读取」，
				// 用户无从判断是端点被拒还是网络断了。
				return el("div", null,
					el("p", { className: S.empty }, t("editor.loading")),
					store.error !== null ? el("p", { className: S.error }, store.error) : null,
				);
			}
			return el("div", null,
				el("div", { className: S.saveBar },
					el(Button, {
						variant: "primary",
						size: "sm",
						disabled: busy,
						onClick: () => { void save(); },
					}, busy ? t("editor.saving") : t("editor.save")),
					el(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => { void reload(true); },
					}, t("editor.discard")),
					el(Button, {
						variant: "outline",
						size: "sm",
						disabled: busy,
						onClick: () => { void reset(); },
					}, t("editor.resetDefaults")),
					el("span", { className: S.saveState },
						busy ? t("editor.saving") : failure !== null ? t("editor.saveFailed") : message ?? t("editor.dirtyHint")),
				),
				el("p", { className: S.sectionHint }, t("editor.fileHint", { path: data.file.path })),
				store.error !== null || data.file.error !== null
					? el("p", { className: S.error }, store.error ?? data.file.error)
					: null,
				failure !== null ? el("p", { className: S.error }, failure) : null,
				message !== null ? el("p", { className: corrected ? S.warn : S.note }, message) : null,
				el("div", { className: S.section },
					el("div", { className: S.sectionHead },
						el("span", { className: S.sectionTitle }, t("editor.entriesTitle")),
						el(Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								const fresh = blankEntry();
								// 新增的条目直接进编辑态：它还没有可展示的价格。
								setEditingIds(previous => new Set(previous).add(fresh.id));
								setEntries([...entries, fresh]);
							},
						}, t("editor.addEntry")),
					),
					el("p", { className: S.sectionHint }, t("editor.entriesHint")),
					entries.length === 0
						? el("p", { className: S.empty }, t("editor.noEntries"))
						: entries.map((entry, index) => (editingIds.has(entry.id)
							? el(EntryEditor, {
								key: entry.id + "-" + index,
								entry,
								index,
								scheduleNames,
								routes,
								onOverlayToggle,
								t,
								onChange: (position, next) => setEntries(entries.map((item, at) => (at === position ? next : item))),
								onRemove: (position) => {
									stopEditing(entry.id);
									setEntries(entries.filter((_, at) => at !== position));
								},
								onCollapse: () => stopEditing(entry.id),
							})
							: el(PriceCard, {
								key: entry.id + "-" + index,
								entry,
								badge: entry.prices.offPeak === undefined ? t("editor.customFlat") : t("editor.customSplit"),
								t,
								actions: el(Button, {
									variant: "outline",
									size: "sm",
									onClick: () => startEditing(entry.id),
								}, t("editor.edit")),
							}))),
				),
				el("div", { className: S.section },
					el("div", { className: S.sectionHead },
						el("span", { className: S.sectionTitle }, t("editor.schedulesTitle")),
						el(Button, {
							variant: "outline",
							size: "sm",
							onClick: () => {
								let index = Object.keys(schedules).length + 1;
								let name = "custom-" + index;
								while (scheduleNames.includes(name)) name = "custom-" + (++index);
								setSchedules({ ...schedules, [name]: blankSchedule() });
							},
						}, t("editor.addSchedule")),
					),
					el("p", { className: S.sectionHint }, t("editor.schedulesHint")),
					scheduleNames.map((name) => el(ScheduleEditor, {
						key: name,
						name,
						schedule: schedules[name] ?? data.builtinSchedules[name],
						builtin: schedules[name] === undefined,
						t,
						onChange: (next) => setSchedules({ ...schedules, [name]: next }),
						onRemove: () => {
							const next = { ...schedules };
							delete next[name];
							setSchedules(next);
						},
					})),
				),
				el("div", { className: S.section },
					el("div", { className: S.sectionHead },
						el("span", { className: S.sectionTitle }, t("editor.builtinTitle")),
					),
					el("p", { className: S.sectionHint }, t("editor.builtinHint")),
					(data.builtin ?? []).map(entry => el(PriceCard, {
						key: entry.id,
						entry,
						badge: t("editor.builtinEntry"),
						t,
					})),
				),
			);
		}

		//#endregion

		//#region 胶囊与面板
		/** 输入框下方的费用胶囊。 */
		function TokenFeePill({ useProjection, t, pricing }) {
			const usage = useProjection("tokenFee");
			const store = usePricingState(pricing);
			const [open, setOpen] = useState(false);
			const [tab, setTab] = useState("detail");
			const anchorRef = useRef(null);
			const panelRef = useRef(null);
			const position = useAnchoredPosition(open, anchorRef, panelRef, tab);
			const close = useCallback(() => setOpen(false), []);
			// 引用必须稳定，否则 useDismiss 的监听器每次渲染都会重装。
			const dismissRoots = useMemo(() => [anchorRef, panelRef], []);
			// 面板内展开的候选列表计数：它们 portal 到 body，需让面板让出外部点击。
			const overlayRef = useRef(0);
			const trackOverlay = useCallback((active) => {
				overlayRef.current += active ? 1 : -1;
			}, []);
			useDismiss(open, close, dismissRoots, overlayRef);
			const entries = store.data?.entries ?? [];
			const currency = store.data?.displayCurrency ?? DEFAULT_CURRENCY;
			const view = useMemo(() => computeView(usage, entries, currency), [usage, entries, currency]);
			const hasRows = (usage?.rows?.length ?? 0) > 0;
			// 计费模式跟着「当前正在使用的模型」走：投影的 route 是最近一次请求的
			// 路由，它命中的条目就是此刻在计价的条目。
			const routeProvider = usage?.route?.provider ?? null;
			const routeModel = usage?.route?.model ?? null;
			const routeEntry = useMemo(
				() => routeProvider === null || routeModel === null ? null : matchEntry(entries, routeProvider, routeModel),
				[entries, routeProvider, routeModel],
			);
			// 只有区分峰谷的条目才需要每秒走时；统一单价没有倒计时，让胶囊每秒
			// 重渲染纯属浪费。
			const now = useNow(hasRows && routeEntry?.prices?.offPeak !== undefined);
			const billing = useMemo(() => describeBilling(routeEntry, now), [routeEntry, now]);
			if (!hasRows) return null;
			const label = view.unpricedCount > 0 && view.amount === 0
				? t("pill.unpriced")
				: formatMoney(view.amount, view.currency);
			// 计费模式永远是第一段；区分峰谷时再接上当前时段与剩余时间。
			const billingParts = [];
			if (billing !== null) {
				billingParts.push({
					key: "mode",
					className: S.mode,
					text: t(billing.split ? "pill.modeSplit" : "pill.modeFlat"),
				});
				if (billing.split) {
					billingParts.push({
						key: "tariff",
						className: S.tariff,
						tariff: billing.tariff,
						text: t(billing.tariff === "offPeak" ? "pill.tariffOffPeak" : "pill.tariffPeak"),
					});
					if (billing.remainingMs !== null) {
						billingParts.push({
							key: "remaining",
							className: S.countdown,
							text: t("pill.remaining", { time: formatCountdown(billing.remainingMs) }),
						});
					}
				}
			}
			// `aria-label` 会盖掉按钮里的可见文本，因此把这几段一并拼进去。
			const aria = t("pill.aria", { value: formatPreciseMoney(view.amount, view.currency) })
				+ billingParts.map(part => " · " + part.text).join("");
			return el("span", { ref: anchorRef, className: S.root },
				el("button", {
					type: "button",
					className: S.pill,
					"data-active": open ? "true" : undefined,
					"data-unpriced": view.unpricedCount > 0 ? "true" : undefined,
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": aria,
					onClick: () => {
						const next = !open;
						setOpen(next);
						// 打开时重新拉取：路由建议来自实时配置，可能在上次拉取之后变了。
						if (next) void pricing.load(true);
					},
				},
					el(IconDatabaseOutline16, null),
					el("span", { className: S.amount }, label),
					billingParts.flatMap(part => [
						el("span", { key: part.key + "-sep", className: S.sep }, "· "),
						el("span", { key: part.key, className: part.className, "data-tariff": part.tariff }, part.text),
					]),
					view.unpricedCount > 0 ? el("span", { className: S.sep }, "· " + t("pill.unpricedShort", { count: view.unpricedCount })) : null,
				),
				open
					? createPortal(el("div", {
						ref: panelRef,
						className: S.panel,
						role: "dialog",
						"aria-label": t("panel.title"),
						// 宽度随标签页变化（明细窄、价格设置宽），因此标签页也是定位的依赖。
						"data-tab": tab,
						style: position ?? MEASURE_STYLE,
					},
						el("div", { className: S.panelHeader },
							el("span", { className: S.panelTitle }, el(IconDatabaseOutline16, null), t("panel.title")),
							el("span", { className: S.panelActions },
								el("button", { type: "button", className: S.iconButton, title: t("panel.close"), onClick: close }, "✕"),
							),
						),
						el("div", { className: S.tabs },
							el("button", {
								type: "button",
								className: S.tab,
								"data-active": tab === "detail" ? "true" : undefined,
								onClick: () => setTab("detail"),
							}, t("panel.tabDetail")),
							el("button", {
								type: "button",
								className: S.tab,
								"data-active": tab === "pricing" ? "true" : undefined,
								onClick: () => setTab("pricing"),
							}, t("panel.tabPricing")),
						),
						el("div", { className: S.body },
							tab === "detail"
								? el(FeeDetail, { view, t, pricingError: store.error, onConfigure: () => setTab("pricing") })
								: el(PricingEditor, { pricing, t, onOverlayToggle: trackOverlay }),
						),
					), document.body)
					: null,
			);
		}

		/** dsh 设置中的「Token 费用」页。 */
		function TokenFeeSettingsSection({ t, pricing }) {
			return el("div", { className: S.settings },
				el("p", { className: S.sectionHint }, t("settings.intro")),
				el(PricingEditor, { pricing, t }),
			);
		}

		//#endregion

		//#region 字典
		const NS = "token-fee";
		const zh = {
			"pill.aria": "本会话花费 {value}",
			"pill.unpriced": "未配置价格",
			"pill.unpricedShort": "{count} 项未定价",
			"pill.modeFlat": "计费模式：统一",
			"pill.modeSplit": "计费模式：峰谷",
			"pill.tariffPeak": "当前时段：高峰",
			"pill.tariffOffPeak": "当前时段：空闲",
			"pill.remaining": "剩余时间：{time}",
			"panel.title": "本会话花费",
			"panel.close": "关闭",
			"panel.tabDetail": "费用明细",
			"panel.tabPricing": "价格设置",
			"detail.empty": "本会话还没有产生计费用量。",
			"detail.totalLabel": "合计",
			"detail.totalExact": "精确金额 {value} · 共 {tokens} tokens",
			"detail.unpriced": "未配置价格",
			"detail.noPrice": "缺少价目条目",
			"detail.wildcard": "通配条目",
			"detail.tariffSplit": "区分峰谷",
			"detail.unpricedNote": "有 {count} 个模型没有匹配到价目条目，其用量未计入合计。",
			"detail.configure": "去配置价格",
			"detail.mixedCurrency": "另有其他币种费用：{value}（未计入合计）。",
			"detail.groupMeta": "{tokens} tokens · {value}",
			"bucket.input": "缓存未命中",
			"bucket.cacheRead": "缓存命中",
			"bucket.cacheWrite": "缓存写入",
			"bucket.output": "输出",
			"editor.loading": "正在读取价目表…",
			"editor.fileHint": "用户价目表：{path}（可直接编辑该文件，保存后立即生效）",
			"editor.entriesTitle": "自定义价目条目",
			"editor.entriesHint": "按供应商与模型精确匹配；供应商或模型填 * 表示通配。内置条目始终只读，同身份的条目会覆盖内置价格。",
			"editor.addEntry": "新增条目",
			"editor.newEntry": "新条目",
			"editor.noEntries": "还没有自定义条目；下面的内置条目正在生效。",
			"editor.provider": "供应商 provider",
			"editor.model": "模型 model",
			"editor.untitledModel": "未命名模型",
			"editor.invalidPriceHint": "不是有效的非负数字，保存时会按 0 处理",
			"editor.savedWithCorrections": "已保存。以下输入不是有效的非负数字，已按 0 保存：{fields}",
			"editor.toggleOptions": "展开{label}候选列表",
			"editor.noProviderOptions": "尚未配置任何供应商；请直接输入 provider id。",
			"editor.noModelOptions": "没有可选的模型；请直接输入模型 id。",
			"editor.errorNoEntries": "至少保留一条价目条目；若要回到内置价目，请用「恢复内置价目」。",
			"editor.errorNoModel": "{entry} 还没有填模型 id。",
			"editor.errorNoSchedule": "{entry} 勾选了「区分峰谷」但没有选择峰谷规则。",
			"editor.listSeparator": "、",
			"editor.dirtyHint": "修改后请点「保存」写入文件。",
			"editor.saveFailed": "保存失败",
			"editor.currency": "币种",
			"editor.schedule": "峰谷规则",
			"editor.scheduleNone": "不区分峰谷",
			"editor.prices": "单价（每百万 token）",
			"editor.peakPrices": "高峰单价（每百万 token）",
			"editor.offPeakPrices": "空闲单价（每百万 token）",
			"editor.splitTariff": "该条目区分高峰/空闲价格",
			"editor.remove": "删除",
			"editor.schedulesTitle": "峰谷规则",
			"editor.schedulesHint": "规则可被多条价目引用；修改一处即对该规则下的全部条目生效。时间为该时区的当地时间，区间为左闭右开。",
			"editor.addSchedule": "新增规则",
			"editor.timezone": "时区",
			"editor.peakDays": "高峰星期",
			"editor.peakWindows": "高峰时段",
			"editor.addWindow": "新增时段",
			"editor.builtinSchedule": "内置规则",
			"editor.builtinTitle": "内置价目（只读）",
			"editor.builtinHint": "插件只内置 DeepSeek 官方路由（deepseek-official）的价格与峰谷规则；其他供应商请在上方自行添加条目。",
			"editor.builtinEntry": "内置",
			"editor.customFlat": "自定义 · 统一单价",
			"editor.customSplit": "自定义 · 区分峰谷",
			"editor.edit": "编辑",
			"editor.collapse": "完成",
			"editor.invalidPriceShort": "—",
			"editor.tariffPeak": "高峰",
			"editor.tariffOffPeak": "空闲",
			"editor.tariffFlat": "单价",
			"editor.save": "保存",
			"editor.saving": "保存中…",
			"editor.saved": "已保存。",
			"editor.discard": "放弃修改并重新载入",
			"editor.reset": "已恢复内置价目。",
			"editor.resetDefaults": "恢复内置价目",
			"settings.nav": "Token 费用",
			"settings.intro": "为每个供应商与模型配置 token 单价，并设置高峰/空闲时段判定规则。会话花费显示在输入框下方。",
			"weekday.sun": "日",
			"weekday.mon": "一",
			"weekday.tue": "二",
			"weekday.wed": "三",
			"weekday.thu": "四",
			"weekday.fri": "五",
			"weekday.sat": "六",
		};
		const en = {
			"pill.aria": "Session cost {value}",
			"pill.unpriced": "No price configured",
			"pill.unpricedShort": "{count} unpriced",
			"pill.modeFlat": "Billing: flat",
			"pill.modeSplit": "Billing: peak/off-peak",
			"pill.tariffPeak": "Period: peak",
			"pill.tariffOffPeak": "Period: off-peak",
			"pill.remaining": "Left: {time}",
			"panel.title": "Session cost",
			"panel.close": "Close",
			"panel.tabDetail": "Cost breakdown",
			"panel.tabPricing": "Pricing",
			"detail.empty": "This session has no billed usage yet.",
			"detail.totalLabel": "Total",
			"detail.totalExact": "Exact {value} · {tokens} tokens",
			"detail.unpriced": "Unpriced",
			"detail.noPrice": "No matching entry",
			"detail.wildcard": "Wildcard entry",
			"detail.tariffSplit": "Peak/off-peak",
			"detail.unpricedNote": "{count} model(s) matched no pricing entry; their usage is excluded from the total.",
			"detail.configure": "Configure pricing",
			"detail.mixedCurrency": "Other currencies: {value} (excluded from the total).",
			"detail.groupMeta": "{tokens} tokens · {value}",
			"bucket.input": "Cache miss",
			"bucket.cacheRead": "Cache hit",
			"bucket.cacheWrite": "Cache write",
			"bucket.output": "Output",
			"editor.loading": "Loading pricing…",
			"editor.fileHint": "User pricing file: {path} (edit it directly; changes apply immediately)",
			"editor.entriesTitle": "Custom entries",
			"editor.entriesHint": "Matched by provider and model; use * as a wildcard. Built-in entries stay read-only, and an entry with the same identity overrides them.",
			"editor.addEntry": "Add entry",
			"editor.newEntry": "New entry",
			"editor.noEntries": "No custom entries yet; the built-in entries below apply.",
			"editor.provider": "Provider",
			"editor.model": "Model",
			"editor.untitledModel": "Untitled model",
			"editor.invalidPriceHint": "Not a valid non-negative number; saved as 0",
			"editor.savedWithCorrections": "Saved. These inputs were not valid non-negative numbers and were saved as 0: {fields}",
			"editor.toggleOptions": "Show {label} suggestions",
			"editor.noProviderOptions": "No provider configured yet; type the provider id directly.",
			"editor.noModelOptions": "No model suggestions; type the model id directly.",
			"editor.errorNoEntries": "Keep at least one entry; use \"Restore built-in pricing\" to go back to the built-ins.",
			"editor.errorNoModel": "{entry} has no model id yet.",
			"editor.errorNoSchedule": "{entry} has separate peak/off-peak prices but no schedule selected.",
			"editor.listSeparator": ", ",
			"editor.dirtyHint": "Click Save to write changes to the file.",
			"editor.saveFailed": "Save failed",
			"editor.currency": "Currency",
			"editor.schedule": "Tariff schedule",
			"editor.scheduleNone": "Flat price",
			"editor.prices": "Unit price (per million tokens)",
			"editor.peakPrices": "Peak unit price (per million tokens)",
			"editor.offPeakPrices": "Off-peak unit price (per million tokens)",
			"editor.splitTariff": "This entry has separate peak/off-peak prices",
			"editor.remove": "Remove",
			"editor.schedulesTitle": "Tariff schedules",
			"editor.schedulesHint": "Schedules are shared by name; editing one updates every entry that references it. Times are local to the timezone, half-open intervals.",
			"editor.addSchedule": "Add schedule",
			"editor.timezone": "Timezone",
			"editor.peakDays": "Peak weekdays",
			"editor.peakWindows": "Peak windows",
			"editor.addWindow": "Add window",
			"editor.builtinSchedule": "Built-in",
			"editor.builtinTitle": "Built-in pricing (read-only)",
			"editor.builtinHint": "The plugin only ships DeepSeek's official route (deepseek-official) pricing and schedule; add your own entries above for every other provider.",
			"editor.builtinEntry": "Built-in",
			"editor.customFlat": "Custom · flat",
			"editor.customSplit": "Custom · peak/off-peak",
			"editor.edit": "Edit",
			"editor.collapse": "Done",
			"editor.invalidPriceShort": "—",
			"editor.tariffPeak": "Peak",
			"editor.tariffOffPeak": "Off-peak",
			"editor.tariffFlat": "Flat",
			"editor.save": "Save",
			"editor.saving": "Saving…",
			"editor.saved": "Saved.",
			"editor.discard": "Discard and reload",
			"editor.reset": "Built-in pricing restored.",
			"editor.resetDefaults": "Restore built-in pricing",
			"settings.nav": "Token cost",
			"settings.intro": "Configure per-provider, per-model token prices and the peak/off-peak schedule. Session cost appears under the composer.",
			"weekday.sun": "Sun",
			"weekday.mon": "Mon",
			"weekday.tue": "Tue",
			"weekday.wed": "Wed",
			"weekday.thu": "Thu",
			"weekday.fri": "Fri",
			"weekday.sat": "Sat",
		};
		//#endregion

		//#region 插件主体
		/** 客户端插件需要的服务。 */
		const inject = ["slots", "locale"];

		/**
		 * 客户端插件入口：注册字典、输入框下方的费用胶囊，以及设置页。
		 * @param ctx - 客户端根上下文。
		 */
		function apply(ctx) {
			ctx.effect(installStyles, "token-fee: stylesheet");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-fee: dictionaries");
			const t = ctx.locale.bind(NS);
			const pricing = createPricingApi();

			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "token-fee",
				order: 5,
				locale: NS,
				inject: () => ({ pricing }),
			}, TokenFeePill));

			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "token-fee",
				order: 30,
				label: () => t("settings.nav"),
				locale: NS,
				inject: () => ({ pricing }),
			}, TokenFeeSettingsSection));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.adoptPricing = adoptPricing;
		exports.isInsideRoots = isInsideRoots;
		exports.computeView = computeView;
		exports.describeBilling = describeBilling;
		exports.tariffAt = tariffAt;
		exports.tariffStateAt = tariffStateAt;
		exports.formatCountdown = formatCountdown;
		exports.supportedTimezones = supportedTimezones;
		exports.timezoneOffsetMinutes = timezoneOffsetMinutes;
		exports.toPriceBlock = toPriceBlock;
		exports.applyPriceDraft = applyPriceDraft;
		exports.priceNumber = priceNumber;
		exports.blankEntry = blankEntry;
		exports.panelPosition = panelPosition;
		return module.exports;
	}
});
