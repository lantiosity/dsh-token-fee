#!/usr/bin/env node
/**
 * 组件级用例：真正驱动 `PricingEditor` 的保存按钮，检查它发给
 * `POST /api/token-fee/pricing` 的请求体。
 *
 * 为什么单独一个套件：`test-client.mjs` 用 `react-dom/server` 渲染静态 HTML，只能断言
 * 「长什么样」，不能执行 `onClick`。而 v0.6.0 之后的两次汇率回归都出在**真实调用点**上
 * ——helper 返回了 `exchangeRates`，组件却把它解构成条目数组再取 `.exchangeRates`
 * （恒为 undefined），保存照旧清空用户文件；静态断言和「直接调用 api.save」的用例
 * 都咬不住。这里用最小 React 替身直接执行组件函数与事件处理器。
 *
 * 运行：node scripts/test-editor.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let passed = 0
const failures = []

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name}`)
    console.log(`  ${error?.message ?? error}`)
  }
}

/** 最小 DOM 替身：客户端半在模块顶层会碰 `document`/`window`。 */
function installBrowserGlobals() {
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
    head: { appendChild() {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    visibilityState: 'visible',
  }
  globalThis.window = { innerWidth: 1280, innerHeight: 900, addEventListener: () => {}, removeEventListener: () => {} }
}

/**
 * 载入客户端半并返回 `{ exports, requests }`。
 *
 * 每次调用都带查询串重新 import：`lib/client.js` 在求值时会向
 * `window.__ModuleLoader__.load` 注册自己，复用同一实例会拿到上一次的模块缓存。
 * @param snapshotOverrides - 覆盖快照里的字段（例如 `file`）。
 */
async function loadHarness(snapshotOverrides = {}) {
  installBrowserGlobals()
  let registered = null
  globalThis.window.__ModuleLoader__ = { load(spec) { registered = spec } }
  const clientUrl = pathToFileURL(join(ROOT, 'lib', 'client.js')).href
  await import(`${clientUrl}?v=${Date.now()}-${Math.random()}`)

  // hooks 替身：只给初值，setter 是空操作。保存按钮的处理器读的是本次渲染的闭包，
  // 因此足以覆盖「点了保存之后发什么请求」。
  const reactStub = {
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
    useCallback: (fn) => fn,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    Fragment: 'Fragment',
  }
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'Fragment',
  }
  const primitives = {
    Button: (props) => ({ type: 'button', props }),
    Menu: (props) => ({ type: 'menu', props }),
    IconDatabaseOutlineRegular: () => null,
    IconChevronDownOutlineRegular: () => null,
  }
  const exports = registered.factory((id) => {
    if (id === 'react') return reactStub
    if (id === 'react/jsx-runtime') return jsxRuntime
    if (id === 'react-dom') return { createPortal: (node) => node }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${id}`)
  })

  const requests = []
  globalThis.fetch = async (path, init) => {
    requests.push({ path, init })
    const body = { ok: true, ...snapshot(requests) }
    return { ok: true, status: 200, json: async () => body }
  }

  /** 载入后保存会返回的快照。 */
  function snapshot() {
    const fileEntries = snapshotOverrides.fileEntries ?? [
      { id: 'mine', provider: 'p', model: 'm', currency: 'CNY', prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    ]
    return {
      displayCurrency: 'CNY',
      exchangeRates: { USD: 7.2 },
      entries: fileEntries,
      builtin: [],
      schedules: {},
      builtinSchedules: {},
      holidaySets: {},
      configExchangeRates: {},
      configEntryCount: 0,
      routes: [],
      file: {
        path: '/tmp/token-fee.json',
        exists: true,
        entries: fileEntries,
        rawEntries: fileEntries,
        schedules: null,
        exchangeRates: { USD: 7.2 },
        error: snapshotOverrides.fileError ?? null,
        ...(snapshotOverrides.file ?? {}),
      },
    }
  }

  const api = exports.createPricingApi()
  await api.load(false)
  return { exports, requests, api, t: makeTranslate() }
}

/** 翻译替身：未知键回退为键名，与其它套件一致。 */
function makeTranslate() {
  const translate = (key) => String(key)
  return new Proxy(translate, { get: () => translate })
}

/** 深度遍历元素树，按可见文本找带 `onClick` 的节点。 */
function findClickable(node, label) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findClickable(child, label)
      if (hit !== null) return hit
    }
    return null
  }
  const props = node.props ?? {}
  const children = props.children
  const labelled = children === label || (Array.isArray(children) && children.length === 1 && children[0] === label)
  if (labelled && typeof props.onClick === 'function') return node
  return findClickable(children ?? null, label)
}

await test('保存按钮发出的请求体带上文件层汇率（真实组件路径）', async () => {
  const { exports, requests, api, t } = await loadHarness()
  const element = exports.PricingEditor({ pricing: api, t, onOverlayToggle: () => {} })
  const save = findClickable(element, 'editor.save')
  assert.ok(save !== null, '组件树里应有保存按钮')
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const posts = requests.filter((entry) => entry.init?.method === 'POST')
  assert.equal(posts.length, 1, `应发出一次 POST，实际 ${posts.length}`)
  const body = JSON.parse(posts[0].init.body)
  assert.deepEqual(body.exchangeRates, { USD: 7.2 }, `请求体必须带文件层汇率，实际键：${Object.keys(body).join(',')}`)
  assert.ok(Array.isArray(body.entries), 'entries 应是数组')
})

await test('文件无效时保存按钮不发请求', async () => {
  const { exports, requests, api, t } = await loadHarness({ fileError: '价目表文件无效：entries[0].id 不能为空' })
  const element = exports.PricingEditor({ pricing: api, t, onOverlayToggle: () => {} })
  const save = findClickable(element, 'editor.save')
  assert.ok(save !== null, '组件树里应有保存按钮')
  save.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(requests.filter((entry) => entry.init?.method === 'POST').length, 0, '文件无效时不应发保存请求')
})

await test('没有配汇率时请求体不写这个键（交给 host 保留原值）', async () => {
  const { exports, requests, api, t } = await loadHarness({ file: { exchangeRates: {} }, fileEntries: [
    { id: 'mine', provider: 'p', model: 'm', currency: 'CNY', prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
  ] })
  const element = exports.PricingEditor({ pricing: api, t, onOverlayToggle: () => {} })
  findClickable(element, 'editor.save').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const posts = requests.filter((entry) => entry.init?.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal('exchangeRates' in JSON.parse(posts[0].init.body), false)
})

if (failures.length > 0) {
  console.log(`\n${passed} 个用例通过，${failures.length} 个失败（组件级）`)
  process.exit(1)
}
console.log(`\n${passed} 个用例通过，0 个失败（组件级）`)
