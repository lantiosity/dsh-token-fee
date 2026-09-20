#!/usr/bin/env node
/**
 * dsh-token-fee host 半冒烟测试。
 *
 * 在真实 cordis 之外驱动 `apply`：用一个最小上下文替身接管 `ctx.inject`，
 * 捕获投影注册与 HTTP 路由注册，然后直接折叠事件、读取投影视图、调用端点。
 *
 * 运行：node scripts/test-host.mjs
 */

import assert from 'node:assert/strict'
import { apply, Config, createProjectionDefinition, name, PricingStore, resolveConfig, usageOf } from '../lib/index.js'
import { tariffAt } from '../lib/pricing.js'

let passed = 0
const failures = []

/** 运行一个用例并记录结果。 */
async function test(label, body) {
  try {
    await body()
    passed += 1
  } catch (error) {
    failures.push({ label, error })
  }
}

/** 构造一个捕获注册行为的 host 上下文替身。 */
/**
 * 构造一个捕获注册行为的 host 上下文替身。
 * @param services - 视为已注入的服务名。
 * @param available - `ctx.get(name)` 能读到的可选服务。
 */
function fakeContext(services = ['sessionProjections', 'webServer'], available = {}) {
  const captured = { projections: [], disposed: [], routes: [], effects: 0 }
  const context = {
    get: name => available[name],
    inject(deps, callback) {
      if (!deps.some(dep => services.includes(dep))) return
      callback({
        get: name => available[name],
        effect(factory) {
          captured.effects += 1
          const disposer = factory()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        sessionProjections: {
          register(definition) {
            captured.projections.push(definition)
            return () => { captured.disposed.push(definition) }
          },
        },
        webServer: {
          register(route) {
            captured.routes.push(route)
            return () => {}
          },
        },
      })
    },
  }
  return { context, captured }
}

/** 构造一个 GET 请求替身。 */
function getRequest() {
  return {
    method: 'GET',
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
}

/** 构造一个记录状态与响应体的响应替身。 */
function captureResponse() {
  return {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
}

/** 等待一个 handler 写完响应。 */
async function settle(response) {
  await new Promise((resolve) => {
    const check = () => (response.payload === null ? setTimeout(check, 5) : resolve())
    check()
  })
}

/** 构造一条 `assistant/message` 事件。 */
function assistantEvent(seq, turn, step, usage) {
  return {
    type: 'assistant/message',
    seq,
    time: Date.UTC(2026, 7, 17, 2, 0),
    data: { turn, step, message: { content: [] }, stream: [], usage },
  }
}

/** 构造一条 `request/header` 事件。 */
function headerEvent(seq, provider, model) {
  return {
    type: 'request/header',
    seq,
    time: Date.UTC(2026, 7, 17, 2, 0),
    data: { header: { config: { provider, model } }, reason: 'initial' },
  }
}

/** 用一组事件驱动一个投影定义，返回最终状态与视图。 */
function drive(definition, events) {
  let state = definition.init()
  for (const event of events) state = definition.apply(state, event)
  return { state, view: definition.wire.view(state) }
}

//#region 用例

await test('插件名为 token-fee', () => {
  assert.equal(name, 'token-fee')
})

await test('默认配置使用人民币与 DSH_HOME 下的用户文件', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.displayCurrency, 'CNY')
  assert.ok(config.pricingFile.endsWith('token-fee.json'))
})

await test('非法展示币种在装载时失败', () => {
  assert.throws(() => resolveConfig({ displayCurrency: 'RMB' }), /displayCurrency/)
})

await test('apply 注册投影与两个端点', () => {
  const { context, captured } = fakeContext()
  apply(context, undefined)
  assert.equal(captured.projections.length, 1)
  assert.equal(captured.projections[0].key, 'tokenFee')
  assert.deepEqual(captured.routes.map(route => route.path).sort(), [
    '/api/token-fee/pricing',
    '/api/token-fee/pricing/reset',
  ])
})

/** 驱动一个 GET 端点并等它写出响应。 */
async function getRoute(route) {
  const request = {
    method: 'GET',
    headers: { host: '127.0.0.1:3080', accept: 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
  const response = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
  await route.handler(request, response)
  return response
}

await test('价目表一变，投影状态版本就变，订阅者也收到通知', async () => {
  // 折叠会把「样本属于哪个时段」写进持久化状态，而那是纯粹由价目表决定的派生值。
  // 状态版本带着表指纹，检查点因此随表失效，历史样本会被按新表重折。
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  const before = store.projectionVersion()
  assert.ok(Number.isSafeInteger(before) && before >= 0)
  const seen = []
  const off = store.onChange(() => seen.push(store.projectionVersion()))

  await writeFile(file, JSON.stringify({
    version: 1,
    entries: [{
      id: 'a',
      provider: 'p',
      model: 'm',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  await store.refresh()
  const after = store.projectionVersion()
  assert.notEqual(after, before, '表变了版本必须变')
  assert.deepEqual(seen, [after], '订阅者应恰好收到一次通知')

  // 内容没变时 refresh 走 mtime 短路，不该重复通知。
  await store.refresh()
  assert.equal(seen.length, 1)
  off()
})

await test('改价目表后投影注册被重装，版本号随之更新', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: file })
  // 文件还不存在，首次 refresh 不会改表，因此只注册了一次。
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(captured.projections.length, 1, '文件不存在时不该重装')
  const first = captured.projections[0].stateVersion

  await writeFile(file, JSON.stringify({
    version: 1,
    entries: [{
      id: 'a',
      provider: 'p',
      model: 'm',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = await getRoute(route)
  assert.equal(response.status, 200)
  assert.equal(captured.projections.length, 2, '表变了应重新注册投影')
  assert.equal(captured.disposed.length, 1, '旧注册应先撤下')
  assert.notEqual(captured.projections[1].stateVersion, first)
})

await test('缺少服务时 apply 不注册任何东西', () => {
  const { context, captured } = fakeContext([])
  apply(context, undefined)
  assert.equal(captured.projections.length, 0)
  assert.equal(captured.routes.length, 0)
})

await test('投影按 (provider, model) 分桶折叠用量', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { state, view } = drive(definition, [
    headerEvent(0, 'deepseek-official', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }),
    headerEvent(2, 'my-gateway', 'glm-5'),
    assistantEvent(3, 1, 1, { inputTokens: 10, outputTokens: 5 }),
  ])
  assert.equal(view.rows.length, 2)
  const flash = view.rows.find(row => row.model === 'deepseek-flash')
  assert.equal(flash.provider, 'deepseek-official')
  assert.equal(flash.input, 100)
  assert.equal(flash.cacheRead, 50)
  assert.equal(flash.output, 20)
  assert.equal(flash.tariff, 'peak')
  const glm = view.rows.find(row => row.model === 'glm-5')
  assert.equal(glm.provider, 'my-gateway')
  assert.equal(glm.input, 10)
  assert.equal(state.route.provider, 'my-gateway')
})

await test('同一步骤的后续样本替换先前样本', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    headerEvent(0, 'deepseek-official', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
    assistantEvent(2, 1, 0, { inputTokens: 250, outputTokens: 40 }),
  ])
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].input, 250)
  assert.equal(view.rows[0].output, 40)
})

await test('重试事件关闭替换槽位，重试用量另行累加', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    headerEvent(0, 'deepseek-official', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
    { type: 'llm/retry-started', seq: 2, time: Date.UTC(2026, 7, 17, 2, 0), data: { turn: 1, step: 0 } },
    assistantEvent(3, 1, 0, { inputTokens: 30, outputTokens: 5 }),
  ])
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].input, 130)
  assert.equal(view.rows[0].output, 15)
})

await test('高峰与空闲用量落入不同的桶', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const peak = assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 })
  const offPeak = {
    ...assistantEvent(3, 2, 0, { inputTokens: 40, outputTokens: 4 }),
    time: Date.UTC(2026, 7, 17, 5, 0),
  }
  const { view } = drive(definition, [
    headerEvent(0, 'deepseek-official', 'deepseek-flash'),
    peak,
    offPeak,
  ])
  assert.equal(view.rows.length, 2)
  assert.deepEqual(view.rows.map(row => row.tariff).sort(), ['offPeak', 'peak'])
  assert.equal(view.rows.find(row => row.tariff === 'peak').input, 100)
  assert.equal(view.rows.find(row => row.tariff === 'offPeak').input, 40)
})

await test('未匹配价目的供应商仍被记录，且标为不分峰谷', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    headerEvent(0, 'my-gateway', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].provider, 'my-gateway')
  // 兜底不能是 `peak`：条目还不存在时两档价格都不存在，把它记成高峰会让
  // 「高峰用量」凭空变大，而且投影状态持久化后这个标签就冻结了。
  assert.equal(view.rows[0].tariff, 'flat')
})

await test('只有统一单价的条目也标为不分峰谷', () => {
  const store = new PricingStore(resolveConfig({
    pricing: [{
      id: 'flat',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    headerEvent(0, 'my-gateway', 'glm-5'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.equal(view.rows[0].tariff, 'flat')
})

await test('request/context 也能更新路由', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    { type: 'request/context', seq: 0, time: Date.UTC(2026, 7, 17, 2, 0), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    assistantEvent(1, 1, 0, { inputTokens: 7, outputTokens: 3 }),
  ])
  assert.equal(view.rows[0].model, 'deepseek-v4-pro')
  assert.equal(view.rows[0].input, 7)
})

await test('没有路由时用量被忽略', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 })])
  assert.equal(view.rows.length, 0)
})

await test('状态 schema 接受自产状态并拒绝垃圾', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { state } = drive(definition, [
    headerEvent(0, 'deepseek-official', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
  ])
  const roundTripped = definition.stateSchema.parse(JSON.parse(JSON.stringify(state)))
  assert.deepEqual(roundTripped, state)
  assert.throws(() => definition.stateSchema.parse(null))
  assert.throws(() => definition.stateSchema.parse({ rows: { a: { input: -1 } } }))
})

await test('usageOf 读取消息用量与流内用量', () => {
  assert.deepEqual(usageOf(assistantEvent(1, 1, 0, { inputTokens: 3, outputTokens: 4 })), { inputTokens: 3, outputTokens: 4 })
  const attempt = {
    type: 'assistant/attempt',
    seq: 2,
    time: 0,
    data: { turn: 1, step: 0, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } } }] },
  }
  assert.deepEqual(usageOf(attempt), { inputTokens: 9, outputTokens: 1 })
  assert.equal(usageOf({ type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } }), undefined)
})

await test('PricingStore 读取用户文件并覆盖内置层', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    entries: [{
      id: 'mine',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  const snapshot = store.snapshot()
  assert.equal(snapshot.file.exists, true)
  assert.equal(snapshot.file.error, null)
  assert.equal(snapshot.entries.length, 2)
  assert.equal(snapshot.entries.find(entry => entry.id === 'mine').prices.peak.input, 1)
  assert.equal(snapshot.file.path, file)
})

await test('用户文件里的命名调度覆盖内置规则，并作用到内置条目', async () => {
  // 「先建规则、再挂到条目上」以及「改内置规则」都必须真的生效：内置条目引用
  // 的是命名规则 `deepseek`，所以文件里的同名覆盖会一路作用到内置条目的时段判定。
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    schedules: { deepseek: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
    entries: [{
      id: 'mine',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  const snapshot = store.snapshot()
  assert.equal(snapshot.file.error, null)
  assert.equal(snapshot.schedules.deepseek.timezone, 'UTC')
  const flash = snapshot.entries.find(entry => entry.model === 'deepseek-flash')
  // 周一 00:30 UTC：出厂规则（北京时间 08:30）是空闲，覆盖后的规则是高峰。
  assert.equal(tariffAt(flash, Date.UTC(2026, 7, 17, 0, 30)), 'peak')
})

await test('损坏的用户文件被报告且不污染有效表', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, '{ not json', 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  const snapshot = store.snapshot()
  assert.match(snapshot.file.error, /无效/)
  assert.equal(snapshot.entries.length, 2)
})

await test('缺失的用户文件回落到内置层', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const store = new PricingStore(resolveConfig({ pricingFile: join(dir, 'absent.json') }))
  await store.refresh()
  const snapshot = store.snapshot()
  assert.equal(snapshot.file.exists, false)
  assert.equal(snapshot.file.error, null)
  assert.equal(snapshot.entries.length, 2)
})

await test('保存端点落盘时保留条目对命名调度的字符串引用', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: file })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  assert.ok(route, '保存端点应已注册')

  const body = JSON.stringify({
    entries: [{
      id: 'mine',
      provider: 'my-gateway',
      model: 'deepseek-flash',
      currency: 'CNY',
      schedule: 'deepseek',
      prices: { peak: { input: 1.5, cacheRead: 0.03, cacheWrite: 0, output: 6 } },
    }],
  })
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'x-dsh-token-fee-action': 'save', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  const response = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
  route.handler(request, response)
  await new Promise((resolve) => {
    const check = () => (response.payload === null ? setTimeout(check, 5) : resolve())
    check()
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.entries[0].schedule, 'deepseek', '命名引用必须原样落盘')
  assert.equal(response.payload.entries.find(entry => entry.id === 'mine').schedule.timezone, 'Asia/Shanghai')
})

await test('尚未被条目引用的调度也会原样落盘', async () => {
  // 界面上「先建规则、再挂到条目上」是最自然的操作顺序，host 不得因为一条规则
  // 暂时没有被引用就把它丢掉——那会让刚建好的规则在保存时凭空消失。
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: file })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  assert.ok(route, '保存端点应已注册')

  const body = JSON.stringify({
    schedules: { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
    entries: [{
      id: 'mine',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  })
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'x-dsh-token-fee-action': 'save', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body)
    },
  }
  const response = {
    status: 0,
    payload: null,
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.payload = JSON.parse(text)
    },
  }
  route.handler(request, response)
  await new Promise((resolve) => {
    const check = () => (response.payload === null ? setTimeout(check, 5) : resolve())
    check()
  })
  assert.equal(response.status, 200)
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.schedules.mine.timezone, 'UTC', '未被引用的规则也要落盘')
  assert.equal(response.payload.file.schedules.mine.peakWindows[0][1], '06:00', 'GET 要把它还给编辑器')
  assert.equal(response.payload.schedules.mine.timezone, 'UTC', '有效调度表里也要有它')
})

await test('非回环来源被端点拒绝', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end() {},
  }
  route.handler({
    method: 'GET',
    headers: { host: 'example.com' },
    socket: { remoteAddress: '203.0.113.5' },
    async *[Symbol.asyncIterator]() {},
  }, response)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(response.status, 403)
})

await test('reset 清空用户层，回到内置条目', async () => {
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    entries: [{
      id: 'mine',
      provider: 'my-gateway',
      model: 'deepseek-flash',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  assert.equal(store.snapshot().entries.length, 3)
  await store.reset()
  const after = store.snapshot()
  assert.equal(after.entries.length, 2)
  assert.equal(after.file.exists, false)
  assert.equal(after.file.entries.length, 0)
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' })
})

await test('GET 端点返回已配置的 provider 与模型建议', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const llm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'my-gateway', name: 'My Gateway' },
      { id: 'broken', name: 'Broken' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('NO_ADAPTER')
      return provider === 'deepseek-official'
        ? [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }]
        : [{ id: 'glm-5', name: 'GLM-5' }]
    },
  }
  const { context, captured } = fakeContext(undefined, { llm })
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = captureResponse()
  route.handler(getRequest(), response)
  await settle(response)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.routes, [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] },
    { id: 'my-gateway', name: 'My Gateway', models: [{ id: 'glm-5', name: 'GLM-5' }] },
    { id: 'broken', name: 'Broken', models: [] },
  ])
})

await test('缺少 llm 服务时路由建议为空而不是请求失败', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = captureResponse()
  route.handler(getRequest(), response)
  await settle(response)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.routes, [])
})

await test('handler 必须把 Promise 交给 webserver', () => {
  // webserver 用 await route.handler(...) 并挂 .catch() 做 per-request 兜底；
  // handler 返回 undefined 会让兜底失效，逃逸的 rejection 落到 app-boot 的全局
  // unhandledRejection 处理器，而它会直接 process.exit(1)。
  const { context, captured } = fakeContext()
  apply(context, {})
  for (const route of captured.routes) {
    const result = route.handler(getRequest(), captureResponse())
    assert.ok(result instanceof Promise, `${route.path} 的 handler 必须返回 Promise`)
    // 让被拒绝的 Promise 有归属，避免测试进程自己触发 unhandledRejection。
    result.catch(() => {})
  }
})

await test('llm.listProviders 抛错时端点仍返回 200', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const llm = {
    listProviders: () => { throw new Error('llm exploded') },
    listModels: async () => [],
  }
  const { context, captured } = fakeContext(undefined, { llm })
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = captureResponse()
  await route.handler(getRequest(), response)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.routes, [])
  assert.equal(response.payload.ok, true)
})

await test('GET 同时返回归一化层与原始层', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    schedules: { 'my-peak': { timezone: 'Asia/Shanghai', peakDays: [1], peakWindows: [['09:00', '12:00']] } },
    entries: [{
      id: 'named',
      provider: 'my-gateway',
      model: 'glm-5',
      currency: 'CNY',
      schedule: 'my-peak',
      prices: {
        peak: { input: 2, cacheRead: 0.04, cacheWrite: 0, output: 8 },
        offPeak: { input: 1, cacheRead: 0.02, cacheWrite: 0, output: 4 },
      },
    }],
  }), 'utf8')
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: file })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = captureResponse()
  await route.handler(getRequest(), response)
  const { file: payload } = response.payload
  // 归一化层：调度已展开为内联对象，供计价与只读展示。
  assert.equal(typeof payload.entries[0].schedule, 'object')
  assert.equal(payload.entries[0].schedule.timezone, 'Asia/Shanghai')
  // 原始层：命名引用保持字符串，编辑草稿靠它才能不丢引用。
  assert.equal(payload.rawEntries[0].schedule, 'my-peak')
})

await test('reset 失败时返回 500 而不是让异常逃逸', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  // 把价目表路径指向一个目录：rm(force) 删不掉目录，必然抛错。
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: dir })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing/reset')
  const request = {
    method: 'POST',
    headers: { host: '127.0.0.1:3080', 'x-dsh-token-fee-action': 'reset' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  }
  const response = captureResponse()
  await route.handler(request, response)
  assert.equal(response.status, 500)
  assert.equal(response.payload.ok, false)
  assert.equal(response.payload.error, 'reset-failed')
})

await test('Config 是 Standard Schema，填默认值并拒绝未知键', () => {
  // cordis 只调 Config['~standard'].validate（vendor/cordis/src/fiber.ts:53），
  // 要求同步返回 { value } 或 { issues }。
  assert.equal(Config['~standard'].version, 1)
  const validate = Config['~standard'].validate
  assert.deepEqual(validate(undefined), { value: { displayCurrency: 'CNY' } })
  assert.deepEqual(
    validate({ displayCurrency: 'USD', pricingFile: 'x.json' }).value,
    { displayCurrency: 'USD', pricingFile: 'x.json' },
  )
  // 未知键必须报错而不是被静默忽略——这是补 Config 的主要收益。
  const unknown = validate({ displayCurrancy: 'USD' })
  assert.equal(unknown.issues.length, 1)
  assert.match(unknown.issues[0].message, /未知配置项/)
  assert.match(unknown.issues[0].message, /displayCurrency/)
  assert.ok(validate({ displayCurrency: 'RMB' }).issues, '拼错的币种应被拒绝')
  assert.ok(validate({ pricingFile: '   ' }).issues, '空路径应被拒绝')
  assert.ok(validate('nope').issues, '非对象应被拒绝')
  assert.ok(validate({ pricing: [] }).issues, '空价目表应被拒绝')
})

await test('Config 校验是同步的（cordis 不支持异步校验）', () => {
  const result = Config['~standard'].validate({ displayCurrency: 'CNY' })
  assert.equal(typeof result?.then, 'undefined', 'validate 不得返回 Promise')
})

//#endregion

for (const failure of failures) {
  console.error(`✗ ${failure.label}`)
  console.error(`  ${failure.error.stack ?? failure.error.message}`)
}
console.log(`\n${passed} 个用例通过，${failures.length} 个失败`)
process.exit(failures.length === 0 ? 0 : 1)
