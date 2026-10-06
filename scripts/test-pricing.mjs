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
  mergePricingLayers,
  normalizeEntry,
  normalizeHolidaySets,
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

test('内置表只包含 deepseek-official 的价格', () => {
  assert.equal(BUILTIN_PRICING.length, 2)
  for (const item of BUILTIN_PRICING) assert.equal(item.provider, 'deepseek-official')
  const models = BUILTIN_PRICING.map(item => item.model).sort()
  assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro'])
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
  // 两者共用同一套 Messages 传输与同一份模型目录，不做这层回退的话账号路由的用量
  // 会整段落进「未配置价格」而从合计里消失。
  const entries = validatePricing([entry()])
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-flash').id, 'e1')
  // 账号侧的真实模型 id 与官方侧不同（deepseek-v4-flash），由模型别名接手。
  assert.equal(matchEntry(entries, 'deepseek-account', 'deepseek-v4-flash').id, 'e1')
})

test('账号路由命中内置价目，而不是落到未配置', () => {
  // 端到端：内置表 + 账号路由实际会出现的 (provider, model) 组合。
  assert.equal(
    matchEntry(BUILTIN_PRICING, 'deepseek-account', 'deepseek-v4-flash')?.id,
    'builtin-deepseek-official-flash-cny',
  )
  assert.equal(
    matchEntry(BUILTIN_PRICING, 'deepseek-account', 'deepseek-v4-pro')?.id,
    'builtin-deepseek-official-v4-pro-cny',
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
  // 2026 年国务院口径：33 天假期、6 天调休上班。
  assert.equal(cn.holidays.length, 33)
  assert.equal(cn.workdays.length, 6)
  for (const date of cn.holidays) assert.match(date, /^2026-\d{2}-\d{2}$/)
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
