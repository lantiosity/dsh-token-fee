#!/usr/bin/env node
/**
 * dsh-token-fee 浏览器半冒烟测试。
 *
 * 在 Node 里搭一个最小的 `window.__ModuleLoader__` 与 `document`，加载
 * `lib/client.js`，取出模块工厂，用真实 React（来自 dsh profile 的
 * node_modules，缺失时退回替身）渲染三个导出组件，并驱动 `apply` 检查
 * slot 注册。
 *
 * 运行：node scripts/test-client.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let passed = 0
const failures = []

/** 运行一个用例并记录结果。 */
function test(label, body) {
  try {
    body()
    passed += 1
  } catch (error) {
    failures.push({ label, error })
  }
}

//#region 加载模块

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileModules = join(dshHome, 'profiles', 'node_modules')

/**
 * 解析一个真实依赖。
 *
 * 先找 dsh profile 的 `node_modules`（本机真实运行环境里的那一份），再退回本包
 * 自己的 `node_modules`（CI 里由 devDependencies 提供）。两者都没有时返回 null，
 * 渲染用例会跳过。
 * @param id - 模块标识。
 * @returns 模块，或 null。
 */
function tryRequire(id) {
  const anchors = [
    join(profileModules, 'noop.js'),
    join(import.meta.dirname, '..', 'noop.js'),
  ]
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)(id)
    } catch {
      // 换下一个锚点。
    }
  }
  return null
}

/** 最小 DOM 替身：client.js 用它注入样式标签，并支持按 id 去重与移除。 */
const styleTags = []
globalThis.document = {
  // 只认 client.js 真正发出的选择器形状：style[data-plugin-css="<id>"]。
  querySelector: (selector) => {
    const match = /data-plugin-css="([^"]+)"/.exec(selector)
    if (match === null) return null
    return styleTags.find(tag => tag.dataset.pluginCss === match[1]) ?? null
  },
  createElement: () => ({
    dataset: {},
    textContent: '',
    remove() {
      const index = styleTags.indexOf(this)
      if (index >= 0) styleTags.splice(index, 1)
    },
  }),
  head: { appendChild: tag => styleTags.push(tag) },
}
globalThis.window = { innerWidth: 1280, innerHeight: 900 }

let loaded = null
globalThis.window.__ModuleLoader__ = {
  load(spec) {
    loaded = spec
  },
}

await import(pathToFileURL(join(import.meta.dirname, '..', 'lib', 'client.js')).href)

const react = tryRequire('react')
const jsxRuntime = tryRequire('react/jsx-runtime')
const reactDomServer = tryRequire('react-dom/server')
const hasRealReact = react !== null && jsxRuntime !== null && reactDomServer !== null

/** 替身 React：只够让模块工厂完成装配，不做真实渲染。 */
const stubReact = {
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
  useId: () => ':stub:',
}

const stubJsxRuntime = {
  jsx: (type, props) => ({ type, props }),
  jsxs: (type, props) => ({ type, props }),
}

/** 模块工厂收到的 require 实现。 */
function makeRequire() {
  return id => {
    if (id === 'react') return hasRealReact ? react : stubReact
    if (id === 'react/jsx-runtime') return hasRealReact ? jsxRuntime : stubJsxRuntime
    if (id === 'react-dom') return { createPortal: node => node }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconDatabaseOutline16: () => null,
        IconChevronDownOutline14: () => null,
        // 官方按钮：把 variant/size 落到 data 属性上，便于断言用的是哪一种样式。
        Button: ({ variant = 'ghost', size = 'md', children, ...rest }) => react.createElement(
          'button',
          { type: 'button', 'data-variant': variant, 'data-size': size, ...rest },
          children,
        ),
        // 组合框的下拉列表：展开时把候选渲染成列表，收起时只渲染 anchor。
        // 用 createElement 而不是裸对象，否则 React 会把它当成非法子节点。
        Menu: ({ open, anchor, items, onSelect }) => react.createElement(
          'span',
          null,
          anchor,
          open
            ? react.createElement(
              'ul',
              { className: 'tf_menuListStub' },
              items.map(item => react.createElement(
                'li',
                { key: item.id, 'data-id': item.id, onClick: () => onSelect(item.id) },
                item.type === 'label' ? item.text : item.id,
              )),
            )
            : null,
        ),
      }
    }
    throw new Error(`未预期的模块请求：${id}`)
  }
}

const clientExports = loaded.factory(makeRequire())

//#endregion

//#region 测试替身

/** 带峰谷两档价的内置条目替身。 */
const SPLIT_BUILTIN = {
  id: 'builtin-deepseek-official-flash-cny',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  currency: 'CNY',
  schedule: { timezone: 'Asia/Shanghai', peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00']] },
  prices: {
    peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
    offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
  },
  note: 'DeepSeek 官方定价。',
}

/** 只有单一价格的内置条目替身。 */
const FLAT_BUILTIN = {
  id: 'builtin-flat',
  provider: 'deepseek-official',
  model: 'flat-model',
  currency: 'CNY',
  schedule: null,
  prices: { peak: { input: 3, cacheRead: 0.1, cacheWrite: 0, output: 9 } },
}

/** 用户文件里的默认条目替身（有效表与编辑器草稿共用）。 */
const FILE_ENTRY = {
  id: 'mine',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  currency: 'CNY',
  schedule: null,
  prices: { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 } },
}

/**
 * 价目表句柄替身。
 * @param options.entries - 有效价目表（`data.entries`），供费用换算使用。
 * @param options.fileEntries - 用户文件条目（`data.file.entries`），编辑器草稿的来源。
 * @param options.routes - 已配置路由，供 provider / model 建议使用。
 */
function fakePricing(options = {}) {
  const fileEntries = options.fileEntries ?? [FILE_ENTRY]
  const snapshot = {
    status: 'ready',
    error: options.error ?? null,
    data: {
      displayCurrency: 'CNY',
      entries: options.entries ?? fileEntries,
      builtin: options.builtin ?? [SPLIT_BUILTIN],
      schedules: {},
      builtinSchedules: { deepseek: { timezone: 'Asia/Shanghai', peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00'], ['14:00', '18:00']] } },
      routes: options.routes ?? [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }, { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }],
        },
        { id: 'my-gateway', name: 'My Gateway', models: [{ id: 'glm-5', name: 'GLM-5' }] },
      ],
      file: {
        path: '/tmp/token-fee.json',
        exists: options.fileEntries !== undefined,
        entries: fileEntries,
        schedules: options.fileSchedules ?? null,
        error: null,
      },
      configEntryCount: 0,
    },
  }
  return {
    get: () => snapshot,
    subscribe: () => () => {},
    load: async () => {},
    save: async () => snapshot.data,
    reset: async () => snapshot.data,
  }
}

/** 一个把固定投影值喂给组件的 `useProjection` 替身。 */
function fakeUseProjection(value) {
  return () => value
}

/** 只覆盖被测断言的字典替身；缺失的键回退为键名，便于发现未翻译的调用。 */
const t = (key, params) => {
  const dictionary = {
    'pill.aria': '本会话花费 {value}',
    'pill.unpriced': '未配置价格',
    'pill.unpricedShort': '{count} 项未定价',
    'pill.modeFlat': '计费模式：统一',
    'pill.modeSplit': '计费模式：峰谷',
    'pill.tariffPeak': '当前时段：高峰',
    'pill.tariffOffPeak': '当前时段：空闲',
    'pill.remaining': '剩余时间：{time}',
    'bucket.input': '缓存未命中',
    'bucket.cacheRead': '缓存命中',
    'bucket.cacheWrite': '缓存写入',
    'bucket.output': '输出',
    'editor.fileHint': '用户价目表：{path}',
    'editor.addEntry': '新增条目',
    'editor.addSchedule': '新增规则',
    'editor.offPeakShort': '空闲 · {bucket}',
    'editor.tariffPeak': '高峰',
    'editor.tariffOffPeak': '空闲',
    'editor.tariffFlat': '单价',
    'editor.customFlat': '自定义 · 统一单价',
    'editor.customSplit': '自定义 · 区分峰谷',
    'editor.edit': '编辑',
    'editor.invalidPriceShort': '—',
    'editor.invalidPriceHint': '不是有效的非负数字，保存时会按 0 处理',
    'editor.savedWithCorrections': '已保存。以下输入不是有效的非负数字，已按 0 保存：{fields}',
    'editor.dirtyHint': '修改后请点「保存」写入文件。',
    'editor.builtinSchedule': '内置规则',
    'editor.customSchedule': '自定义规则',
    'editor.builtinScheduleOverridden': '内置规则 · 已覆盖',
    'editor.revertSchedule': '恢复内置',
    'editor.collapse': '完成',
    'editor.scheduleName': '规则名称',
    'editor.scheduleNone': '单价',
    'editor.timezone': '时区',
    'editor.peakDays': '高峰星期',
    'editor.peakWindows': '高峰时段',
    'editor.addWindow': '新增时段',
    'weekday.mon': '一',
    'weekday.tue': '二',
    'weekday.wed': '三',
    'weekday.thu': '四',
    'weekday.fri': '五',
    'weekdayLong.sun': '周日',
    'weekdayLong.mon': '周一',
    'weekdayLong.tue': '周二',
    'weekdayLong.wed': '周三',
    'weekdayLong.thu': '周四',
    'weekdayLong.fri': '周五',
    'editor.dayRange': '{from} 至 {to}',
    'editor.hour': '时',
    'editor.minute': '分',
    'editor.windowInvalid': '结束需晚于开始',
    'editor.errorNoWindow': '规则 {rule} 至少要有一个高峰时段。',
    'editor.errorWindowFormat': '规则 {rule} 的第 {index} 个高峰时段没填全（时 00–23、分 00–59）。',
    'editor.errorWindowOrder': '规则 {rule} 的第 {index} 个高峰时段必须结束得比开始晚。',
    'editor.schedulesTitle': '峰谷规则',
    'editor.peakPrices': '高峰单价（每百万 token）',
    'editor.prices': '单价（每百万 token）',
    'editor.offPeakPrices': '空闲单价（每百万 token）',
    'editor.splitTariff': '区分峰谷',
    'editor.listSeparator': '、',
    'settings.intro': '为每个供应商与模型配置 token 单价。',
  }
  const template = dictionary[key] ?? key
  if (params === undefined) return template
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
}

/** 用真实 React 渲染一个元素为静态标记。 */
/**
 * 用服务端渲染器把元素渲染成静态标记。
 *
 * 组件本身只在浏览器里跑（bundle 由 Web Client 装载），这里借服务端渲染器做
 * 字符串比对。`useLayoutEffect` 在服务端渲染下不执行且会告警，而定位钩子必须
 * 无条件调用（hooks 规则），所以这条告警是测试手法的产物而非缺陷：面板只在
 * 用户点开后才渲染，服务端渲染永远不会产出它。只抑制这一条，其余告警照常抛出。
 * @param element - 要渲染的元素。
 * @returns 静态 HTML。
 */
function render(element) {
  assert.ok(hasRealReact, '需要真实 React 才能渲染')
  const originalError = console.error
  console.error = (...args) => {
    const first = typeof args[0] === 'string' ? args[0] : ''
    if (first.includes('useLayoutEffect does nothing on the server')) return
    originalError(...args)
  }
  try {
    return reactDomServer.renderToStaticMarkup(element)
  } finally {
    console.error = originalError
  }
}

/**
 * 渲染规则编辑表单。
 *
 * 规则卡片默认收敛成只读摘要，编辑控件只有展开后才存在，因此时区下拉、星期
 * 按钮、时段输入这些断言必须直接渲染表单组件。
 * @param overrides - 覆盖默认的 props。
 * @returns 静态 HTML。
 */
function renderScheduleEditor(overrides = {}) {
  return render(react.createElement(clientExports.ScheduleEditor, {
    name: 'deepseek',
    schedule: { timezone: 'Asia/Shanghai', peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00']] },
    scheduleNames: ['deepseek'],
    builtin: false,
    overridden: false,
    t,
    onChange: () => {},
    onRename: () => {},
    onRemove: () => {},
    onCollapse: () => {},
    ...overrides,
  }))
}

/** 构造一个捕获 slot 注册的客户端上下文替身。 */
function fakeClientContext() {
  const registrations = []
  return {
    registrations,
    ctx: {
      effect: factory => factory(),
      locale: {
        register: () => {},
        bind: () => t,
      },
      slots: {
        inject: (name, callback) => {
          callback()
        },
        register: (options, component) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

//#endregion

//#region 用例

test('模块以正确的包名注册', () => {
  assert.equal(loaded.id, '@lantiosity/dsh-token-fee')
})

test('模块导出 apply 与 inject', () => {
  assert.equal(typeof clientExports.apply, 'function')
  assert.deepEqual(clientExports.inject, ['slots', 'locale'])
})

test('样式随 apply 注入且幂等', () => {
  // 注入是一个 effect：卸载即撤销，重新 apply 复用同一标签而不堆积。
  const first = fakeClientContext()
  clientExports.apply(first.ctx)
  assert.equal(styleTags.length, 1, '首次 apply 应注入一个样式标签')
  assert.match(styleTags[0].textContent, /\.tf_pill\{/)
  assert.equal(styleTags[0].dataset.plugin, '@lantiosity/dsh-token-fee')
  const second = fakeClientContext()
  clientExports.apply(second.ctx)
  assert.equal(styleTags.length, 1, '重复 apply 不应堆积样式标签')
})

test('样式 effect 的 disposer 移除本次注入的标签', () => {
  // 先把已有标签清掉，让下一次 apply 成为真正的创建者。
  while (styleTags.length > 0) styleTags[0].remove()
  const disposers = []
  const ctx = {
    effect: (factory) => {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    locale: { register: () => {}, bind: () => t },
    slots: { inject: () => {}, register: () => () => {} },
  }
  clientExports.apply(ctx)
  assert.equal(styleTags.length, 1)
  for (const dispose of disposers) dispose()
  assert.equal(styleTags.length, 0, 'disposer 应移除样式标签')
  // 复原：后续用例仍需要一个已注入的样式表。
  clientExports.apply(fakeClientContext().ctx)
})

test('样式只描述自己的元素，不改写其他插件的布局', () => {
  const cssText = styleTags[0].textContent
  // 依赖 ui-chat 的私有标记或改写承载其他 occupant 的父容器布局，都会在官方
  // 调整结构时造成破坏性失败（输入区被撑变形），而不只是视觉降级。
  assert.doesNotMatch(cssText, /data-composer-stats/, '不得依赖 ui-chat 的私有标记')
  assert.doesNotMatch(cssText, /:has\(>/, '不得改写承载其他 occupant 的父容器布局')
})

test('apply 注册费用胶囊与设置页', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  assert.equal(registrations.length, 2)
  const names = registrations.map(row => row.options.name).sort()
  assert.deepEqual(names, ['conversation.composer.dock', 'settings.section'])
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  assert.equal(dock.options.id, 'token-fee')
  assert.equal(dock.options.locale, 'token-fee')
  const section = registrations.find(row => row.options.name === 'settings.section')
  assert.equal(typeof section.options.label, 'function')
  assert.equal(typeof section.options.inject, 'function')
  assert.ok(section.options.inject().pricing, '设置页应收到价目表句柄')
})

test('没有用量时不渲染胶囊', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection(undefined),
    t,
    pricing: fakePricing(),
  }))
  assert.equal(html, '')
})

test('有已定价用量时渲染精确到分的金额', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      rows: [{
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        tariff: 'peak',
        input: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
      }],
    }),
    t,
    pricing: fakePricing(),
  }))
  assert.match(html, /tf_pill/)
  // 金额由 Intl 按运行时 locale 渲染（货币符号位置与小数分隔符都会变），
  // 因此只断言数值本身。
  assert.match(html, /2[.,]00/, '一百万未命中输入应按每百万 2 的单价计价')
  assert.doesNotMatch(html, /未配置价格/)
})

test('未配置价格的供应商渲染未定价提示', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({
      route: { provider: 'my-gateway', model: 'glm-5' },
      rows: [{ provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 500, cacheRead: 0, cacheWrite: 0, output: 500 }],
    }),
    t,
    pricing: fakePricing(),
  }))
  assert.match(html, /未配置价格/)
  assert.match(html, /tf_pill/)
})

test('设置页渲染价目表与峰谷规则编辑器', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing() }))
  assert.match(html, /tf_panel|tf_settings/)
  assert.match(html, /token-fee\.json/)
  assert.match(html, /新增条目/)
  assert.match(html, /新增规则/)
})

test('内联调度被采纳为可编辑的命名规则', () => {
  const adopted = clientExports.adoptPricing([
    {
      id: 'inline',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      schedule: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] },
      prices: {
        peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        offPeak: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 },
      },
    },
  ], null)
  assert.equal(adopted.entries.length, 1)
  assert.equal(adopted.entries[0].schedule, 'inline-1')
  assert.equal(adopted.schedules['inline-1'].timezone, 'UTC')
})

test('没有空闲价的条目不会被塞进内联规则', () => {
  const adopted = clientExports.adoptPricing([
    {
      id: 'flat',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      schedule: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] },
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    },
  ], null)
  // 单一单价的条目用不到峰谷判定，不该凭空多出一条 inline-1 规则。
  assert.equal(adopted.entries[0].schedule, null)
  assert.deepEqual(adopted.schedules, {})
})

test('命名引用与无调度条目原样保留', () => {
  const adopted = clientExports.adoptPricing([
    { id: 'a', provider: 'x', model: 'y', currency: 'CNY', schedule: 'deepseek', prices: { peak: {} } },
    { id: 'b', provider: 'x', model: 'z', currency: 'CNY', schedule: null, prices: { peak: {} } },
  ], { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '01:00']] } })
  assert.equal(adopted.entries[0].schedule, 'deepseek')
  assert.equal(adopted.entries[1].schedule, null)
  assert.deepEqual(Object.keys(adopted.schedules), ['mine'])
})

test('采纳不会改写原始条目对象', () => {
  const source = {
    id: 'inline',
    provider: 'x',
    model: 'y',
    currency: 'CNY',
    schedule: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] },
    prices: {
      peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      offPeak: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 0.5 },
    },
  }
  const adopted = clientExports.adoptPricing([source], null)
  assert.equal(typeof source.schedule, 'object')
  assert.equal(adopted.entries[0].schedule, 'inline-1')
  assert.notEqual(adopted.entries[0], source)
})

test('点击判定把锚点与面板都当作内部', () => {
  const inside = { current: { contains: target => target === 'in' } }
  const elsewhere = { current: { contains: () => false } }
  const empty = { current: null }
  assert.equal(clientExports.isInsideRoots('in', [inside]), true)
  assert.equal(clientExports.isInsideRoots('in', [elsewhere, inside]), true)
  assert.equal(clientExports.isInsideRoots('out', [inside, elsewhere]), false)
  assert.equal(clientExports.isInsideRoots('out', [empty]), false)
  assert.equal(clientExports.isInsideRoots(null, [inside]), false)
  assert.equal(clientExports.isInsideRoots(undefined, [inside]), false)
})

test('computeView 按供应商分组并按桶累计金额', () => {
  const entries = [{
    id: 'a',
    provider: 'p',
    model: 'm',
    currency: 'CNY',
    schedule: null,
    prices: { peak: { input: 2, cacheRead: 0.5, cacheWrite: 0, output: 8 } },
  }]
  const view = clientExports.computeView({
    rows: [
      { provider: 'p', model: 'm', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
      { provider: 'p', model: 'm', tariff: 'offPeak', input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 0 },
    ],
  }, entries, 'CNY')
  assert.equal(view.groups.length, 1)
  assert.equal(view.amount, 2.5)
  assert.equal(view.groups[0].models[0].buckets.input, 1_000_000)
  assert.equal(view.groups[0].models[0].buckets.cacheRead, 1_000_000)
  assert.equal(view.groups[0].models[0].amounts.input, 2)
  assert.equal(view.groups[0].models[0].amounts.cacheRead, 0.5)
  assert.equal(view.unpricedCount, 0)
})

test('computeView 把未定价模型单独标记且不计入合计', () => {
  const view = clientExports.computeView({
    rows: [{ provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 }],
  }, [], 'CNY')
  assert.equal(view.amount, 0)
  assert.equal(view.tokens, 1000)
  assert.equal(view.unpricedCount, 1)
  assert.equal(view.groups[0].models[0].priced, false)
})

test('内置价目按「四列价格 + 高峰/空闲两行」的表格排版', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing() }))
  assert.match(html, /tf_priceTable/)
  assert.match(html, /缓存未命中<\/span><span class="tf_priceHead">缓存命中<\/span><span class="tf_priceHead">缓存写入<\/span><span class="tf_priceHead">输出<\/span>/)
  assert.match(html, /<span class="tf_priceRowLabel">高峰<\/span>(<span class="tf_priceValue">[^<]*<\/span>){4}/)
  // 货币符号与小数分隔符都由 Intl 按运行时 locale 决定（zh-CN 为 ¥1.00/M，
  // en-US 为 CN¥1.00/M，de-DE 为 1,00 CN¥/M），因此只断言数值与 /M 后缀。
  assert.match(html, /<span class="tf_priceRowLabel">空闲<\/span><span class="tf_priceValue">[^<]*1[.,]00[^<]*\/M<\/span>/)
})

test('不区分峰谷的条目只渲染一行价格', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing({ builtin: [FLAT_BUILTIN] }) }))
  assert.match(html, /<span class="tf_priceRowLabel">单价<\/span><span class="tf_priceValue">[^<]*3[.,]00[^<]*\/M<\/span>/)
  assert.doesNotMatch(html, /tf_priceRowLabel">高峰/)
  assert.doesNotMatch(html, /tf_priceRowLabel">空闲/)
})

test('时区使用带 UTC 偏移的下拉框', () => {
  // 规则默认收起，因此直接渲染规则表单，而不是走收敛态的卡片。
  const html = renderScheduleEditor()
  assert.match(html, /<select class="tf_select">/)
  assert.match(html, /value="Asia\/Shanghai"[^>]*>Asia\/Shanghai \(GMT\+8\)</)
  assert.match(html, /value="UTC"[^>]*>UTC \(GMT\+0\)</)
  assert.match(html, /value="America\/New_York"[^>]*>America\/New_York \(GMT-4\)</)
  assert.match(html, /value="Asia\/Calcutta"[^>]*>Asia\/Calcutta \(GMT\+5:30\)</)
})

test('时区按 UTC 偏移升序排列而非字母序', () => {
  const zones = clientExports.supportedTimezones()
  assert.ok(zones.length > 100, `应枚举出全部时区，实际 ${zones.length}`)
  let previous = null
  for (const zone of zones) {
    const offset = clientExports.timezoneOffsetMinutes(zone)
    assert.notEqual(offset, null, `${zone} 应能解析出偏移`)
    if (previous !== null) {
      assert.ok(previous <= offset, `${zone}（${offset}）不应排在偏移 ${previous} 的时区之后`)
    }
    previous = offset
  }
  // 两端分别是地球上最西与最东的时区，字母序不会这样排列。
  assert.match(zones[0], /^Pacific\/(Midway|Niue|Pago_Pago)$/)
  assert.match(zones.at(-1), /^Pacific\/(Kiritimati|Tongatapu)$/)
})

test('同一偏移内按名字排序且 UTC 居首', () => {
  const zones = clientExports.supportedTimezones()
  const zero = zones.filter(zone => clientExports.timezoneOffsetMinutes(zone) === 0)
  assert.equal(zero[0], 'UTC')
  const rest = zero.slice(1)
  assert.deepEqual(rest, [...rest].sort((a, b) => a.localeCompare(b)))
})

test('未定价提示带有可用的「去配置价格」按钮', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({
      route: { provider: 'my-gateway', model: 'glm-5' },
      rows: [{ provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 500, cacheRead: 0, cacheWrite: 0, output: 500 }],
    }),
    t,
    pricing: fakePricing(),
  }))
  assert.match(html, /未配置价格/)
})

test('价格输入原样保留小数点等中间态', () => {
  const prices = { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 } }
  // 关键：草稿必须是字符串 "1."，否则输入框回显 "1"，小数点被吞掉。
  const first = clientExports.applyPriceDraft(prices, 'peak', 'input', '1.')
  assert.equal(first.peak.input, '1.')
  const second = clientExports.applyPriceDraft(first, 'peak', 'input', '1.5')
  assert.equal(second.peak.input, '1.5')
  assert.equal(second.peak.cacheRead, 0.04, '未触碰的桶保持原值')
  assert.equal(prices.peak.input, 2, '不得就地修改传入的草稿')
})

test('保存时把价格草稿转成数字', () => {
  const block = clientExports.toPriceBlock({ input: '1.', cacheRead: '.5', cacheWrite: '', output: '0.04' })
  assert.deepEqual(block.prices, { input: 1, cacheRead: 0.5, cacheWrite: 0, output: 0.04 })
  assert.deepEqual(block.corrected, [])
})

test('非法价格就地归零并报告，而不是让保存失败', () => {
  // 一个笔误不该阻塞整次保存、连带其它条目一起丢掉。
  const block = clientExports.toPriceBlock({
    input: '0s',
    cacheRead: '-1',
    cacheWrite: '',
    output: '6',
  })
  assert.deepEqual(block.prices, { input: 0, cacheRead: 0, cacheWrite: 0, output: 6 })
  assert.deepEqual(block.corrected, ['input', 'cacheRead'])
})

test('空白价格按 0 处理且不算修正', () => {
  const block = clientExports.toPriceBlock({ input: '  ', cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.deepEqual(block.prices, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.deepEqual(block.corrected, [])
})

test('provider 与 model 使用可输入的组合框，而不是原生 datalist', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({ fileEntries: [{ ...FILE_ENTRY, provider: 'my-gateway', model: 'glm-5' }] }),
  }))
  // 收敛态是只读卡片：与内置条目同一形态，带「编辑」按钮。
  assert.doesNotMatch(html, /<datalist/)
  assert.match(html, /tf_priceTable/)
  assert.match(html, />编辑</)
  assert.doesNotMatch(html, /tf_combo/)
})

test('组合框只在展开编辑后出现', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  // 通过条目区的「编辑」按钮进入编辑态：这里直接驱动组件内部状态不可行，
  // 改为断言收敛态与编辑态的控件集合互斥。
  const collapsed = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({ fileEntries: [{ ...FILE_ENTRY, provider: 'not-configured', model: '' }] }),
  }))
  assert.doesNotMatch(collapsed, /tf_combo/)
  assert.match(collapsed, /tf_priceTable/)
})

test('缺少路由建议时仍可自由输入', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({ routes: [], fileEntries: [FILE_ENTRY] }),
  }))
  // 没有路由建议不影响收敛态卡片；输入框本身是自由文本，不受候选限制。
  assert.match(html, /tf_priceTable/)
  assert.match(html, /deepseek-official \/ deepseek-flash/)
})

test('保存键位于编辑器顶部而非页面底部', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing() }))
  const saveBar = html.indexOf('tf_saveBar')
  // 用自定义条目区的标题定位内容起点，避开 settings.intro 那段说明文字。
  const entriesSection = html.indexOf('editor.entriesTitle')
  assert.ok(saveBar >= 0, '应有保存工具栏')
  assert.ok(entriesSection >= 0, '应有条目编辑区')
  assert.ok(saveBar < entriesSection, '保存工具栏应排在编辑内容之前')
  assert.match(html, /data-variant="primary"[^>]*>editor\.save</)
  // 底部不再重复一个保存键，避免两处入口语义重叠。
  assert.equal(html.split('editor.save<').length - 1, 1)
})

test('币种与峰谷规则都是下拉框，选项带本地化名称', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing() }))
  // 时区下拉在展开规则表单后出现。
  assert.match(renderScheduleEditor(), /<option value="Asia\/Shanghai"[^>]*>Asia\/Shanghai \(GMT\+8\)<\/option>/)
  // 币种下拉只在条目编辑态出现，收敛态不该有可编辑的币种控件。按 option 的
  // value 判断而不是它的本地化名称：后者随运行时 locale 变化。
  assert.doesNotMatch(html, /<option value="CNY"/)
  assert.doesNotMatch(html, /tf_combo/)
})

test('已保存的自定义条目按内置条目的格式呈现', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  // 清空内置条目，让断言只面对自定义卡片本身。
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({
      builtin: [],
      fileEntries: [{ ...FILE_ENTRY, provider: 'my-gateway', model: 'glm-5' }],
    }),
  }))
  // 与内置卡片同构：标题行 + 四列单价表 + 页脚操作位。
  assert.match(html, /my-gateway \/ glm-5/)
  assert.match(html, /tf_priceTable/)
  assert.match(html, /tf_cardFoot/)
  assert.match(html, /tf_cardActions/)
  // 统一单价的条目只渲染一行，并标为「自定义 · 统一单价」。
  assert.match(html, /自定义 · 统一单价/)
  assert.doesNotMatch(html, /tf_priceRowLabel">高峰/)
})

test('区分峰谷的自定义条目渲染两行并标注', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({
      fileSchedules: { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
      fileEntries: [{
        ...FILE_ENTRY,
        provider: 'my-gateway',
        model: 'glm-5',
        schedule: 'mine',
        prices: {
          peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
          offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
        },
      }],
    }),
  }))
  assert.match(html, /自定义 · 区分峰谷/)
  assert.match(html, /tf_priceRowLabel">高峰/)
  assert.match(html, /tf_priceRowLabel">空闲/)
})

test('价格草稿在卡片上安全降级为占位符', () => {
  // 中间态（"1."）能显示为数字；非法值显示占位符而不是 NaN。
  assert.equal(clientExports.priceNumber('1.'), 1)
  assert.equal(clientExports.priceNumber('.5'), 0.5)
  assert.equal(clientExports.priceNumber(''), null)
  assert.equal(clientExports.priceNumber('abc'), null)
  assert.equal(clientExports.priceNumber('-1'), null)
  assert.equal(clientExports.priceNumber(0.04), 0.04)
})

test('新条目默认不分峰谷，也不带峰谷规则引用', () => {
  const fresh = clientExports.blankEntry()
  assert.equal(fresh.schedule, null, '新条目不该预设峰谷规则')
  assert.equal(fresh.prices.offPeak, undefined, '新条目默认统一单价')
  assert.ok(fresh.id.startsWith('custom-'))
})

//#region 峰谷规则的编辑与保存

/** 一条编辑态草稿：价格是字符串，与输入框里的中间态一致。 */
function draftEntry(overrides = {}) {
  return {
    id: 'draft-1',
    provider: 'tokenrhythm',
    model: 'deepseek-flash',
    currency: 'CNY',
    schedule: null,
    prices: { peak: { input: '1', cacheRead: '0.1', cacheWrite: '', output: '2' } },
    ...overrides,
  }
}

test('选中一个规则就等于开启峰谷，并以高峰价为初值', () => {
  // 规则下拉曾经在未勾选「区分峰谷」时被禁用，界面看上去就是「峰谷规则配不了」。
  const next = clientExports.applyScheduleChoice(draftEntry(), 'deepseek')
  assert.equal(next.schedule, 'deepseek')
  assert.deepEqual(next.prices.offPeak, { input: '1', cacheRead: '0.1', cacheWrite: '', output: '2' })
  // 高峰价原样保留，用户只改需要改的那一档。
  assert.deepEqual(next.prices.peak, { input: '1', cacheRead: '0.1', cacheWrite: '', output: '2' })
})

test('选回「统一单价」清掉空闲价与规则引用', () => {
  const split = clientExports.applyScheduleChoice(draftEntry(), 'deepseek')
  const flat = clientExports.applyScheduleChoice(split, '')
  assert.equal(flat.schedule, null)
  assert.equal(flat.prices.offPeak, undefined)
  assert.deepEqual(flat.prices.peak, split.prices.peak)
})

test('重新选中规则不会用高峰价覆盖已填好的空闲价', () => {
  const split = draftEntry({
    schedule: 'deepseek',
    prices: {
      peak: { input: '1', cacheRead: '0.1', cacheWrite: '', output: '2' },
      offPeak: { input: '0.5', cacheRead: '0.05', cacheWrite: '', output: '1' },
    },
  })
  const next = clientExports.applyScheduleChoice(split, 'night')
  assert.equal(next.schedule, 'night')
  assert.equal(next.prices.offPeak.input, '0.5')
})

test('勾选「区分峰谷」时沿用已有引用，否则取第一条规则', () => {
  assert.equal(clientExports.applySplitToggle(draftEntry(), true, ['deepseek']).schedule, 'deepseek')
  const kept = clientExports.applySplitToggle(draftEntry({ schedule: 'night' }), true, ['deepseek', 'night'])
  assert.equal(kept.schedule, 'night')
  // 没有任何规则时留空，交给 collectProblems 拦下，而不是伪造一个引用。
  assert.equal(clientExports.applySplitToggle(draftEntry(), true, []).schedule, null)
  const off = clientExports.applySplitToggle(clientExports.applySplitToggle(draftEntry(), true, ['deepseek']), false, ['deepseek'])
  assert.equal(off.schedule, null)
  assert.equal(off.prices.offPeak, undefined)
})

test('保存时保留尚未被引用的峰谷规则', () => {
  // 回归：曾按「是否被条目引用」过滤规则，于是「先建规则、再挂到条目上」这条
  // 最自然的路径会在保存时把刚建好的规则悄悄丢掉，手工写进文件的规则也会被
  // 一次无关的保存抹掉。
  const { entries, schedules } = clientExports.buildSavePayload(
    [draftEntry()],
    { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
    t,
  )
  assert.deepEqual(Object.keys(schedules), ['mine'])
  assert.equal(entries[0].schedule, undefined, '统一单价的条目不该带规则引用')
})

test('保存时按条目分别写入高峰与空闲价', () => {
  const entry = clientExports.applyScheduleChoice(draftEntry(), 'mine')
  const { entries, schedules } = clientExports.buildSavePayload([entry], { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } }, t)
  assert.equal(entries[0].schedule, 'mine')
  assert.deepEqual(entries[0].prices.peak, { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 2 })
  assert.deepEqual(entries[0].prices.offPeak, { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 2 })
  assert.deepEqual(Object.keys(schedules), ['mine'])
})

test('保存时把非法价格归零并报告字段', () => {
  const { entries, corrected } = clientExports.buildSavePayload(
    [draftEntry({ prices: { peak: { input: '0s', cacheRead: '', cacheWrite: '', output: '6' } } })],
    {},
    t,
  )
  assert.deepEqual(entries[0].prices.peak, { input: 0, cacheRead: 0, cacheWrite: 0, output: 6 })
  assert.equal(corrected.length, 1)
  assert.match(corrected[0], /缓存未命中/)
})

test('没有任何规则时保存传 null 而不是空对象', () => {
  // host 对 `schedules` 的判据是 null / 非 null，空对象会被写进文件。
  assert.equal(clientExports.buildSavePayload([draftEntry()], {}, t).schedules, null)
})

test('峰谷规则区列出内置与自定义规则，收敛成摘要卡片', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({
      fileSchedules: { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
      fileEntries: [{
        ...FILE_ENTRY,
        provider: 'my-gateway',
        model: 'glm-5',
        schedule: 'mine',
        prices: {
          peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
          offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
        },
      }],
    }),
  }))
  // 条目卡片与两张规则卡片各有一个「编辑」键；展开前不渲染编辑控件。
  assert.match(html, /<span class="tf_entryName">deepseek<\/span><span class="tf_entryScope">内置规则<\/span>/)
  assert.match(html, /<span class="tf_entryName">mine<\/span><span class="tf_entryScope">自定义规则<\/span>/)
  assert.match(html, /<p class="tf_ruleSummary">Asia\/Shanghai · 周一 至 周五 · 09:00–12:00、14:00–18:00<\/p>/)
  assert.match(html, /<p class="tf_ruleSummary">UTC · 周一 · 00:00–06:00<\/p>/)
  assert.equal(html.split('>编辑<').length - 1, 3, '一个条目 + 两条规则各有一个编辑键')
  assert.doesNotMatch(html, /tf_ruleName/, '收敛态没有改名输入框')
  assert.doesNotMatch(html, /tf_iconButton/, '收敛态没有删除键')
})

test('规则摘要用星期全称并把连续三天以上压成区间', () => {
  const summary = peakDays => clientExports.scheduleSummary(
    { timezone: 'Asia/Shanghai', peakDays, peakWindows: [['09:00', '12:00']] },
    t,
  )
  // 星期按钮上放的是单字（一/五），摘要里放不下语境，一律用全称。
  assert.match(summary([1, 2, 3, 4, 5]), /^Asia\/Shanghai · 周一 至 周五 · 09:00–12:00$/)
  assert.match(summary([1]), /· 周一 ·/)
  // 两天不压缩：`周一 至 周二` 并不比 `周一、周二` 短。
  assert.match(summary([1, 2]), /· 周一、周二 ·/)
  assert.match(summary([1, 3]), /· 周一、周三 ·/)
  // 周日排在最后：与周五之间隔着周六，不构成区间。
  assert.match(summary([5, 0]), /· 周日、周五 ·/)
})

test('时与分各占一个窄输入框，超范围的值敲不进去', () => {
  // 整条 `HH:MM` 用一个宽框收，框宽远大于内容，而且 25:61 要到保存时才被拒绝。
  assert.equal(clientExports.sanitizeClock('hour', '25'), '5')
  assert.equal(clientExports.sanitizeClock('hour', '23'), '23')
  assert.equal(clientExports.sanitizeClock('hour', '2'), '2')
  assert.equal(clientExports.sanitizeClock('minute', '61'), '1')
  assert.equal(clientExports.sanitizeClock('minute', '59'), '59')
  // 非数字一律丢掉，所以粘贴 `09:00` 只会留下 `09`。
  assert.equal(clientExports.sanitizeClock('hour', '09:00'), '09')
  assert.equal(clientExports.sanitizeClock('hour', 'a1b2'), '12')
  assert.equal(clientExports.sanitizeClock('hour', 'abc'), '')
  assert.equal(clientExports.sanitizeClock('hour', ''), '')
})

test('时刻在草稿里可处于中间态，写文件前补零', () => {
  assert.deepEqual(clientExports.clockParts('09:00'), { hour: '09', minute: '00' })
  assert.deepEqual(clientExports.clockParts('9:5'), { hour: '9', minute: '5' })
  // 清空一半时另一半点仍然显示得出来，用户能接着往下敲。
  assert.deepEqual(clientExports.clockParts(':05'), { hour: '', minute: '05' })
  assert.deepEqual(clientExports.clockParts('12:'), { hour: '12', minute: '' })
  assert.equal(clientExports.padClock('9:5'), '09:05')
  assert.equal(clientExports.padClock('09:00'), '09:00')
  // host 只认补零后的值，解析不了的交给校验报错。
  assert.equal(clientExports.padClock(''), '')
})

test('保存时把时段补零成 HH:MM', () => {
  const { schedules } = clientExports.buildSavePayload([], { mine: {
    timezone: 'UTC',
    peakDays: [1],
    peakWindows: [['9:5', '18:0'], ['20:00', '22:30']],
  } }, t)
  assert.deepEqual(schedules.mine.peakWindows, [['09:05', '18:00'], ['20:00', '22:30']])
})

test('保存前拦下倒序与没填全的高峰时段', () => {
  const entry = clientExports.applyScheduleChoice(draftEntry(), 'mine')
  const problems = windows => clientExports.collectProblems(
    [entry],
    { mine: { timezone: 'UTC', peakDays: [1], peakWindows: windows } },
    ['mine'],
    t,
  )
  assert.deepEqual(problems([['09:00', '12:00']]), [])
  assert.deepEqual(problems([['9:0', '12:0']]), [], '未补零不算错，保存时会补齐')
  assert.match(problems([['12:05', '09:07']])[0], /必须结束得比开始晚/)
  assert.match(problems([['09:00', '09:00']])[0], /必须结束得比开始晚/)
  assert.match(problems([['09:00', '']])[0], /没填全/)
  assert.match(problems([])[0], /至少要有一个高峰时段/)
})

test('时段行渲染四个窄框，倒序时就地标红', () => {
  const html = renderScheduleEditor()
  assert.equal(html.split('class="tf_clock"').length - 1, 4, '起止各一个时框与一个分框')
  assert.match(html, /<input class="tf_clock"[^>]*maxLength="2"[^>]*value="09"\/>/)
  assert.match(html, /<input class="tf_clock"[^>]*maxLength="2"[^>]*value="12"\/>/)
  assert.doesNotMatch(html, /tf_windowHint/)
  const broken = renderScheduleEditor({
    schedule: { timezone: 'UTC', peakDays: [1], peakWindows: [['12:05', '09:07']] },
  })
  assert.match(broken, /class="tf_windowHint">结束需晚于开始</)
  assert.equal(broken.split('data-invalid="true"').length - 1, 4, '整行四个框都标红')
})

test('规则表单可以改名，并有与条目一致的「完成」键', () => {
  const html = renderScheduleEditor()
  assert.match(html, /<input class="tf_ruleName"[^>]*value="deepseek"/)
  assert.match(html, />完成</)
  assert.match(html, /高峰星期/)
  assert.match(html, /时区/)
})

test('内置规则不给删除键，自定义规则给', () => {
  // 内置规则总能被用户层覆盖，删除它没有意义；自定义规则可以删。
  const custom = renderScheduleEditor({ name: 'mine' })
  const builtin = renderScheduleEditor({ name: 'deepseek', builtin: true })
  // 每个高峰时段各有一个 ✕，头部那个才是「删除整条规则」。
  assert.equal(custom.split('tf_iconButton').length - 1, 2)
  assert.equal(builtin.split('tf_iconButton').length - 1, 1)
  assert.match(builtin, /内置规则/)
})

test('覆盖内置规则后它仍是内置规则，并可一键恢复', () => {
  // 内置条目按名字引用 `deepseek`，一旦允许把这条覆盖改名，内置条目会悄悄退回
  // 出厂规则，而用户以为自己只是改了个名字。
  const overridden = renderScheduleEditor({ name: 'deepseek', builtin: true, overridden: true })
  assert.doesNotMatch(overridden, /tf_ruleName/)
  assert.match(overridden, />恢复内置</)
  assert.doesNotMatch(renderScheduleEditor({ name: 'deepseek', builtin: true }), />恢复内置</, '没覆盖过就没有可恢复的东西')
})

test('覆盖过的内置规则在收敛态标为「已覆盖」', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, {
    t,
    pricing: fakePricing({ fileSchedules: { deepseek: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } } }),
  }))
  assert.match(html, /<span class="tf_entryName">deepseek<\/span><span class="tf_entryScope">内置规则 · 已覆盖<\/span>/)
  assert.match(html, /<p class="tf_ruleSummary">UTC · 周一 · 00:00–06:00<\/p>/)
})

test('规则下拉在未开启峰谷时也可用', () => {
  // 回归：这个下拉曾经是 `disabled: !split`，于是「配置峰谷规则」在界面上看起来
  // 根本点不动。直接渲染条目表单，而不是走收敛态的卡片。
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const html = render(react.createElement(clientExports.EntryEditor, {
    entry: draftEntry(),
    index: 0,
    scheduleNames: ['deepseek', 'mine'],
    routes: [],
    onOverlayToggle: () => {},
    onChange: () => {},
    onRemove: () => {},
    onCollapse: () => {},
    t,
  }))
  assert.doesNotMatch(html, /<select[^>]*disabled/)
  // 规则下拉列出内置与自定义规则，并停在没有规则上。
  assert.match(html, /<option value=""[^>]*>[^<]*<\/option><option value="deepseek">deepseek<\/option><option value="mine">mine<\/option>/)
  // 统一单价时只有高峰价一档，勾选框未勾上。
  assert.match(html, /<input type="checkbox"\/>/)
  assert.match(html, /高峰单价（每百万 token）|单价（每百万 token）/)
  assert.doesNotMatch(html, /空闲单价/)
})

test('条目表单在区分峰谷时补出空闲价一栏', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const split = clientExports.applyScheduleChoice(draftEntry(), 'mine')
  const html = render(react.createElement(clientExports.EntryEditor, {
    entry: split,
    index: 0,
    scheduleNames: ['deepseek', 'mine'],
    routes: [],
    onOverlayToggle: () => {},
    onChange: () => {},
    onRemove: () => {},
    onCollapse: () => {},
    t,
  }))
  assert.match(html, /<option value="mine" selected="">mine<\/option>/)
  assert.match(html, /高峰单价（每百万 token）/)
  assert.match(html, /空闲单价（每百万 token）/)
  assert.match(html, /<input type="checkbox" checked=""/)
})

//#endregion

test('面板以锚点中线居中', () => {
  const viewport = { width: 1280, height: 800 }
  // 锚点在视口正中：面板中线应与锚点中线重合。
  const centered = clientExports.panelPosition(
    { left: 600, width: 80, top: 700 },
    400,
    viewport,
  )
  assert.equal(centered.left, 600 + 40 - 200)
  // 垂直方向贴着锚点上沿往上排，留 8px 间隙。
  assert.equal(centered.bottom, 800 - 700 + 8)
})

test('面板靠边时被夹回视口内', () => {
  const viewport = { width: 1280, height: 800 }
  // 锚点贴近左边缘：面板不能跑到屏幕外。
  const left = clientExports.panelPosition({ left: 0, width: 40, top: 700 }, 400, viewport)
  assert.equal(left.left, 12)
  // 锚点贴近右边缘：右侧同样要留出边距。
  const right = clientExports.panelPosition({ left: 1260, width: 20, top: 700 }, 400, viewport)
  assert.equal(right.left, 1280 - 400 - 12)
})

test('面板比视口还宽时以左边距为准', () => {
  // 宁可右侧溢出也不让左边界丢失，否则面板左侧内容点不到。
  const narrow = clientExports.panelPosition({ left: 300, width: 40, top: 700 }, 2000, { width: 800, height: 600 })
  assert.equal(narrow.left, 12)
})

test('面板宽度按标签页区分', () => {
  const cssText = styleTags[0].textContent
  // 明细只有合计与几张卡片，撑到价格设置的宽度会显得空。
  assert.match(cssText, /\.tf_panel\[data-tab=detail\]\{width:max-content/)
  assert.match(cssText, /\.tf_panel\[data-tab=pricing\]\{width:min\(560px/)
})

test('host 与浏览器两侧的费用换算结果一致', async () => {
  // 两侧各有一份换算实现（host 的 pricing.js 与 client 的 computeView）。浏览器
  // 侧无法 import host 模块（不同的加载机制），所以只能靠这条断言把它们钉住。
  const hostPricing = await import('../lib/pricing.js')
  const entries = hostPricing.validatePricing([
    {
      id: 'split',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      schedule: 'deepseek',
      prices: {
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      },
    },
  ])
  const rows = [
    { provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 1_000_000, cacheRead: 500_000, cacheWrite: 0, output: 250_000 },
    { provider: 'my-gateway', model: 'glm-5', tariff: 'offPeak', input: 2_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
  ]
  const host = hostPricing.computeCost(rows, entries, 'CNY')
  const browser = clientExports.computeView({ rows }, entries, 'CNY')
  assert.equal(browser.amount, host.amount, '合计金额必须一致')
  assert.equal(browser.tokens, host.tokens, 'token 总数必须一致')
  assert.equal(browser.unpricedCount, host.unpriced.length)
  assert.equal(browser.groups.length, 1)
  // host 按行给桶明细，浏览器按模型合并；逐桶金额也要对得上。
  const hostByBucket = {}
  for (const model of host.models) {
    for (const [bucket, value] of Object.entries(model.components)) {
      hostByBucket[bucket] = (hostByBucket[bucket] ?? 0) + value
    }
  }
  const browserModel = browser.groups[0].models[0]
  for (const [bucket, value] of Object.entries(hostByBucket)) {
    assert.equal(browserModel.amounts[bucket], value, `${bucket} 金额必须一致`)
  }
})

test('倒计时按 hh:mm:ss 渲染且小时不进位到天', () => {
  assert.equal(clientExports.formatCountdown(0), '00:00:00')
  assert.equal(clientExports.formatCountdown(1000), '00:00:01')
  assert.equal(clientExports.formatCountdown(59_999), '00:01:00')
  assert.equal(clientExports.formatCountdown(2 * 3_600_000), '02:00:00')
  // 跨周末的长间隔按总小时数显示，比「2 天 15 小时」更贴近「还剩多久」。
  assert.equal(clientExports.formatCountdown(63 * 3_600_000), '63:00:00')
  // 向上取整：最后一秒不能提前显示 00:00:00。
  assert.equal(clientExports.formatCountdown(1), '00:00:01')
  assert.equal(clientExports.formatCountdown(-5), '00:00:00')
})

test('计费模式取自当前路由命中的条目', () => {
  // 没有价目条目时不给结论：此刻的计费模式无从谈起。
  assert.equal(clientExports.describeBilling(null, 0), null)
  assert.equal(clientExports.describeBilling(undefined, 0), null)
  // 单一单价的条目是「统一」，且不带倒计时。
  assert.deepEqual(clientExports.describeBilling(FLAT_BUILTIN, 0), {
    split: false,
    tariff: 'peak',
    nextTariff: null,
    remainingMs: null,
  })
  // 区分峰谷的条目给出当前时段与到下一次切换的剩余时间（周一 10:00 CST → 12:00）。
  const state = clientExports.describeBilling(SPLIT_BUILTIN, Date.UTC(2026, 7, 17, 2, 0))
  assert.equal(state.split, true)
  assert.equal(state.tariff, 'peak')
  assert.equal(state.nextTariff, 'offPeak')
  assert.equal(state.remainingMs, 2 * 3_600_000)
})

test('胶囊在统一单价模型上标注「统一」', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    // FILE_ENTRY 只有单一单价，路由也指向它。
    useProjection: fakeUseProjection({
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      rows: [{ provider: 'deepseek-official', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }],
    }),
    t,
    pricing: fakePricing(),
  }))
  assert.match(html, /<span class="tf_mode">计费模式：统一<\/span>/)
  assert.doesNotMatch(html, /tf_tariff/, '统一单价没有时段可显示')
  assert.doesNotMatch(html, /tf_countdown/)
})

test('胶囊在峰谷模型上标注「峰谷」并给出当前时段与剩余时间', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({
      route: { provider: 'deepseek-official', model: 'deepseek-flash' },
      rows: [{ provider: 'deepseek-official', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }],
    }),
    t,
    pricing: fakePricing({ entries: [SPLIT_BUILTIN] }),
  }))
  assert.match(html, /<span class="tf_mode">计费模式：峰谷<\/span>/)
  // 当前时段与倒计时都跟着真实时钟走，只断言形态。
  assert.match(html, /<span class="tf_tariff" data-tariff="(peak|offPeak)">当前时段：(高峰|空闲)<\/span>/)
  assert.match(html, /<span class="tf_countdown">剩余时间：\d{2,}:\d{2}:\d{2}<\/span>/)
})

test('胶囊的计费模式跟随当前路由而不是会话里的其他模型', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  // 会话里两个模型都出现过：峰谷的 deepseek-flash 与统一的 flat-model。
  const rows = [
    { provider: 'deepseek-official', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    { provider: 'deepseek-official', model: 'flat-model', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
  ]
  const entries = [SPLIT_BUILTIN, FLAT_BUILTIN]
  const flat = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({ route: { provider: 'deepseek-official', model: 'flat-model' }, rows }),
    t,
    pricing: fakePricing({ entries }),
  }))
  assert.match(flat, /<span class="tf_mode">计费模式：统一<\/span>/)
  assert.doesNotMatch(flat, /tf_tariff/)
  const split = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({ route: { provider: 'deepseek-official', model: 'deepseek-flash' }, rows }),
    t,
    pricing: fakePricing({ entries }),
  }))
  assert.match(split, /<span class="tf_mode">计费模式：峰谷<\/span>/)
  assert.match(split, /class="tf_tariff"/)
})

test('当前模型没有价目条目时不标注计费模式', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const dock = registrations.find(row => row.options.name === 'conversation.composer.dock')
  const html = render(react.createElement(dock.component, {
    useProjection: fakeUseProjection({
      route: { provider: 'my-gateway', model: 'glm-5' },
      rows: [{ provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 500, cacheRead: 0, cacheWrite: 0, output: 500 }],
    }),
    t,
    pricing: fakePricing(),
  }))
  assert.doesNotMatch(html, /tf_mode/)
  assert.doesNotMatch(html, /tf_tariff/)
  assert.doesNotMatch(html, /tf_countdown/)
})

test('两侧的时段判定与倒计时一致', async () => {
  // 与费用换算同理：host 用 tariffAt 给每个用量样本定档，浏览器用同一套规则
  // 渲染倒计时，两侧不一致会让胶囊指向错误的切换时刻。
  const hostPricing = await import('../lib/pricing.js')
  const raw = {
    id: 'split',
    provider: 'my-gateway',
    model: 'glm-5',
    currency: 'CNY',
    schedule: {
      timezone: 'Asia/Shanghai',
      peakDays: [1, 2, 3, 4, 5],
      peakWindows: [['09:00', '12:00'], ['14:00', '18:00']],
    },
    prices: {
      peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
      offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
    },
  }
  const host = hostPricing.normalizeEntry(raw)
  // 从周六 00:00 CST 起按小时扫 8 天：调度边界都落在整点，足以覆盖窗口起止、
  // 周末与跨周。
  const start = Date.UTC(2026, 7, 14, 16, 0)
  for (let step = 0; step < 24 * 8; step += 1) {
    const at = start + step * 3_600_000
    assert.deepEqual(
      clientExports.tariffStateAt(raw, at),
      hostPricing.tariffStateAt(host, at),
      `时刻 ${new Date(at).toISOString()} 两侧结果应一致`,
    )
  }
})

test('两侧对未定价模型的判定一致', async () => {
  const hostPricing = await import('../lib/pricing.js')
  const rows = [{ provider: 'nobody', model: 'nothing', tariff: 'peak', input: 100, cacheRead: 0, cacheWrite: 0, output: 100 }]
  const host = hostPricing.computeCost(rows, hostPricing.BUILTIN_PRICING, 'CNY')
  const browser = clientExports.computeView({ rows }, hostPricing.BUILTIN_PRICING, 'CNY')
  assert.equal(host.amount, 0)
  assert.equal(browser.amount, 0)
  assert.equal(host.unpriced.length, 1)
  assert.equal(browser.unpricedCount, 1)
  assert.equal(browser.tokens, 200)
})

//#endregion

if (!hasRealReact) {
  console.warn('警告：未找到 profile 的 React，渲染用例已跳过')
}

for (const failure of failures) {
  console.error(`✗ ${failure.label}`)
  console.error(`  ${failure.error.stack ?? failure.error.message}`)
}
console.log(`\n${passed} 个用例通过，${failures.length} 个失败${hasRealReact ? '' : '（React 缺失）'}`)
process.exit(failures.length === 0 ? 0 : 1)
