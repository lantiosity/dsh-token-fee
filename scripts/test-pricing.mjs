#!/usr/bin/env node
/**
 * dsh-token-fee 纯函数测试：价目表校验、匹配优先级、峰谷判定与费用换算。
 *
 * 运行：node scripts/test-pricing.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BUILTIN_PRICING,
  BUILTIN_SCHEDULES,
  computeCost,
  costOfEntry,
  matchEntry,
  mergeExchangeRates,
  mergePricingLayers,
  normalizeEntry,
  normalizeExchangeRates,
  normalizeHolidaySets,
  sameExchangeRates,
  tariffAt,
  tariffOf,
  tariffStateAt,
  validatePricing,
  validateSchedules,
} from '../lib/pricing.js'

/** 随包发布的节假日数据，与 host 半读的是同一个文件。 */
const CN_HOLIDAY_SETS = normalizeHolidaySets(
  JSON.parse(readFileSync(new URL('../data/cn-holidays.json', import.meta.url), 'utf8')).sets,
)

let passed = 0
const failures = []

/** 运行一个用例并记录结果。 */
function test(name, body) {
  try {
    body()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

/** 一个可用的条目模板。 */
function entry(overrides = {}) {
  return {
    id: 'e1',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 } },
    ...overrides,
  }
}

/** 带峰谷两档价格并引用内置 deepseek 调度的条目模板。 */
function splitEntry(overrides = {}) {
  return entry({
    schedule: 'deepseek',
    prices: {
      peak: { input: 2, cacheRead: 0.04, output: 8 },
      offPeak: { input: 1, cacheRead: 0.02, output: 4 },
    },
    ...overrides,
  })
}

//#region 校验

test('内置表一条条目覆盖 DeepSeek 的两条路由', () => {
  // 官方 API 与「DeepSeek 账号」共用同一份模型目录与同一份价目，因此只按官方
  // 路由 id 各建一条条目，账号路由经 provider 别名命中同一条——列表里是一条。
  assert.equal(BUILTIN_PRICING.length, 2)
  assert.deepEqual(BUILTIN_PRICING.map(item => item.id), [
    'builtin-deepseek-official-flash-cny',
    'builtin-deepseek-official-v4-pro-cny',
  ])
  for (const item of BUILTIN_PRICING) {
    assert.equal(item.provider, 'deepseek-official')
    assert.equal(item.currency, 'CNY')
  }
  // 两条路由、两个模型，四组身份两两命中同一条。
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const official = matchEntry(BUILTIN_PRICING, 'deepseek-official', model)
    const account = matchEntry(BUILTIN_PRICING, 'deepseek-account', model)
    assert.ok(official !== null && account !== null, `${model} 两条路由都应命中`)
    assert.equal(account.id, official.id, `${model} 的账号路由应命中同一条内置条目`)
  }
})

test('内置条目带有峰谷两档价格与调度', () => {
  for (const item of BUILTIN_PRICING) {
    assert.ok(item.prices.offPeak, `${item.id} 缺少空闲价`)
    // 命名引用而非内联对象：内置条目每次重建有效表都会重新解析它，用户在内置
    // 规则上的改动才能作用到内置条目。
    assert.equal(item.schedule, 'deepseek', `${item.id} 应引用命名规则`)
    assert.equal(item.prices.offPeak.input * 2, item.prices.peak.input)
  }
  const item = normalizeEntry(BUILTIN_PRICING[0], 'builtin')
  assert.equal(item.schedule.timezone, 'Asia/Shanghai')
  assert.deepEqual([...item.schedule.peakDays], [1, 2, 3, 4, 5])
})

test('覆盖内置规则后，内置条目的时段判定跟着变', () => {
  // 用户在内置 deepseek 规则上改时区 / 时段（例如官方调整了高峰时间）时，内置
  // 条目必须跟着走；内联对象会让它们永远停在出厂规则上。
  const overridden = validateSchedules({
    deepseek: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] },
  })
  const entries = mergePricingLayers([BUILTIN_PRICING], overridden)
  const flash = entries.find(item => item.model === 'deepseek-flash')
  // 周一 00:30 UTC：出厂规则（北京时间 08:30）是空闲，覆盖后的规则是高峰。
  const at = Date.UTC(2026, 7, 17, 0, 30)
  assert.equal(tariffAt(flash, at), 'peak')
  assert.equal(tariffAt(normalizeEntry(BUILTIN_PRICING[0]), at), 'offPeak')
})

test('缺少 model 的条目被拒绝', () => {
  assert.throws(() => normalizeEntry({ id: 'x', prices: { peak: {} } }), /model/)
})

test('非法币种被拒绝', () => {
  assert.throws(() => normalizeEntry(entry({ currency: 'RMB1' })), /currency/)
})

test('负价格被拒绝', () => {
  assert.throws(() => normalizeEntry(entry({ prices: { peak: { input: -1, cacheRead: 0, output: 0 } } })), /input/)
})

test('配置了空闲价却没有调度会被拒绝', () => {
  assert.throws(
    () => normalizeEntry(entry({ prices: { peak: { input: 1, cacheRead: 0, output: 1 }, offPeak: { input: 1, cacheRead: 0, output: 1 } } })),
    /offPeak/,
  )
})

test('引用未定义的调度名会被拒绝', () => {
  assert.throws(() => normalizeEntry(entry({ schedule: 'nope' })), /未定义的调度/)
})

test('字符串调度被展开为完整规则', () => {
  const normalized = normalizeEntry(entry({ schedule: 'deepseek' }))
  assert.deepEqual(normalized.schedule.timezone, 'Asia/Shanghai')
  assert.deepEqual([...normalized.schedule.peakWindows], [['09:00', '12:00'], ['14:00', '18:00']])
})

test('id 重复的价目表被拒绝', () => {
  assert.throws(() => validatePricing([entry(), entry()]), /重复/)
})

test('同层内 (provider, model, currency) 重复被拒绝', () => {
  // 两条 id 不同、身份相同的条目会在合并时静默让后一条覆盖前一条，而编辑器两条都显示：
  // 用户改的价可能根本没生效。同层内必须 fail-loud；跨层覆盖是设计如此。
  assert.throws(
    () => validatePricing([entry({ id: 'a' }), entry({ id: 'b' })]),
    /\(provider, model, currency\) 相同/,
  )
  // 币种不同 = 不同身份（多币种并列是支持的）。
  assert.doesNotThrow(() => validatePricing([entry({ id: 'a' }), entry({ id: 'b', currency: 'USD' })]))
  // 跨层同身份覆盖仍然允许（用户层覆盖内置层）。
  const lower = validatePricing([entry({ id: 'builtin' })])
  const upper = [entry({ id: 'mine', prices: { peak: { input: 9, cacheRead: 0, cacheWrite: 0, output: 18 } } })]
  const merged = mergePricingLayers([lower, upper])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'mine')
  assert.equal(merged[0].prices.peak.input, 9)
})

test('未知字段被拒绝（拼错键不再静默变成另一种语义）', () => {
  // `provder` 拼错会让 provider 回落成通配 `*`，把某供应商价格套到所有供应商；
  // `cache_read` 拼错会静默按 0 计。两者都「保存成功、界面正常」，只能在报错里暴露。
  assert.throws(() => normalizeEntry(entry({ provder: 'p' }), 'x'), /含未知字段：provder/)
  assert.throws(
    () => normalizeEntry(entry({ prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 2, cache_read: 3 } } }), 'x'),
    /含未知字段：cache_read/,
  )
  assert.throws(
    () => validateSchedules({ s: { timezone: 'UTC', peakDays: [1], peakWindows: [['09:00', '10:00']], holiday: [] } }),
    /含未知字段：holiday/,
  )
  // 已知字段照常通过（含合并进来的顶层配置层）。
  assert.doesNotThrow(() => normalizeEntry(entry({ note: '备注', source: 'x' }), 'x'))
})

test('非法时区被拒绝', () => {
  assert.throws(() => validateSchedules({ bad: { timezone: 'Mars/Olympus', peakDays: [1], peakWindows: [['09:00', '10:00']] } }), /时区/)
})

test('倒置的时段区间被拒绝', () => {
  assert.throws(() => validateSchedules({ bad: { timezone: 'UTC', peakDays: [1], peakWindows: [['12:00', '09:00']] } }), /区间/)
})

//#endregion

//#region 匹配

test('精确身份优先于通配', () => {
  const entries = validatePricing([
    entry({ id: 'wild', provider: '*', prices: { peak: { input: 99, cacheRead: 0, output: 0 } } }),
    entry({ id: 'exact', prices: { peak: { input: 2, cacheRead: 0, output: 0 } } }),
  ])
  assert.equal(matchEntry(entries, 'deepseek-official', 'deepseek-flash').id, 'exact')
})

test('provider 通配优先于全通配', () => {
  const entries = validatePricing([
    entry({ id: 'all', provider: '*', model: '*' }),
    entry({ id: 'provider', provider: '*', model: 'deepseek-flash' }),
  ])
  assert.equal(matchEntry(entries, 'my-gateway', 'deepseek-flash').id, 'provider')
})

test('未配置的供应商不会套用官方价', () => {
  const entries = validatePricing([entry()])
  assert.equal(matchEntry(entries, 'my-gateway', 'deepseek-flash'), null)
})

test('历史路由 id deepseek 回退到官方条目', () => {
  const entries = validatePricing([entry()])
  assert.equal(matchEntry(entries, 'deepseek', 'deepseek-flash').id, 'e1')
})

test('已下线模型名回退到在售模型名', () => {
  const entries = validatePricing([entry()])
  assert.equal(matchEntry(entries, 'deepseek-official', 'deepseek-v4-flash').id, 'e1')
})

test('DeepSeek 账号路由回退到官方条目', () => {
  // DSH 有两条 DeepSeek 路由：`deepseek-official`（API key，llm-deepseek-api-key）
  // 与 `deepseek-account`（账号令牌，llm-deepseek-account，界面里叫「DeepSeek 账号」）。
  // 两者共用同一套 Messages 传输与同一份模型目录，这里验的是**别名回退**本身：
  // 表里只有官方条目时，账号路由仍要能命中它（兜住没被显式列出的模型 id）。
  const entries = validatePricing([entry()])
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-flash').id, 'e1')
  // 官方侧的旧模型名 deepseek-v4-flash 由模型别名接手，两条路由都适用。
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-v4-flash').id, 'e1')
  assert.equal(matchEntry(entries, 'deepseek-official', 'deepseek-v4-flash').id, 'e1')
})

test('账号路由经别名命中同一条内置条目', () => {
  // 端到端：账号路由的 (provider, model) 组合命中官方那条内置条目，命中结果的
  // provider 仍是条目自己的 `deepseek-official`——别名只影响匹配，不改写条目。
  for (const [model, id] of [
    ['deepseek-flash', 'builtin-deepseek-official-flash-cny'],
    ['deepseek-v4-pro', 'builtin-deepseek-official-v4-pro-cny'],
  ]) {
    const hit = matchEntry(BUILTIN_PRICING, 'deepseek-account', model)
    assert.equal(hit?.id, id)
    assert.equal(hit?.provider, 'deepseek-official')
    // 与官方路由命中的是同一条。
    assert.equal(hit, matchEntry(BUILTIN_PRICING, 'deepseek-official', model))
  }
  // 账号侧如果出现官方侧的旧模型名，仍由模型别名回退到同一条 flash 条目。
  assert.equal(
    matchEntry(BUILTIN_PRICING, 'deepseek-account', 'deepseek-v4-flash')?.id,
    'builtin-deepseek-official-flash-cny',
  )
})

test('用户为账号路由单独配置的条目优先于别名回退', () => {
  // 别名的语义是「回退」，精确命中永远先赢——账号路由若另有价，用户加一条即可。
  const entries = validatePricing([
    entry(),
    entry({ id: 'e2', model: 'deepseek-v4-pro' }),
    {
      id: 'acct',
      provider: 'deepseek-account',
      model: 'deepseek-v4-flash',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
    },
  ])
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-v4-flash').id, 'acct')
  // 未单独配置的账号侧模型仍走别名回退。
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-v4-pro').id, 'e2')
})

test('用户条目可覆盖内置条目的价格', () => {
  const merged = mergePricingLayers([
    BUILTIN_PRICING,
    validatePricing([{
      id: 'mine',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      currency: 'CNY',
      prices: { peak: { input: 1.5, cacheRead: 0.03, output: 6 } },
    }]),
  ])
  const hit = matchEntry(merged, 'deepseek-official', 'deepseek-flash')
  assert.equal(hit.id, 'mine')
  assert.equal(hit.prices.peak.input, 1.5)
  // 覆盖按 (provider, model, currency) 身份替换，因此只顶掉这一条。
  assert.equal(merged.length, 2)
})

test('账号路由可以单独定价，不影响官方路由', () => {
  // 别名只负责「精确命中失败后回退」，因此给账号路由加一条同身份条目即可把它
  // 单独拎出来定价——这也是合并成一条内置条目之后仍然保留的能力。
  const merged = mergePricingLayers([
    BUILTIN_PRICING,
    validatePricing([{
      id: 'acct-mine',
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      currency: 'CNY',
      prices: { peak: { input: 1, cacheRead: 0.01, output: 2 } },
    }]),
  ])
  // 账号路由是新的 (provider, model, currency) 身份，因此是新增而不是替换。
  assert.equal(merged.length, 3)
  assert.equal(matchEntry(merged, 'deepseek-account', 'deepseek-flash').id, 'acct-mine')
  assert.equal(matchEntry(merged, 'deepseek-account', 'deepseek-flash').prices.peak.input, 1)
  // 官方路由仍是内置价。
  assert.equal(matchEntry(merged, 'deepseek-official', 'deepseek-flash').id, 'builtin-deepseek-official-flash-cny')
  assert.equal(matchEntry(merged, 'deepseek-official', 'deepseek-flash').prices.peak.input, 2)
  // 账号路由没被单独定价的那个模型仍回退到内置条目。
  assert.equal(matchEntry(merged, 'deepseek-account', 'deepseek-v4-pro').id, 'builtin-deepseek-official-v4-pro-cny')
})

//#endregion

//#region 多币种

/** 一条人民币与一条美元条目的混合表。 */
const MIXED_ENTRIES = validatePricing([
  { id: 'cny', provider: 'p', model: 'm-cny', currency: 'CNY', prices: { peak: { input: 2, cacheRead: 0, cacheWrite: 0, output: 8 } } },
  { id: 'usd', provider: 'p', model: 'm-usd', currency: 'USD', prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 4 } } },
])

/** 百万未命中输入：人民币 2 元、美元 1 元。 */
const MIXED_ROWS = [
  { provider: 'p', model: 'm-cny', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
  { provider: 'p', model: 'm-usd', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
]

test('汇率表合并：文件层在前，配置层覆盖同名字段', () => {
  // 汇率现在主要写在 token-fee.json 里，cordis.yml 那份保留为管理员覆盖，
  // 层次顺序与价目表一致（内置 → 用户文件 → 插件配置）。
  const file = normalizeExchangeRates({ USD: 7.2, EUR: 7.8 }, 'CNY')
  const config = normalizeExchangeRates({ EUR: 8.1, JPY: 0.05 }, 'CNY')
  const merged = mergeExchangeRates(file, config)
  assert.deepEqual(merged, { USD: 7.2, EUR: 8.1, JPY: 0.05 })
  assert.ok(Object.isFrozen(merged))
  // 缺一层时就是另一层。
  assert.deepEqual(mergeExchangeRates(file, undefined), { USD: 7.2, EUR: 7.8 })
  assert.deepEqual(mergeExchangeRates(undefined, config), { EUR: 8.1, JPY: 0.05 })
  assert.deepEqual(mergeExchangeRates(undefined, undefined), {})
})

test('汇率表等价判定：只改汇率时不当作表变化', () => {
  // 汇率只影响展示、不影响折叠语义，因此不能进 tableRevision——否则改一次汇率
  // 就会把所有会话的检查点作废、白折一遍历史。
  assert.equal(sameExchangeRates({ USD: 7.2 }, { USD: 7.2 }), true)
  assert.equal(sameExchangeRates({}, {}), true)
  assert.equal(sameExchangeRates(undefined, {}), true)
  assert.equal(sameExchangeRates({ USD: 7.2 }, { USD: 7.3 }), false)
  assert.equal(sameExchangeRates({ USD: 7.2 }, { USD: 7.2, EUR: 7.8 }), false)
  assert.equal(sameExchangeRates({ USD: 7.2, EUR: 7.8 }, { USD: 7.2 }), false)
})

test('汇率表校验：合法表被冻结，非法值报错', () => {
  const rates = normalizeExchangeRates({ USD: 7.2 }, 'CNY')
  assert.equal(rates.USD, 7.2)
  assert.ok(Object.isFrozen(rates))
  assert.deepEqual(normalizeExchangeRates(undefined, 'CNY'), {})
  assert.throws(() => normalizeExchangeRates([], 'CNY'), /必须是对象/)
  assert.throws(() => normalizeExchangeRates({ USD: 0 }, 'CNY'), /必须是正数/)
  assert.throws(() => normalizeExchangeRates({ USD: -1 }, 'CNY'), /必须是正数/)
  assert.throws(() => normalizeExchangeRates({ USD: '7.2' }, 'CNY'), /必须是正数/)
  assert.throws(() => normalizeExchangeRates({ NO_SUCH: 1 }, 'CNY'), /币种代码/)
  // 展示币种自身是折算目标，出现在表里说明用户误解了方向。
  assert.throws(() => normalizeExchangeRates({ CNY: 1 }, 'CNY'), /不应包含展示币种/)
})

test('未配汇率时并列列出各币种，且不给折算合计', () => {
  const view = computeCost(MIXED_ROWS, MIXED_ENTRIES, 'CNY')
  // 合计仍只累加展示币种——这是「amount」的历史语义，保持不变。
  assert.equal(view.amount, 2)
  assert.equal(view.byCurrency.CNY, 2)
  assert.equal(view.byCurrency.USD, 1)
  // 并列展示把两种币都摆出来，展示币种在前。
  assert.deepEqual(view.totals, [{ currency: 'CNY', amount: 2 }, { currency: 'USD', amount: 1 }])
  // 折不进去就说清楚折不进去，而不是给一个漏币的合计。
  assert.equal(view.convertedAmount, null)
  assert.deepEqual(view.missingRates, ['USD'])
  assert.equal(view.mixedCurrency, true)
})

test('配了汇率就给出折算合计', () => {
  const view = computeCost(MIXED_ROWS, MIXED_ENTRIES, 'CNY', normalizeExchangeRates({ USD: 7.2 }, 'CNY'))
  assert.equal(view.convertedAmount, 2 + 1 * 7.2)
  assert.deepEqual(view.missingRates, [])
  assert.equal(view.mixedCurrency, true)
  // 各币种原值仍然保留，折算不覆盖原始口径。
  assert.deepEqual(view.totals, [{ currency: 'CNY', amount: 2 }, { currency: 'USD', amount: 1 }])
})

test('只要有一种外币缺汇率就不给合计', () => {
  // 半个合计比没有合计更危险：它看起来像「全部算完了」，实际漏掉了一种币。
  const entries = validatePricing([
    ...MIXED_ENTRIES,
    { id: 'eur', provider: 'p', model: 'm-eur', currency: 'EUR', prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } } },
  ])
  const rows = [...MIXED_ROWS, { provider: 'p', model: 'm-eur', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }]
  const view = computeCost(rows, entries, 'CNY', normalizeExchangeRates({ USD: 7.2 }, 'CNY'))
  assert.equal(view.convertedAmount, null)
  assert.deepEqual(view.missingRates, ['EUR'])
})

test('单一币种时折算合计等于原合计', () => {
  const rows = [MIXED_ROWS[0]]
  const view = computeCost(rows, MIXED_ENTRIES, 'CNY')
  assert.equal(view.convertedAmount, 2)
  assert.deepEqual(view.totals, [{ currency: 'CNY', amount: 2 }])
  assert.equal(view.mixedCurrency, false)
  assert.deepEqual(view.missingRates, [])
})

//#endregion

//#region 峰谷判定

const MONDAY_PEAK = Date.UTC(2026, 7, 17, 2, 0)
const MONDAY_LUNCH = Date.UTC(2026, 7, 17, 5, 0)
const MONDAY_END = Date.UTC(2026, 7, 17, 10, 0)
const SATURDAY = Date.UTC(2026, 7, 15, 2, 0)

test('工作日高峰时段判为 peak', () => {
  const item = normalizeEntry(splitEntry())
  assert.equal(tariffAt(item, MONDAY_PEAK), 'peak')
})

test('工作日午休判为 offPeak', () => {
  const item = normalizeEntry(splitEntry())
  assert.equal(tariffAt(item, MONDAY_LUNCH), 'offPeak')
})

test('时段区间右开：18:00 已进入空闲', () => {
  const item = normalizeEntry(splitEntry())
  assert.equal(tariffAt(item, MONDAY_END), 'offPeak')
})

test('周末全天判为 offPeak', () => {
  const item = normalizeEntry(splitEntry())
  assert.equal(tariffAt(item, SATURDAY), 'offPeak')
})

test('无空闲价的条目恒为 peak', () => {
  const item = normalizeEntry(entry())
  assert.equal(tariffAt(item, SATURDAY), 'peak')
})

//#region 节假日

// 2026-02-16 是周一（高峰星期），也是春节假期内的一天：北京时间 10:00 本是高峰。
const HOLIDAY_MONDAY_PEAK = Date.UTC(2026, 1, 16, 2, 0)
// 2026-02-14 是周六（非高峰星期），也是春节前的调休上班日。
const WORKDAY_SATURDAY_PEAK = Date.UTC(2026, 1, 14, 2, 0)

test('法定节假日落在高峰星期也判为 offPeak', () => {
  const item = normalizeEntry(splitEntry(), 'pricing entry', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  // 同一天的相邻周（2026-02-09）是普通周一，用于对照：确实是「假期」在起作用。
  assert.equal(tariffAt(item, Date.UTC(2026, 1, 9, 2, 0)), 'peak')
  assert.equal(tariffAt(item, HOLIDAY_MONDAY_PEAK), 'offPeak')
})

test('内置 deepseek 调度真的挂上了 cn 集合', () => {
  // 回归：内置调度按名字引用 `cn`，若装载期没把集合表传下去，这个引用会解析成
  // 空数组——判定退化成纯工作日，假期照旧按高峰价算，而且不报错。
  const item = normalizeEntry(splitEntry(), 'pricing entry', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  assert.ok(item.schedule.holidays.length > 0, '内置调度的 holidays 应展开成非空日期数组')
  assert.ok(item.schedule.holidays.includes('2026-02-16'))
  // 未把集合表传下去时退化成空数组，因此上面那条断言是真正在守这件事的。
  assert.deepEqual(normalizeEntry(splitEntry()).schedule.holidays, [])
})

test('按官方口径，调休上班的周末仍是空闲', () => {
  // 官方只把「法定节假日」排除出高峰：调休上班的周末**没有**因此变成高峰日。
  // 内置 deepseek 规则不挂 workdays，这类日期就按自己所在的星期落进空闲。
  const item = normalizeEntry(splitEntry(), 'pricing entry', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  assert.deepEqual([...item.schedule.workdays], [], '内置规则不应挂 workdays')
  // 2026-02-14 是春节前的调休上班日（周六）：官方按空闲计，不是高峰。
  assert.equal(tariffAt(item, WORKDAY_SATURDAY_PEAK), 'offPeak')
})

test('workdays 是给「提供方把调休算高峰」留的开关', () => {
  const inline = {
    timezone: 'Asia/Shanghai',
    peakDays: [1, 2, 3, 4, 5],
    peakWindows: [['09:00', '12:00']],
    workdays: 'cn',
  }
  const item = normalizeEntry(entry({
    schedule: inline,
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, output: 4 } },
  }), 'pricing entry', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  // 2026-02-14 是周六，普通周六是空闲；显式挂上 workdays 后才变成高峰日。
  // 这不是 DeepSeek 官方口径，只为确实这么计费的提供方保留。
  assert.equal(tariffAt(item, WORKDAY_SATURDAY_PEAK), 'peak')
  // 普通周六仍然空闲。
  assert.equal(tariffAt(item, SATURDAY), 'offPeak')
})

test('假期与调休同日时以假期为准', () => {
  const both = {
    timezone: 'Asia/Shanghai',
    peakDays: [1],
    peakWindows: [['09:00', '12:00']],
    holidays: ['2026-02-16'],
    workdays: ['2026-02-16'],
  }
  const item = normalizeEntry(entry({
    schedule: both,
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, output: 4 } },
  }))
  assert.equal(tariffAt(item, HOLIDAY_MONDAY_PEAK), 'offPeak')
})

test('内置调度的假期能一路推到下一次切换（跨 9 天春节）', () => {
  // 2026 年春节连休 9 天。逐日推进的上限若还是 8 天，从假期第一天起就找不到下一次
  // 切换，倒计时会消失。
  const item = normalizeEntry(splitEntry(), 'pricing entry', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  const start = Date.UTC(2026, 1, 15, 1, 0)
  assert.equal(tariffAt(item, start), 'offPeak')
  const state = tariffStateAt(item, start)
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  // 假期结束后第一个工作日的 09:00，即北京时间 2026-02-24 09:00。
  assert.equal(new Date(state.remainingMs + start).toISOString(), '2026-02-24T01:00:00.000Z')
})

test('节假日集合可以内联日期数组，非法日期被拒绝', () => {
  const inline = {
    timezone: 'Asia/Shanghai',
    peakDays: [1],
    peakWindows: [['09:00', '12:00']],
    holidays: ['2026-02-16'],
  }
  const item = normalizeEntry(entry({
    schedule: inline,
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, output: 4 } },
  }))
  assert.deepEqual([...item.schedule.holidays], ['2026-02-16'])
  assert.throws(() => normalizeEntry(entry({
    schedule: { ...inline, holidays: ['2026-02-30'] },
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, output: 4 } },
  })), /真实日期/)
})

test('引用不存在的节假日集合直接报错', () => {
  // 与「数据文件缺失」区分开：用户写错名字是配置错误，必须立刻知道。
  assert.throws(() => normalizeEntry(entry({
    schedule: { timezone: 'UTC', peakDays: [1], peakWindows: [['09:00', '12:00']], holidays: 'cnn' },
    prices: { peak: { input: 2, cacheRead: 0.04, output: 8 }, offPeak: { input: 1, cacheRead: 0.02, output: 4 } },
  })), /未定义的节假日集合 "cnn"/)
})

test('随包发布的节假日数据形如约定', () => {
  const cn = CN_HOLIDAY_SETS.cn
  assert.ok(cn !== undefined, '应有 cn 集合')
  assert.equal(cn.name, '中国大陆法定节假日')
  const byYear = (dates, year) => dates.filter(date => date.startsWith(`${year}-`))
  // 2026 年（国办发明电〔2025〕7号）：33 天假期、6 天调休上班。
  assert.equal(byYear(cn.holidays, '2026').length, 33)
  assert.equal(byYear(cn.workdays, '2026').length, 6)
  // 2027 年（国办发明电〔2026〕10号）：29 天假期、5 天调休上班。
  assert.equal(byYear(cn.holidays, '2027').length, 29)
  assert.equal(byYear(cn.workdays, '2027').length, 5)
  assert.equal(cn.holidays.length, 62)
  assert.equal(cn.workdays.length, 11)
  for (const date of [...cn.holidays, ...cn.workdays]) assert.match(date, /^20(26|27)-\d{2}-\d{2}$/)
})

test('2027 年放假安排与国务院通知逐条一致', () => {
  // 通知：元旦 1/1–1/3；春节 2/5（除夕）–2/13（正月初八）9 天，1/31、2/14 上班；
  // 清明 4/3–4/5；劳动节 5/1–5/5，5/8 上班；端午 6/9；中秋 9/15；
  // 国庆 10/1–10/7，9/26、10/9 上班。
  const cn = CN_HOLIDAY_SETS.cn
  const range = (start, end) => {
    const dates = []
    for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
      dates.push(new Date(time).toISOString().slice(0, 10))
    }
    return dates
  }
  const expected = [
    ...range('2027-01-01', '2027-01-03'),
    ...range('2027-02-05', '2027-02-13'),
    ...range('2027-04-03', '2027-04-05'),
    ...range('2027-05-01', '2027-05-05'),
    '2027-06-09',
    '2027-09-15',
    ...range('2027-10-01', '2027-10-07'),
  ]
  assert.deepEqual(cn.holidays.filter(date => date.startsWith('2027-')), expected)
  assert.deepEqual(cn.workdays.filter(date => date.startsWith('2027-')), [
    '2027-01-31',
    '2027-02-14',
    '2027-05-08',
    '2027-09-26',
    '2027-10-09',
  ])
})

test('2027 年的节假日数据真的参与时段判定', () => {
  // 数据文件里有日期不等于用得上：这里用内置 `deepseek` 规则（引用 `cn` 集合）实测。
  // 2027-02-08 是周一、落在春节假期内 → 空闲；2027-02-15 是周一、假期已结束 → 高峰。
  const item = normalizeEntry(entry({
    schedule: 'deepseek',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  const monday = (date) => Date.parse(`${date}T03:00:00Z`) // 北京时间 11:00，落在上午高峰窗口内
  assert.equal(tariffAt(item, monday('2027-02-08')), 'offPeak', '春节假期内的周一应算空闲')
  assert.equal(tariffAt(item, monday('2027-02-15')), 'peak', '假期结束后的周一应算高峰')
  // 元旦与国庆同样抽查：2027-01-01（周五）放假，2027-10-04（周一）放假。
  assert.equal(tariffAt(item, monday('2027-01-01')), 'offPeak')
  assert.equal(tariffAt(item, monday('2027-10-04')), 'offPeak')
  // 调休上班日（2027-09-26 周日）不在内置规则的峰谷口径里：官方只排除节假日。
  assert.equal(tariffAt(item, monday('2027-09-26')), 'offPeak', '周日不是内置规则的高峰日')
})

test('倒计时重算成本有上界（host 半与浏览器半同构）', () => {
  // 随包数据跨 2026–2027 时，旧实现一次 12036 次 Intl.formatToParts（~55 ms）。
  const item = normalizeEntry(entry({
    schedule: 'deepseek',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', BUILTIN_SCHEDULES, CN_HOLIDAY_SETS)
  const original = Intl.DateTimeFormat.prototype.formatToParts
  let calls = 0
  Intl.DateTimeFormat.prototype.formatToParts = function countingFormatToParts(...args) {
    calls += 1
    return original.apply(this, args)
  }
  try {
    calls = 0
    const cold = tariffStateAt(item, Date.parse('2026-11-24T07:00:00Z'))
    const coldCalls = calls
    assert.equal(cold.split, true)
    assert.ok(cold.remainingMs > 0)
    assert.ok(coldCalls < 200, `冷调用应低于 200 次 Intl，实际 ${coldCalls}`)
    calls = 0
    tariffStateAt(item, Date.parse('2026-11-24T07:00:00Z') + 60_000)
    assert.ok(calls <= 2, `同一窗口内的重算应命中缓存，实际 ${calls} 次 Intl`)
  } finally {
    Intl.DateTimeFormat.prototype.formatToParts = original
  }
})

test('节假日数据自身一致：有序、不重复、假期与调休不相交', () => {
  const cn = CN_HOLIDAY_SETS.cn
  for (const [label, dates] of [['holidays', cn.holidays], ['workdays', cn.workdays]]) {
    const sorted = [...dates].sort()
    assert.deepEqual(dates, sorted, `${label} 应按日期升序`)
    assert.equal(new Set(dates).size, dates.length, `${label} 不应有重复日期`)
    for (const date of dates) {
      // 必须是真实存在的日期（排除 2 月 30 日这类手滑）。
      assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date, `${label} 含非法日期 ${date}`)
    }
  }
  const overlap = cn.holidays.filter(date => cn.workdays.includes(date))
  assert.deepEqual(overlap, [], '同一天不能既放假又调休上班')
})

//#endregion

test('自定义调度规则生效', () => {
  const schedules = validateSchedules({
    night: { timezone: 'UTC', peakDays: [1], peakWindows: [['00:00', '06:00']] },
  })
  const item = normalizeEntry(entry({
    schedule: 'night',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  assert.equal(tariffAt(item, Date.UTC(2026, 7, 17, 3, 0)), 'peak')
  assert.equal(tariffAt(item, Date.UTC(2026, 7, 17, 9, 0)), 'offPeak')
})

//#endregion

//#region 时段切换倒计时

/** 把毫秒差写成小时数，便于断言。 */
function hours(ms) {
  return ms / 3_600_000
}

test('高峰中段的下一次切换是当天 12:00', () => {
  // 周一 10:00 CST（= 02:00 UTC），距 12:00 还有 2 小时。
  const state = tariffStateAt(normalizeEntry(splitEntry()), Date.UTC(2026, 7, 17, 2, 0))
  assert.equal(state.split, true)
  assert.equal(state.tariff, 'peak')
  assert.equal(state.nextTariff, 'offPeak')
  assert.equal(hours(state.remainingMs), 2)
})

test('高峰前一小时的下一次切换是窗口起点', () => {
  // 周一 08:00 CST，一小时后进入高峰。
  const state = tariffStateAt(normalizeEntry(splitEntry()), Date.UTC(2026, 7, 17, 0, 0))
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  assert.equal(hours(state.remainingMs), 1)
})

test('周末的空闲一直算到周一开盘', () => {
  // 周六 10:00 CST 起算，下一次切换是周一 09:00 CST，共 47 小时。
  const state = tariffStateAt(normalizeEntry(splitEntry()), SATURDAY)
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  assert.equal(hours(state.remainingMs), 47)
})

test('周五收盘后的空闲跨过整个周末', () => {
  // 周五 18:00 CST（右开区间，已进入空闲）到周一 09:00 CST 共 63 小时。
  const state = tariffStateAt(normalizeEntry(splitEntry()), Date.UTC(2026, 7, 21, 10, 0))
  assert.equal(state.tariff, 'offPeak')
  assert.equal(hours(state.remainingMs), 63)
})

test('窗口终点前一分钟仍算在高峰内', () => {
  // 周五 17:59 CST，一分钟后就进入空闲。
  const state = tariffStateAt(normalizeEntry(splitEntry()), Date.UTC(2026, 7, 21, 9, 59))
  assert.equal(state.tariff, 'peak')
  assert.equal(state.nextTariff, 'offPeak')
  assert.equal(hours(state.remainingMs), 1 / 60)
})

test('无空闲价的条目没有切换，也不报倒计时', () => {
  const state = tariffStateAt(normalizeEntry(entry()), SATURDAY)
  assert.deepEqual(state, { split: false, tariff: 'peak', nextTariff: null, remainingMs: null })
})

test('夏令时切换当天的墙上时间换算正确', () => {
  // 纽约 2024-03-10 发生春季调时（EST→EDT）。从周五 15:00 EST 到周一 09:00
  // EDT 实际是 65 小时而不是 66 小时；按固定偏移推算会多出一小时。
  const schedules = validateSchedules({
    nyse: { timezone: 'America/New_York', peakDays: [1, 2, 3, 4, 5], peakWindows: [['09:00', '12:00']] },
  })
  const item = normalizeEntry(entry({
    schedule: 'nyse',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  const friday = tariffStateAt(item, Date.UTC(2024, 2, 8, 20, 0))
  assert.equal(friday.tariff, 'offPeak')
  assert.equal(hours(friday.remainingMs), 65)
  // 调时当天的周日 03:00 EDT 距周一开盘 30 小时。
  const sunday = tariffStateAt(item, Date.UTC(2024, 2, 10, 7, 0))
  assert.equal(sunday.tariff, 'offPeak')
  assert.equal(hours(sunday.remainingMs), 30)
})

test('春令时空洞里不存在的窗口边界不会把倒计时算错一整天', () => {
  // 纽约 2026-03-08 02:00 EST 直接跳到 03:00 EDT：02:00 这个墙上时刻当天不存在。
  // 旧实现按单条偏移反解，会把它算成一个已经过去的时刻，倒计时直接跳到下一天。
  const schedules = validateSchedules({
    ny: { timezone: 'America/New_York', peakDays: [0, 1, 2, 3, 4, 5, 6], peakWindows: [['01:00', '02:00']] },
  })
  const item = normalizeEntry(entry({
    schedule: 'ny',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  // 当天 00:30 EST（05:30Z）→ 01:00 EST（06:00Z）进入高峰，只差 30 分钟。
  const state = tariffStateAt(item, Date.parse('2026-03-08T05:30:00Z'))
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  assert.equal(state.remainingMs, 30 * 60_000, `应只差 30 分钟，实际 ${state.remainingMs / 60000} 分钟`)
})

test('秋令时重复小时的倒计时取两个解里最近的那个', () => {
  // 纽约 2026-11-01 02:00 EDT 回到 01:00 EST：01:00–02:00 这个墙上区间出现两次。
  // 从第一次 01:30 EDT（05:30Z）起，窗口终点 02:00 只在第二次出现时到达（07:00Z）。
  const schedules = validateSchedules({
    ny: { timezone: 'America/New_York', peakDays: [0, 1, 2, 3, 4, 5, 6], peakWindows: [['01:00', '02:00']] },
  })
  const item = normalizeEntry(entry({
    schedule: 'ny',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  const state = tariffStateAt(item, Date.parse('2026-11-01T05:30:00Z'))
  assert.equal(state.tariff, 'peak')
  assert.equal(state.nextTariff, 'offPeak')
  // 05:30Z 起算：01:59 EDT = 05:59Z 仍在窗口内；06:00Z 又回到 01:00 EST 也在窗口内；
  // 直到 07:00Z（02:00 EST）才离开。共 90 分钟。
  assert.equal(state.remainingMs, 90 * 60_000, `应剩 90 分钟，实际 ${state.remainingMs / 60000} 分钟`)
})

test('例外日期跨度大时仍能找到切换点（不再固定 32 天上限）', () => {
  // 只在周六 09:00-10:00 计高峰，且连续 5 个周六放假：从第 1 个周六 10:00 起，
  // 下一次高峰在第 6 个周六 09:00，跨度 5 周 + 23 小时 ≈ 34.96 天 > 32 天。
  // 旧实现的上限按「有没有例外」二选一（32 天），这里会直接算不出切换、倒计时消失。
  const saturday = new Date(Date.UTC(2026, 0, 3))
  while (saturday.getUTCDay() !== 6) saturday.setUTCDate(saturday.getUTCDate() + 1)
  const holidays = Array.from({ length: 5 }, (_, index) => {
    const day = new Date(saturday.getTime() + index * 7 * 86_400_000)
    return day.toISOString().slice(0, 10)
  })
  const schedules = validateSchedules({
    weekly: {
      timezone: 'UTC',
      peakDays: [6],
      peakWindows: [['09:00', '10:00']],
      holidays,
    },
  })
  const item = normalizeEntry(entry({
    schedule: 'weekly',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  // 从第 1 个周六 10:00（高峰刚结束）起算，下一次高峰是第 6 个周六 09:00。
  const start = saturday.getTime() + 10 * 3600_000
  const state = tariffStateAt(item, start)
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  const expected = saturday.getTime() + 5 * 7 * 86_400_000 + 9 * 3600_000
  assert.equal(state.remainingMs, expected - start, `应剩 ${(expected - start) / 86_400_000} 天，实际 ${state.remainingMs === null ? 'null' : (state.remainingMs / 86_400_000).toFixed(2) + ' 天'}`)
})

test('稀疏规则也能找到下一周的开盘时刻', () => {
  // 只在周一 09:00-12:00 计高峰：从周一 12:00 起要等将近 7 天才再次切换。
  const schedules = validateSchedules({
    sparse: { timezone: 'UTC', peakDays: [1], peakWindows: [['09:00', '12:00']] },
  })
  const item = normalizeEntry(entry({
    schedule: 'sparse',
    prices: { peak: { input: 2, cacheRead: 0, output: 4 }, offPeak: { input: 1, cacheRead: 0, output: 2 } },
  }), 'e', schedules)
  // 2026-08-17 是周一；12:00 UTC 刚出高峰。
  const state = tariffStateAt(item, Date.UTC(2026, 7, 17, 12, 0))
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  assert.equal(hours(state.remainingMs), 7 * 24 - 3)
})

test('切换时刻本身已属于新时段', () => {
  const item = normalizeEntry(splitEntry())
  // 12:00:00 整是窗口终点（右开），此刻已进入空闲，下一次切换是 14:00。
  const state = tariffStateAt(item, Date.UTC(2026, 7, 17, 4, 0))
  assert.equal(state.tariff, 'offPeak')
  assert.equal(state.nextTariff, 'peak')
  assert.equal(hours(state.remainingMs), 2)
})

//#endregion

//#region 时段归属

test('匹配不到条目或只有统一单价时标为 flat 而不是 peak', () => {
  // 回归：兜底曾是 `'peak'`，于是「还没配置价格」和「只填了统一单价」这两段用量
  // 都会被记成高峰，而投影状态持久化后这个标签就冻结了。
  const split = normalizeEntry(splitEntry())
  const flat = normalizeEntry(entry())
  assert.equal(tariffOf(split, MONDAY_PEAK), 'peak')
  assert.equal(tariffOf(split, SATURDAY), 'offPeak')
  assert.equal(tariffOf(flat, MONDAY_PEAK), 'flat')
  assert.equal(tariffOf(null, MONDAY_PEAK), 'flat')
  assert.equal(tariffOf(undefined, MONDAY_PEAK), 'flat')
})

test('时间戳不可用时同样标为 flat', () => {
  const split = normalizeEntry(splitEntry())
  assert.equal(tariffOf(split, undefined), 'flat')
  assert.equal(tariffOf(split, Number.NaN), 'flat')
  assert.equal(tariffOf(split, '2026-09-21'), 'flat')
})

test('flat 行仍按高峰价块计价，不会变成免费', () => {
  const flat = normalizeEntry(entry())
  const cost = costOfEntry(flat, tariffOf(flat, MONDAY_PEAK), { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(cost.amount, 2)
  assert.equal(cost.tariff, 'flat')
})

//#endregion

//#region 费用

test('按高峰价计算四个桶', () => {
  const item = normalizeEntry(splitEntry())
  const cost = costOfEntry(item, 'peak', { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 })
  assert.equal(cost.components.input, 2)
  assert.equal(cost.components.cacheRead, 0.04)
  assert.equal(cost.components.output, 8)
  assert.equal(Math.round(cost.amount * 100) / 100, 10.04)
  assert.equal(cost.currency, 'CNY')
})

test('按空闲价计算同一批 token', () => {
  const item = normalizeEntry(splitEntry())
  const cost = costOfEntry(item, 'offPeak', { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 })
  assert.equal(cost.components.input, 1)
})

test('computeCost 汇总多供应商并按币种分组', () => {
  const entries = validatePricing([
    entry({ id: 'a' }),
    entry({ id: 'b', provider: 'my-gateway', currency: 'USD', prices: { peak: { input: 1, cacheRead: 0, output: 1 } } }),
  ])
  const view = computeCost([
    { provider: 'deepseek-official', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
    { provider: 'my-gateway', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
  ], entries, 'CNY')
  assert.equal(view.amount, 2)
  assert.equal(view.byCurrency.CNY, 2)
  assert.equal(view.byCurrency.USD, 1)
  assert.equal(view.mixedCurrency, true)
  assert.equal(view.models.length, 2)
  assert.equal(view.unpriced.length, 0)
})

test('未配置价格的用量行计入 unpriced 且不影响合计', () => {
  const entries = validatePricing([entry()])
  const view = computeCost([
    { provider: 'my-gateway', model: 'glm-5', tariff: 'peak', input: 500, cacheRead: 0, cacheWrite: 0, output: 500 },
  ], entries, 'CNY')
  assert.equal(view.amount, 0)
  assert.equal(view.tokens, 1000)
  assert.equal(view.unpriced.length, 1)
  assert.equal(view.models[0].priced, false)
  assert.equal(view.models[0].amount, null)
  // 行里显式给了 tariff 就照抄（host 折叠出的行总是带着它）。
  assert.equal(view.models[0].tariff, 'peak')
  // 省略 tariff 时兜底取 flat（「没有条目就没有时段可判」），与 tariffOf 一致；
  // 兜成 peak 会把未定价的用量说成高峰。
  const noTariff = computeCost([
    { provider: 'my-gateway', model: 'glm-5', input: 500, cacheRead: 0, cacheWrite: 0, output: 500 },
  ], entries, 'CNY')
  assert.equal(noTariff.models[0].tariff, 'flat')
})

test('内置表按官方价算出 flash 高峰一百万的费用', () => {
  const view = computeCost([
    { provider: 'deepseek-official', model: 'deepseek-flash', tariff: 'peak', input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
  ], BUILTIN_PRICING, 'CNY')
  assert.equal(view.amount, 2)
  assert.equal(view.models[0].entryId, 'builtin-deepseek-official-flash-cny')
})

test('内置表按官方价算出 v4-pro 空闲一百万的费用', () => {
  const view = computeCost([
    { provider: 'deepseek-official', model: 'deepseek-v4-pro', tariff: 'offPeak', input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
  ], BUILTIN_PRICING, 'CNY')
  assert.equal(view.amount, 13.5)
})

test('内置调度表包含 deepseek 规则', () => {
  assert.ok(BUILTIN_SCHEDULES.deepseek)
  assert.equal(BUILTIN_SCHEDULES.deepseek.timezone, 'Asia/Shanghai')
})

//#endregion

for (const failure of failures) {
  console.error(`✗ ${failure.name}`)
  console.error(`  ${failure.error.message}`)
}
console.log(`\n${passed} 个用例通过，${failures.length} 个失败`)
process.exit(failures.length === 0 ? 0 : 1)
