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

await test('apply 注册投影与四个端点', () => {
  const { context, captured } = fakeContext()
  apply(context, undefined)
  assert.equal(captured.projections.length, 1)
  assert.equal(captured.projections[0].key, 'tokenFee')
  assert.deepEqual(captured.routes.map(route => route.path).sort(), [
    '/api/token-fee/pricing',
    '/api/token-fee/pricing/reset',
    // 路由建议拆成独立端点：模型发现可能很慢，不能拖住胶囊要读的价目表。
    '/api/token-fee/routes',
    '/api/token-fee/subagents',
  ].sort())
})

/**
 * 驱动一个 GET 端点并等它写出响应。
 * @param route - 要驱动的路由。
 * @param url - 可选的请求路径（含查询串）；不给时只有 `/`。
 * @returns 响应替身。
 */
async function getRoute(route, url) {
  const request = {
    method: 'GET',
    url,
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

await test('子代理端点只算子会话自己那段，不重算父会话的种子', async () => {
  // DSH 以「新建会话 id + 把父会话事件当种子写进子会话日志」启动 fork / 子代理会话。
  // 整段折叠会把父会话的钱在每个子会话里各算一遍——实测一个会话带四个子代理时，
  // 四个卡片各自显示同样的 1068.6M token / ¥48.16，合计直接四倍。
  const header = { id: 'child', createdAt: 1 }
  const events = [
    // 种子：路由（必须照常折叠，否则子会话自己的请求没有 route）+ 父会话的用量
    { seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } },
    { seq: 1, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: { inputTokens: 1_000_000 } } },
    // 子会话自己的一段
    { seq: 2, type: 'assistant/message', time: 3, data: { turn: 1, step: 2, usage: { inputTokens: 2_000_000 } } },
  ]
  const available = {
    sessionQuery: {
      async observeSession() {
        return {
          source: 'prepared',
          header,
          inheritedEventCount: 2,
          events,
          [Symbol.dispose]() {},
        }
      },
    },
  }
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'], available)
  apply(context, undefined)
  const route = captured.routes.find(item => item.path === '/api/token-fee/subagents')
  const response = await getRoute(route, '/api/token-fee/subagents?ids=child')
  const [row] = response.payload.children
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(row.rows), `rows 应是数组：${JSON.stringify(row)}`)
  const tokens = row.rows.reduce((sum, item) => sum + item.input + item.cacheRead + item.cacheWrite + item.output, 0)
  assert.equal(tokens, 2_000_000, `只该算子会话自己的 2M，实际 ${tokens}（种子被重算就是 3M）`)
})

await test('子代理端点按会话观测返回用量，并释放观测', async () => {
  // 走 `sessionQuery.observeSession(id)`：它对活会话与已结束会话统一处理，再按
  // `inheritedEventCount` 只折会话自己那段——最初按 `ctx.sessions.get` + 投影缓存
  // 拼的那版在真实环境里子代理全部读不到用量。
  const disposed = []
  const seedHeader = { seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } }
  const message = { seq: 1, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: { inputTokens: 10 } } }
  const available = {
    sessionQuery: {
      async observeSession(id) {
        if (id === 'boom') throw new Error('会话不存在')
        return {
          source: 'prepared',
          header: { id, createdAt: 1 },
          inheritedEventCount: 0,
          // 'empty' 有观测但没有用量事件：应落成 no-usage 而不是报错。
          events: id === 'empty' ? [seedHeader] : [seedHeader, message],
          [Symbol.dispose]() {
            disposed.push(id)
          },
        }
      },
    },
  }
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'], available)
  apply(context, undefined)
  const route = captured.routes.find(item => item.path === '/api/token-fee/subagents')
  const response = await getRoute(route, '/api/token-fee/subagents?ids=live,empty,boom')
  assert.equal(response.status, 200)
  const [live, empty, boom] = response.payload.children
  assert.equal(live.id, 'live')
  assert.deepEqual(live.rows, [
    { provider: 'p', model: 'm', tariff: 'flat', input: 10, cacheRead: 0, cacheWrite: 0, output: 0 },
  ], '折出的行应原样带回')
  assert.equal(live.source, 'prepared')
  // 空数组 = 这个子代理（及其派生）确实没产生用量，是确凿的 0，不是「读不到」。
  assert.deepEqual(empty.rows, [], '没有用量的子代理应回空数组')
  assert.equal(empty.reason, null, '没有用量不是错误，不该给 reason')
  assert.equal(boom.rows, null, '观测失败才是「读不到」')
  assert.match(boom.reason, /^observe-failed/)
  // 观测对象必须释放，否则会一直持有那个会话。
  assert.deepEqual(disposed.sort(), ['empty', 'live'])
})

await test('子代理端点递归收集孙代用量，并给出嵌套数量', async () => {
  // DSH 的 subagentCatalog 只登记**直接**子会话，因此孙代必须由插件自己往下走；
  // 否则多级委派会静默少算钱，而 README 声称「覆盖整棵子树」。
  // 子会话目录由插件自己从 `subagent/catalog` 事件折（端点用 `projectionMode: 'none'`，
  // 不让框架为这条会话水合所有已注册投影）。
  const catalogEvents = ids => ids.map((childId, index) => ({
    seq: 10 + index,
    type: 'subagent/catalog',
    time: 3,
    data: { version: 1, childId, childCreatedAt: 1, mode: 'one-shot', label: childId },
  }))
  const header = { seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } }
  const message = (tokens) => ({ seq: 1, type: 'assistant/message', time: 2, data: { turn: 1, step: 1, usage: { inputTokens: tokens } } })
  const available = {
    sessionQuery: {
      async observeSession(id) {
        const own = { source: 'prepared', header: { id, createdAt: 1 }, inheritedEventCount: 0, [Symbol.dispose]() {} }
        // child → grandchild → great-grandchild（深度 3，撞上 MAX_SUBAGENT_DEPTH 之前）
        if (id === 'child') return { ...own, events: [header, message(1), ...catalogEvents(['grandchild'])] }
        if (id === 'grandchild') return { ...own, events: [header, message(2), ...catalogEvents(['great'])] }
        if (id === 'great') return { ...own, events: [header, message(4), ...catalogEvents([])] }
        return { ...own, events: [header, ...catalogEvents([])] }
      },
    },
  }
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'], available)
  apply(context, undefined)
  const route = captured.routes.find(item => item.path === '/api/token-fee/subagents')
  const response = await getRoute(route, '/api/token-fee/subagents?ids=child')
  const [child] = response.payload.children
  assert.equal(child.descendants, 2, `应报出两个后代（孙代 + 曾孙代），实际响应：${JSON.stringify(response.payload)}`)
  const total = child.rows.reduce((sum, row) => sum + row.input, 0)
  assert.equal(total, 1 + 2 + 4, `应把整棵子树的用量都算进来，实际 ${total}`)
})

await test('子代理 id 超过上限时回被截断的数量，而不是静默丢弃', async () => {
  const available = {
    sessionQuery: {
      async observeSession(id) {
        return {
          source: 'prepared',
          header: { id, createdAt: 1 },
          inheritedEventCount: 0,
          events: [{ seq: 0, type: 'request/header', time: 1, data: { header: { config: { provider: 'p', model: 'm' } } } }],
          projections: { values: { subagentCatalog: [] } },
          [Symbol.dispose]() {},
        }
      },
    },
  }
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'], available)
  apply(context, undefined)
  const route = captured.routes.find(item => item.path === '/api/token-fee/subagents')
  const ids = Array.from({ length: 70 }, (_, index) => `s${index}`).join(',')
  const response = await getRoute(route, `/api/token-fee/subagents?ids=${ids}`)
  assert.equal(response.payload.children.length, 64, '只处理前 64 个')
  assert.equal(response.payload.truncated, 6, '被截掉的 6 个必须报出来')
})

await test('缺 sessionQuery 时子代理端点说明原因而不是报错', async () => {
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'], {})
  apply(context, undefined)
  const route = captured.routes.find(item => item.path === '/api/token-fee/subagents')
  const response = await getRoute(route, '/api/token-fee/subagents?ids=abc')
  assert.equal(response.status, 200, '缺服务也要 200，面板才能显示原因')
  assert.equal(response.payload.children[0].reason, 'no-query')
  assert.equal(response.payload.children[0].rows, null)
})

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

await test('状态版本的进位不重叠：指纹先对进位基数取模', async () => {
  // 指纹是 32 位哈希（上界 4294967295），而进位基数只取 1e9——约 77% 的指纹大于它。
  // 不取模的话，指纹会溢出到高一档 FOLD_VERSION 的区间：例如「折叠版本 3、指纹
  // 1e9+5」与「折叠版本 4、指纹 5」会算出同一个状态版本，检查点因此不失效，历史
  // 样本按旧表冻结。
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const store = new PricingStore(resolveConfig({ pricingFile: join(dir, 'token-fee.json') }))
  const SCALE = 1e9
  assert.ok(Number.isSafeInteger(store.projectionVersion()))
  // 直接构造一个大于进位基数的指纹：断言取模后的组合，而不是「% SCALE 相等」
  // ——后者对取模与否都成立（3*SCALE + r ≡ r (mod SCALE)），是个假断言。
  store.revision = SCALE + 5
  assert.equal(store.projectionVersion(), 3 * SCALE + 5, '指纹必须先取模再进位')
  // 不取模会得到 4*SCALE + 5，与「折叠版本 4、指纹 5」撞车。
  assert.notEqual(store.projectionVersion(), 4 * SCALE + 5)
  // 取模不改变低 9 位以内的指纹（常见情况）。
  store.revision = 12345
  assert.equal(store.projectionVersion(), 3 * SCALE + 12345)
})

await test('空条目表可以保存，且内置层照常生效', async () => {
  // 规则区与条目区各自独立，文档把「先建规则、再挂到条目上」写成了正常顺序，
  // 因此只有 schedules、还没有任何条目的文件必须存得下去。
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.save({
    version: 1,
    schedules: { mine: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] } },
    entries: [],
  })
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(written.entries, [])
  assert.deepEqual(Object.keys(written.schedules), ['mine'])
  assert.equal(store.fileError, null, '空条目表不是错误')
  // 内置层仍在：条目为空不等于「没有价格」。
  assert.ok(store.entries.length >= 2, `内置条目应仍在，实际 ${store.entries.length}`)
  assert.ok(store.schedules.mine !== undefined, '用户规则应生效')
  assert.ok(store.schedules.deepseek !== undefined, '内置规则应仍在')
})

await test('汇率写在用户文件里：进快照、配置层覆盖、改完通知订阅者', async () => {
  // 汇率从 cordis.yml 迁到 token-fee.json：改完即生效（mtime 缓存），配置层仍可覆盖。
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({ version: 1, exchangeRates: { USD: 7.2, EUR: 7.8 }, entries: [] }), 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file, exchangeRates: { EUR: 8.1 } }))
  await store.refresh()
  assert.deepEqual(store.snapshot().exchangeRates, { USD: 7.2, EUR: 8.1 }, '配置层应覆盖同名币种，其余沿用文件')
  assert.deepEqual(store.snapshot().file.exchangeRates, { USD: 7.2, EUR: 7.8 }, '文件层要单独可见：保存时写回它')
  assert.deepEqual(store.snapshot().configExchangeRates, { EUR: 8.1 })

  const versionBefore = store.projectionVersion()
  let notified = 0
  const off = store.onChange(() => { notified += 1 })
  // 只改汇率：必须通知（否则面板上的折算合计要等重启才更新），但**不能**动状态版本
  // （那会把所有会话的检查点作废、白折一遍历史）。
  await writeFile(file, JSON.stringify({ version: 1, exchangeRates: { USD: 7.35 }, entries: [] }), 'utf8')
  await store.refresh()
  assert.equal(notified, 1, '只改汇率也要通知订阅者')
  assert.equal(store.projectionVersion(), versionBefore, '汇率不进折叠语义，状态版本不该变')
  // 文件里只写了 USD，但配置层的 EUR 仍在：两层是叠加的，不是互斥的。
  assert.deepEqual(store.snapshot().exchangeRates, { USD: 7.35, EUR: 8.1 }, '文件层改完即刻生效，配置层照旧')
  assert.deepEqual(store.snapshot().file.exchangeRates, { USD: 7.35 }, '文件里原来的 EUR 应随之消失')
  off()
})

await test('只改价格/备注不作废检查点，改规则才作废', async () => {
  // `projectionVersion()` 进检查点的 `stateVersion`：它一变，DSH 就把整段日志从 seq 0
  // 重折。价格只影响展示换算、不影响时段归属，因此**不该**进指纹；规则（时区 / 高峰
  // 星期 / 窗口 / 节假日）才会改变 `tariff` 标签，必须进。
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const base = {
    id: 'mine',
    provider: 'my-gateway',
    model: 'deepseek-flash',
    currency: 'CNY',
    schedule: { timezone: 'Asia/Shanghai', peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00']] },
    prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 }, offPeak: { input: 0.5, cacheRead: 0, cacheWrite: 0, output: 1 } },
  }
  const write = async (entry) => {
    await writeFile(file, JSON.stringify({ version: 1, entries: [entry] }), 'utf8')
    await store.refresh()
  }
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await write(base)
  const baseline = store.projectionVersion()
  assert.ok(Number.isSafeInteger(baseline))

  // 改价格：展示金额变了，但时段归属没变 → 版本不变。
  await write({ ...base, prices: { peak: { input: 9, cacheRead: 0, cacheWrite: 0, output: 18 }, offPeak: { input: 4.5, cacheRead: 0, cacheWrite: 0, output: 9 } } })
  assert.equal(store.projectionVersion(), baseline, '改价格不应作废历史检查点')
  // 改备注 / 币种 / id 同理。
  await write({ ...base, note: '备注不影响折叠', currency: 'USD', id: 'mine-renamed' })
  assert.equal(store.projectionVersion(), baseline, '改备注/币种/id 不应作废历史检查点')
  // 把 `offPeak` 去掉 = 从峰谷两档变成统一单价：`tariff` 标签语义变了 → 版本必须变。
  await write({ ...base, prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } })
  const flat = store.projectionVersion()
  assert.notEqual(flat, baseline, '有没有空闲价会改变 tariff 标签，必须作废')
  // 改高峰窗口 → 时段归属变了 → 版本必须变。
  await write({
    ...base,
    prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } },
    schedule: { ...base.schedule, peakWindows: [['10:00', '12:00']] },
  })
  assert.notEqual(store.projectionVersion(), flat, '改高峰窗口必须作废')
})

await test('文件里的汇率非法时整份文件被拒，内置层照常生效', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  await writeFile(file, JSON.stringify({
    version: 1,
    exchangeRates: { USD: 0 },
    entries: [{
      id: 'a', provider: 'p', model: 'm', currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    }],
  }), 'utf8')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.refresh()
  assert.match(store.fileError ?? '', /exchangeRates\.USD 必须是正数/, '错误信息要点名哪一项')
  assert.equal(store.snapshot().file.entries.length, 0, '整份文件被拒，条目也不生效')
  assert.ok(store.entries.length >= 2, '内置层仍在')
  assert.deepEqual(store.snapshot().exchangeRates, {})
})

await test('保存时带上汇率，落盘后仍可读回', async () => {
  // 设置页保存是整份覆盖写：不带 exchangeRates 就等于把汇率清空。
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  await store.save({ version: 1, exchangeRates: { USD: 7.2 }, entries: [] })
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(written.exchangeRates, { USD: 7.2 })
  assert.deepEqual(store.snapshot().exchangeRates, { USD: 7.2 }, '保存后立即生效')
  // 空表不落盘：文件里只留真正配过的币种。
  await store.save({ version: 1, entries: [] })
  assert.equal(JSON.parse(await readFile(file, 'utf8')).exchangeRates, undefined)
})

await test('同一进程内并发保存各写各的临时文件', async () => {
  // 临时名曾经只带 pid：同一进程里两次并发保存会撞同一个文件名，一个写到一半被另一
  // 个截断。现在带随机后缀，两次并发保存都应产出完整文件。
  const { mkdtemp, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const store = new PricingStore(resolveConfig({ pricingFile: file }))
  const entry = (id) => ({
    id, provider: 'p', model: 'm', currency: 'CNY',
    prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
  })
  await Promise.all([
    store.save({ version: 1, entries: [entry('a')] }),
    store.save({ version: 1, entries: [entry('b')] }),
  ])
  // 落盘内容必须是两次之一，且是完整可解析的 JSON（不是被截断的半截文件）。
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.ok(['a', 'b'].includes(written.entries[0].id))
  assert.equal(store.fileError, null)
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
  // 2 条内置条目 + 用户条目按 (provider, model, currency) 顶掉 deepseek-official/deepseek-flash。
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

await test('保存请求不带 exchangeRates 时保留文件里现有的汇率（只有显式 {} 才清空）', async () => {
  // 保存是整份覆盖写，旧版客户端（以及任何忘记带这个键的调用方）会把汇率当删除。
  // 端点必须有兜底：`undefined` = 没提这件事 → 保留；`null`/`{}` = 明确清空。
  const { mkdtemp, readFile, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  const entry = {
    id: 'mine',
    provider: 'my-gateway',
    model: 'deepseek-flash',
    currency: 'CNY',
    prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2 } },
  }
  await writeFile(file, JSON.stringify({ version: 1, exchangeRates: { USD: 7.2, EUR: 7.8 }, entries: [entry] }), 'utf8')
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: file })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')

  const post = async (payload) => {
    const request = {
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'x-dsh-token-fee-action': 'save', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(payload))
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
    await route.handler(request, response)
    return response
  }

  const omitted = await post({ entries: [entry] })
  assert.equal(omitted.status, 200)
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).exchangeRates, { USD: 7.2, EUR: 7.8 }, '不带这个键时必须原样保留')
  assert.deepEqual(omitted.payload.exchangeRates, { USD: 7.2, EUR: 7.8 }, '响应快照里也应还在')

  const cleared = await post({ entries: [entry], exchangeRates: {} })
  assert.equal(cleared.status, 200)
  assert.equal(JSON.parse(await readFile(file, 'utf8')).exchangeRates, undefined, '显式空表才清空')
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

await test('用户文件无效时拒绝覆盖写入（409），force 才允许', async () => {
  // 文件读不出来时有效层已回落到内置、编辑器草稿是空的；此时一次保存会把用户手写的
  // 全部条目覆盖成空表（v0.6.0 实测会丢数据）。host 必须自己挡一道。
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const file = join(dir, 'token-fee.json')
  // 缺 id 的条目：host 判定整份文件无效。
  const broken = '{"version":1,"entries":[{"provider":"p","model":"m","prices":{"peak":{"input":1}}}]}'
  await writeFile(file, broken, 'utf8')
  const { context, captured } = fakeContext(['sessionProjections', 'webServer'])
  // 让端点用的 store 指向临时文件；apply 内部的 store 才是被测的那个。
  apply(context, { pricingFile: file })
  const route = captured.routes.find(item => item.path === '/api/token-fee/pricing')
  const post = async (body) => {
    const request = {
      method: 'POST',
      headers: { host: '127.0.0.1:3080', 'x-dsh-token-fee-action': 'save', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body))
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
    await route.handler(request, response)
    return response
  }

  const refused = await post({ entries: [] })
  assert.equal(refused.status, 409)
  assert.equal(refused.payload.error, 'file-invalid')
  assert.match(refused.payload.message, /拒绝覆盖写入/)
  assert.equal(await readFile(file, 'utf8'), broken, '拒绝时文件必须原样保留')

  const forced = await post({ entries: [], force: true })
  assert.equal(forced.status, 200, '显式 force 应允许覆盖')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).entries, [])
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

await test('GET /pricing 不被模型发现阻塞（路由建议走独立端点）', async () => {
  // 旧实现把 `llm.listModels` await 在 GET /pricing 里：适配器模型发现一慢，
  // 胶囊要读的价目表就跟着等。现在 /pricing 只读缓存，慢的发现交给后台/独立端点。
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const llm = {
    listProviders: () => [{ id: 'slow', name: 'Slow' }],
    // 永远不 resolve：只要端点 await 它，这条用例就会挂死。
    listModels: () => new Promise(() => {}),
  }
  const { context, captured } = fakeContext(undefined, { llm })
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/pricing')
  const response = captureResponse()
  await route.handler(getRequest(), response)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.routes, [], '冷缓存时先给空数组，模型发现留在后台')
  assert.ok(Array.isArray(response.payload.entries), '价目表本身照常返回')
})

await test('路由建议独立端点返回 provider 与模型，且带 30 秒缓存', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  let modelCalls = 0
  const llm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'my-gateway', name: 'My Gateway' },
      { id: 'broken', name: 'Broken' },
    ],
    listModels: async (provider) => {
      modelCalls += 1
      if (provider === 'broken') throw new Error('NO_ADAPTER')
      return provider === 'deepseek-official'
        ? [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }]
        : [{ id: 'glm-5', name: 'GLM-5' }]
    },
  }
  const { context, captured } = fakeContext(undefined, { llm })
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/routes')
  const first = captureResponse()
  await route.handler(getRequest(), first)
  assert.equal(first.status, 200)
  assert.deepEqual(first.payload.routes, [
    { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] },
    { id: 'my-gateway', name: 'My Gateway', models: [{ id: 'glm-5', name: 'GLM-5' }] },
    // 模型发现失败只影响建议列表，路由本身仍可用。
    { id: 'broken', name: 'Broken', models: [] },
  ])
  const callsAfterFirst = modelCalls
  // 30 秒内重复请求命中缓存：不再调 llm。
  const second = captureResponse()
  await route.handler(getRequest(), second)
  assert.deepEqual(second.payload.routes, first.payload.routes)
  assert.equal(modelCalls, callsAfterFirst, '缓存期内不应重复调用 llm.listModels')
})

await test('缺少 llm 服务时路由建议为空而不是请求失败', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'token-fee-'))
  const { context, captured } = fakeContext()
  apply(context, { pricingFile: join(dir, 'token-fee.json') })
  const route = captured.routes.find(row => row.path === '/api/token-fee/routes')
  const response = captureResponse()
  await route.handler(getRequest(), response)
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
  // 条目可以为空：规则区独立于条目区，只写 schedules 的文件必须存得下去。
  // 但**非数组**仍是形状错误，照旧拒绝。
  assert.equal(validate({ pricing: [] }).issues, undefined, '空价目表是合法的（等于不加任何条目）')
  assert.ok(validate({ pricing: {} }).issues, '非数组仍应被拒绝')
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
