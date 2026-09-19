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
import { apply, createProjectionDefinition, name, PricingStore, resolveConfig, usageOf } from '../lib/index.js'

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
function fakeContext(services = ['sessionProjections', 'webServer']) {
  const captured = { projections: [], routes: [], effects: 0 }
  const context = {
    inject(deps, callback) {
      if (!deps.some(dep => services.includes(dep))) return
      callback({
        effect(factory) {
          captured.effects += 1
          const disposer = factory()
          return typeof disposer === 'function' ? disposer : () => {}
        },
        sessionProjections: {
          register(definition) {
            captured.projections.push(definition)
            return () => {}
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

await test('未匹配价目的供应商仍被记录', () => {
  const store = new PricingStore(resolveConfig(undefined))
  const definition = createProjectionDefinition(store)
  const { view } = drive(definition, [
    headerEvent(0, 'my-gateway', 'deepseek-flash'),
    assistantEvent(1, 1, 0, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].provider, 'my-gateway')
  assert.equal(view.rows[0].tariff, 'peak')
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

//#endregion

for (const failure of failures) {
  console.error(`✗ ${failure.label}`)
  console.error(`  ${failure.error.stack ?? failure.error.message}`)
}
console.log(`\n${passed} 个用例通过，${failures.length} 个失败`)
process.exit(failures.length === 0 ? 0 : 1)
