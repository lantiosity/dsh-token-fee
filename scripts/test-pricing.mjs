#!/usr/bin/env node
/**
 * dsh-token-fee 纯函数测试：价目表校验、匹配优先级、峰谷判定与费用换算。
 *
 * 运行：node scripts/test-pricing.mjs
 */

import assert from 'node:assert/strict'
import {
  BUILTIN_PRICING,
  BUILTIN_SCHEDULES,
  computeCost,
  costOfEntry,
  matchEntry,
  mergePricingLayers,
  normalizeEntry,
  tariffAt,
  tariffStateAt,
  validatePricing,
  validateSchedules,
} from '../lib/pricing.js'

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

test('内置表只包含 deepseek-official 的价格', () => {
  assert.equal(BUILTIN_PRICING.length, 2)
  for (const item of BUILTIN_PRICING) assert.equal(item.provider, 'deepseek-official')
  const models = BUILTIN_PRICING.map(item => item.model).sort()
  assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro'])
})

test('内置条目带有峰谷两档价格与调度', () => {
  for (const item of BUILTIN_PRICING) {
    assert.ok(item.prices.offPeak, `${item.id} 缺少空闲价`)
    assert.deepEqual(item.schedule.timezone, 'Asia/Shanghai')
    assert.deepEqual([...item.schedule.peakDays], [1, 2, 3, 4, 5])
    assert.equal(item.prices.offPeak.input * 2, item.prices.peak.input)
  }
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
  assert.equal(merged.length, 2)
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
