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
      return { IconDatabaseOutline16: () => null }
    }
    throw new Error(`未预期的模块请求：${id}`)
  }
}

const clientExports = loaded.factory(makeRequire())

//#endregion

//#region 测试替身

/** 价目表句柄替身：只提供组件读取所需的最小面。 */
function fakePricing(overrides = {}) {
  const snapshot = {
    status: 'ready',
    error: null,
    data: {
      displayCurrency: 'CNY',
      entries: [{
        id: 'mine',
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        currency: 'CNY',
        schedule: null,
        prices: { peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 } },
      }],
      builtin: [],
      schedules: {},
      builtinSchedules: { deepseek: { timezone: 'Asia/Shanghai', peakDays: [1], peakWindows: [['09:00', '12:00']] } },
      file: { path: '/tmp/token-fee.json', exists: false, entries: [], schedules: null, error: null },
      configEntryCount: 0,
    },
  }
  return {
    get: () => snapshot,
    subscribe: () => () => {},
    load: async () => {},
    save: async () => snapshot.data,
    reset: async () => snapshot.data,
    ...overrides,
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
