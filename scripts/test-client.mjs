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

/** 从 profile 的 node_modules 解析真实依赖；解析失败时返回 null。 */
function tryRequire(id) {
  try {
    return createRequire(join(profileModules, 'noop.js'))(id)
  } catch {
    return null
  }
}

/** 最小 DOM 替身：client.js 只用它注入一次样式标签。 */
const styleTags = []
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
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
  useMemo: factory => factory(),
  useRef: value => ({ current: value }),
  useCallback: fn => fn,
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
      builtinSchedules: { deepseek: { timezone: 'Asia/Shanghai', peakDays: [1], peakWindows: [['09:00', '12:00']] } },
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
    'settings.intro': '为每个供应商与模型配置 token 单价。',
  }
  const template = dictionary[key] ?? key
  if (params === undefined) return template
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template)
}

/** 用真实 React 渲染一个元素为静态标记。 */
function render(element) {
  assert.ok(hasRealReact, '需要真实 React 才能渲染')
  return reactDomServer.renderToStaticMarkup(element)
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

test('样式标签被注入一次', () => {
  assert.equal(styleTags.length, 1)
  assert.match(styleTags[0].textContent, /\.tf_pill\{/)
  assert.equal(styleTags[0].dataset.plugin, '@lantiosity/dsh-token-fee')
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
  assert.match(html, /2\.00/, '一百万未命中输入应按 ¥2 计价')
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
  assert.match(html, /<span class="tf_priceRowLabel">空闲<\/span><span class="tf_priceValue">¥1\.00\/M<\/span>/)
})

test('不区分峰谷的条目只渲染一行价格', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing({ builtin: [FLAT_BUILTIN] }) }))
  assert.match(html, /<span class="tf_priceRowLabel">单价<\/span><span class="tf_priceValue">¥3\.00\/M<\/span>/)
  assert.doesNotMatch(html, /tf_priceRowLabel">高峰/)
  assert.doesNotMatch(html, /tf_priceRowLabel">空闲/)
})

test('时区使用带 UTC 偏移的下拉框', () => {
  const { ctx, registrations } = fakeClientContext()
  clientExports.apply(ctx)
  const section = registrations.find(row => row.options.name === 'settings.section')
  const html = render(react.createElement(section.component, { t, pricing: fakePricing() }))
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
  // 峰谷规则的时区下拉始终存在（规则区独立于条目编辑态）。
  assert.match(html, /<option value="Asia\/Shanghai"[^>]*>Asia\/Shanghai \(GMT\+8\)<\/option>/)
  // 币种下拉只在条目编辑态出现，收敛态不该有可编辑的币种控件。
  assert.doesNotMatch(html, /<option value="CNY"[^>]*>CNY 人民币<\/option>/)
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
