/**
 * 纯定价原语：内置价目表、分层合并、条目匹配与费用计算。
 *
 * 本模块没有 I/O、没有可变全局状态，host 半与测试共用。价格单位统一为
 * 「每百万 token 的货币金额」；币种由每个条目自己的 `currency` 决定。
 *
 * 条目按 `(provider, model)` 匹配并支持 `*` 通配，优先级从高到低：
 * 精确 → provider 通配 → model 通配 → 全通配。同一优先级内先出现的条目获胜。
 *
 * @module @lantiosity/dsh-token-fee/pricing
 */

/** 价格换算基数：价目表以百万 token 计价。 */
export const TOKENS_PER_MILLION = 1_000_000

/** 计费桶名，顺序即详情面板的展示顺序。 */
export const BUCKET_KEYS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output'])

/** 默认展示币种。 */
export const DEFAULT_CURRENCY = 'CNY'

/**
 * DeepSeek 官方时段调度：北京时间周一至周五 09:00-12:00 与 14:00-18:00 为高峰，
 * 其余时段为空闲。官方定价页注明高峰判定不含中国法定节假日，本实现按自然
 * 工作日判定，因此法定节假日会被高估为高峰价。
 */
export const DEEPSEEK_SCHEDULE = Object.freeze({
  timezone: 'Asia/Shanghai',
  peakDays: Object.freeze([1, 2, 3, 4, 5]),
  peakWindows: Object.freeze([Object.freeze(['09:00', '12:00']), Object.freeze(['14:00', '18:00'])]),
})

/**
 * 内置命名调度表。条目用名字引用调度，用户改一处即可让所有引用它的条目同时生效；
 * 也允许条目直接内联一个调度对象。
 */
export const BUILTIN_SCHEDULES = Object.freeze({ deepseek: DEEPSEEK_SCHEDULE })

const DEEPSEEK_PRICE_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** 构造一个内置条目的价格块。 */
function prices({ input, cacheRead, output, cacheWrite = 0 }) {
  return Object.freeze({ input, cacheRead, cacheWrite, output })
}

/**
 * 内置默认价目表：DeepSeek 官方人民币定价（元 / 百万 token）。
 *
 * `provider` 精确绑定官方路由 `deepseek-official`，不做通配：同一模型经不同
 * 供应商（中转商、聚合网关、自建代理）调用时价格并不相同，因此中转价格必须由
 * 用户显式添加条目，插件不会用官方价冒充。数值取自官方定价页：
 * deepseek-flash 高峰 输入 2 / 缓存命中 0.04 / 输出 8，空闲为高峰的一半；
 * deepseek-v4-pro 高峰 输入 9 / 缓存命中 0.30 / 输出 27，空闲为高峰的一半。
 */
export const BUILTIN_PRICING = Object.freeze([
  Object.freeze({
    id: 'builtin-deepseek-official-flash-cny',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    currency: 'CNY',
    schedule: DEEPSEEK_SCHEDULE,
    prices: Object.freeze({
      peak: prices({ input: 2, cacheRead: 0.04, output: 8 }),
      offPeak: prices({ input: 1, cacheRead: 0.02, output: 4 }),
    }),
    source: DEEPSEEK_PRICE_SOURCE,
    note: 'DeepSeek 官方定价；旧模型名 deepseek-v4-flash 由同一模型提供服务并按其计费。',
  }),
  Object.freeze({
    id: 'builtin-deepseek-official-v4-pro-cny',
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    currency: 'CNY',
    schedule: DEEPSEEK_SCHEDULE,
    prices: Object.freeze({
      peak: prices({ input: 9, cacheRead: 0.3, output: 27 }),
      offPeak: prices({ input: 4.5, cacheRead: 0.15, output: 13.5 }),
    }),
    source: DEEPSEEK_PRICE_SOURCE,
    note: 'DeepSeek 官方定价（DeepSeek-V4-Pro-0813）。',
  }),
])

/** 旧模型名到官方在售模型名的别名，用于回退匹配。 */
export const MODEL_ALIASES = Object.freeze({
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

/** 历史路由 id 到当前官方路由 id 的别名，用于回退匹配。 */
export const PROVIDER_ALIASES = Object.freeze({
  deepseek: 'deepseek-official',
})

const WEEKDAY_NUMBER = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })

/** 非空字符串或 null。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 非负有限数或 null。 */
function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** ICU 认可的货币代码集合，惰性求值；运行时不提供该 API 时为 null。 */
let knownCurrencies = null

/** 取 ICU 货币白名单，不可用时返回 null（此时只做格式校验）。 */
function supportedCurrencies() {
  if (knownCurrencies === null && typeof Intl.supportedValuesOf === 'function') {
    knownCurrencies = new Set(Intl.supportedValuesOf('currency'))
  }
  return knownCurrencies
}

/**
 * 校验并归一化一个货币代码。
 *
 * 除格式外还对照 ICU 的 ISO 4217 白名单，避免把 `CNY` 拼成 `CNA` 之类后
 * 金额静默变形；运行时不提供 `Intl.supportedValuesOf` 时退回格式校验。
 * @param value - 待校验的代码。
 * @param label - 出错信息中使用的定位标签。
 * @returns 大写的货币代码。
 */
export function assertCurrencyCode(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value)) {
    throw new Error(`${label} 必须是三位货币代码，例如 CNY`)
  }
  const code = value.toUpperCase()
  const known = supportedCurrencies()
  if (known !== null && !known.has(code)) {
    throw new Error(`${label} 不是可识别的货币代码：${value}`)
  }
  return code
}

/** 把 `HH:MM` 解析成当日分钟数。 */
function minuteOf(clock) {
  const match = /^(\d{2}):(\d{2})$/.exec(clock)
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 校验一个时段调度，非法时抛错。 */
export function validateSchedule(schedule, label) {
  if (schedule === null || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new Error(`${label}.schedule 必须是对象`)
  }
  if (nonEmptyString(schedule.timezone) === null) throw new Error(`${label}.schedule.timezone 不能为空`)
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: schedule.timezone }).format(0)
  } catch {
    throw new Error(`${label}.schedule.timezone 不是有效时区`)
  }
  if (!Array.isArray(schedule.peakDays) || schedule.peakDays.length === 0) {
    throw new Error(`${label}.schedule.peakDays 必须是非空数组`)
  }
  for (const day of schedule.peakDays) {
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`${label}.schedule.peakDays 只能包含 0-6 的整数（0 为周日）`)
    }
  }
  if (!Array.isArray(schedule.peakWindows) || schedule.peakWindows.length === 0) {
    throw new Error(`${label}.schedule.peakWindows 必须是非空数组`)
  }
  for (const [index, window] of schedule.peakWindows.entries()) {
    if (!Array.isArray(window) || window.length !== 2) {
      throw new Error(`${label}.schedule.peakWindows[${index}] 必须是 [开始, 结束]`)
    }
    const start = minuteOf(String(window[0]))
    const end = minuteOf(String(window[1]))
    if (start === null || end === null || start >= end) {
      throw new Error(`${label}.schedule.peakWindows[${index}] 必须是同一天内的非空区间（HH:MM）`)
    }
  }
}

/** 校验一个价格块（四个桶齐全且非负）。 */
function validateUnitPrices(block, label) {
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`${label} 必须是对象`)
  }
  const normalized = {}
  for (const bucket of BUCKET_KEYS) {
    const value = nonNegativeNumber(block[bucket] ?? 0)
    if (value === null) throw new Error(`${label}.${bucket} 必须是非负数字`)
    normalized[bucket] = value
  }
  return normalized
}

/**
 * 校验并归一化一个价目条目。
 * @param raw - 待校验的条目。
 * @param label - 出错信息中使用的定位标签。
 * @param schedules - 可用的命名调度表；条目用字符串引用它。
 * @returns 归一化后的条目（浅拷贝，价格块与调度已冻结）。
 * @throws 当字段缺失、类型错误、调度非法或引用了未知调度名时。
 */
export function normalizeEntry(raw, label = 'pricing entry', schedules = BUILTIN_SCHEDULES) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${label} 必须是对象`)
  }
  const id = nonEmptyString(raw.id)
  if (id === null) throw new Error(`${label}.id 不能为空`)
  const provider = nonEmptyString(raw.provider) ?? '*'
  const model = nonEmptyString(raw.model)
  if (model === null) throw new Error(`${label}.model 不能为空`)
  const currency = assertCurrencyCode(nonEmptyString(raw.currency) ?? DEFAULT_CURRENCY, `${label}.currency`)
  const prices_ = raw.prices
  if (prices_ === null || typeof prices_ !== 'object' || Array.isArray(prices_)) {
    throw new Error(`${label}.prices 必须是对象`)
  }
  const peak = validateUnitPrices(prices_.peak, `${label}.prices.peak`)
  const hasOffPeak = prices_.offPeak !== undefined && prices_.offPeak !== null
  const offPeak = hasOffPeak ? validateUnitPrices(prices_.offPeak, `${label}.prices.offPeak`) : undefined
  const schedule = resolveScheduleRef(raw.schedule, label, schedules)
  if (offPeak !== undefined && schedule === null) {
    throw new Error(`${label} 配置了 offPeak 价格却没有 schedule`)
  }
  const source = nonEmptyString(raw.source)
  const note = nonEmptyString(raw.note)
  return Object.freeze({
    id,
    provider,
    model,
    currency,
    schedule,
    prices: Object.freeze(offPeak === undefined
      ? { peak: Object.freeze(peak) }
      : { peak: Object.freeze(peak), offPeak: Object.freeze(offPeak) }),
    ...source === null ? {} : { source },
    ...note === null ? {} : { note },
  })
}

/** 解析条目的 `schedule` 字段：null、命名引用或内联对象，统一展开为冻结对象。 */
function resolveScheduleRef(value, label, schedules) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const named = schedules?.[value]
    if (named === undefined) {
      throw new Error(`${label}.schedule 引用了未定义的调度 "${value}"；可用：${Object.keys(schedules ?? {}).join('、') || '（无）'}`)
    }
    validateSchedule(named, `${label}.schedule(${value})`)
    return freezeSchedule(named)
  }
  validateSchedule(value, label)
  return freezeSchedule(value)
}

/** 冻结一份调度规则的深拷贝。 */
function freezeSchedule(schedule) {
  return Object.freeze({
    timezone: schedule.timezone,
    peakDays: Object.freeze([...schedule.peakDays]),
    peakWindows: Object.freeze(schedule.peakWindows.map(window => Object.freeze([...window]))),
  })
}

/**
 * 校验并归一化整张价目表。
 * @param entries - 条目数组。
 * @param label - 出错信息中使用的定位标签。
 * @param schedules - 可用的命名调度表。
 * @returns 归一化后的冻结数组。
 * @throws 当 `entries` 不是非空数组或任一条目非法时。
 */
export function validatePricing(entries, label = 'pricing', schedules = BUILTIN_SCHEDULES) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${label} 必须是非空数组`)
  const seen = new Set()
  const normalized = entries.map((entry, index) => {
    const item = normalizeEntry(entry, `${label}[${index}]`, schedules)
    if (seen.has(item.id)) throw new Error(`${label} 中 id 重复：${item.id}`)
    seen.add(item.id)
    return item
  })
  return Object.freeze(normalized)
}

/**
 * 按 `(provider, model, currency)` 身份合并多层价目表，后出现的层覆盖先出现的层。
 *
 * 每层可以是原始数组（会被校验）或已归一化的数组；返回数组保持「覆盖者替换被覆盖者
 * 的位置」这一顺序，使匹配优先级仍然由条目顺序决定。
 * @param layers - 从低到高的层数组。
 * @param schedules - 可用的命名调度表。
 * @returns 合并后的冻结数组。
 */
export function mergePricingLayers(layers, schedules = BUILTIN_SCHEDULES) {
  const byKey = new Map()
  for (const [index, layer] of layers.entries()) {
    if (layer === undefined || layer === null) continue
    if (Array.isArray(layer) && layer.length === 0) continue
    const entries = validatePricing(layer, `pricing layer ${index}`, schedules)
    for (const entry of entries) {
      const key = `${entry.provider}\u0000${entry.model}\u0000${entry.currency}`
      if (byKey.has(key)) {
        const previous = byKey.get(key)
        byKey.set(key, { order: previous.order, entry })
      } else {
        byKey.set(key, { order: byKey.size, entry })
      }
    }
  }
  return Object.freeze([...byKey.values()].sort((a, b) => a.order - b.order).map(row => row.entry))
}

/**
 * 校验一份命名调度表，返回冻结的深拷贝。
 * @param schedules - `{ 名字: 调度 }` 映射。
 * @param label - 出错信息中使用的定位标签。
 * @returns 冻结后的调度表。
 */
export function validateSchedules(schedules, label = 'schedules') {
  if (schedules === null || typeof schedules !== 'object' || Array.isArray(schedules)) {
    throw new Error(`${label} 必须是对象`)
  }
  const result = {}
  for (const [key, value] of Object.entries(schedules)) {
    if (nonEmptyString(key) === null) throw new Error(`${label} 的名字不能为空`)
    validateSchedule(value, `${label}.${key}`)
    result[key] = freezeSchedule(value)
  }
  return Object.freeze(result)
}

/** 匹配得分：精确 0，provider 通配 1，model 通配 2，全通配 3；不匹配为 null。 */
function matchScore(entry, provider, model) {
  const providerHit = entry.provider === '*' || entry.provider === provider
  const modelHit = entry.model === '*' || entry.model === model
  if (!providerHit || !modelHit) return null
  if (entry.provider !== '*' && entry.model !== '*') return 0
  if (entry.model !== '*') return 1
  if (entry.provider !== '*') return 2
  return 3
}

/** 在给定身份上取最优条目：精确 0，provider 通配 1，model 通配 2，全通配 3。 */
function bestMatch(entries, provider, model) {
  let best = null
  let bestScore = Infinity
  for (const entry of entries) {
    const score = matchScore(entry, provider, model)
    if (score === null || score >= bestScore) continue
    best = entry
    bestScore = score
    if (score === 0) break
  }
  return best
}

/**
 * 为一个 provider/model 解析最优价目条目。
 *
 * 先按调用方给出的精确身份匹配；未命中时依次尝试路由别名与模型别名，
 * 因此历史路由 id（`deepseek`）与已下线的模型名仍能落到官方条目上。
 * 供应商必须精确匹配或由条目显式写成 `*`，插件不会把一个供应商的价格
 * 套用到另一个供应商。
 *
 * @param entries - 归一化后的价目表。
 * @param provider - 路由 provider id。
 * @param model - 模型 id。
 * @returns 命中的条目，未命中为 null。
 */
export function matchEntry(entries, provider, model) {
  const providerAlias = PROVIDER_ALIASES[provider]
  const modelAlias = MODEL_ALIASES[model]
  const candidates = [
    [provider, model],
    ...providerAlias === undefined ? [] : [[providerAlias, model]],
    ...modelAlias === undefined ? [] : [[provider, modelAlias]],
    ...providerAlias === undefined || modelAlias === undefined ? [] : [[providerAlias, modelAlias]],
  ]
  for (const [candidateProvider, candidateModel] of candidates) {
    const hit = bestMatch(entries, candidateProvider, candidateModel)
    if (hit !== null) return hit
  }
  return null
}

/** 把时间戳换成调度时区下的星期与当日分钟数。 */
function zonedClock(timestamp, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]))
  return {
    weekday: WEEKDAY_NUMBER[parts.weekday],
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  }
}

/**
 * 判定一个时间戳落在条目调度的哪个时段。
 * @param entry - 归一化后的价目条目。
 * @param timestamp - 事件时间（毫秒）。
 * @returns `'peak'` 或 `'offPeak'`；无空闲价或时间戳非法时恒为 `'peak'`。
 */
export function tariffAt(entry, timestamp) {
  if (entry.prices.offPeak === undefined || entry.schedule === null) return 'peak'
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return 'peak'
  const clock = zonedClock(timestamp, entry.schedule.timezone)
  if (!entry.schedule.peakDays.includes(clock.weekday)) return 'offPeak'
  const inWindow = entry.schedule.peakWindows.some(([start, end]) => {
    const from = minuteOf(String(start))
    const to = minuteOf(String(end))
    return from !== null && to !== null && clock.minute >= from && clock.minute < to
  })
  return inWindow ? 'peak' : 'offPeak'
}

/**
 * 计算一个 token 桶在指定时段下的费用明细。
 * @param entry - 命中的价目条目。
 * @param tariff - `'peak'` 或 `'offPeak'`。
 * @param buckets - `{ input, cacheRead, cacheWrite, output }` token 数。
 * @returns 各桶金额与合计，未定价的桶为 0。
 */
export function costOfEntry(entry, tariff, buckets) {
  const unit = entry.prices.offPeak !== undefined && tariff === 'offPeak' ? entry.prices.offPeak : entry.prices.peak
  const components = {}
  let amount = 0
  for (const bucket of BUCKET_KEYS) {
    const tokens = nonNegativeNumber(buckets?.[bucket] ?? 0) ?? 0
    const price = unit[bucket] ?? 0
    const value = tokens / TOKENS_PER_MILLION * price
    components[bucket] = value
    amount += value
  }
  return { amount, currency: entry.currency, components, unit: { ...unit }, entryId: entry.id, tariff }
}

/** 一个用量行的四个桶归零。 */
function zeroBuckets() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** 两个桶对象相加。 */
function addBuckets(left, right) {
  const sum = {}
  for (const bucket of BUCKET_KEYS) sum[bucket] = (left[bucket] ?? 0) + (right[bucket] ?? 0)
  return sum
}

/**
 * 把投影里的用量行换算成费用视图。
 *
 * 用量行来自 host 投影，每行是「一个 (provider, model, tariff) 三元组的四个 token 桶」。
 * 行按条目解析价格：未命中的行只报 token 数，金额为 null，并计入 `unpriced`。
 * 不同币种不混算：`amount` 只累加展示币种的行，其余币种进入 `byCurrency`。
 *
 * @param rows - 用量行数组，每行含 `provider`、`model`、`tariff` 与四个桶。
 * @param entries - 归一化后的价目表。
 * @param displayCurrency - 展示币种。
 * @returns 展示用的费用视图。
 */
export function computeCost(rows, entries, displayCurrency = DEFAULT_CURRENCY) {
  const models = []
  const byCurrency = {}
  const unpriced = []
  let amount = 0
  let tokens = 0
  for (const row of rows ?? []) {
    const buckets = {}
    for (const bucket of BUCKET_KEYS) buckets[bucket] = nonNegativeNumber(row?.[bucket] ?? 0) ?? 0
    const rowTokens = BUCKET_KEYS.reduce((sum, bucket) => sum + buckets[bucket], 0)
    tokens += rowTokens
    const entry = matchEntry(entries, row.provider, row.model)
    if (entry === null) {
      unpriced.push({ provider: row.provider, model: row.model, buckets })
      models.push({
        provider: row.provider,
        model: row.model,
        tariff: row.tariff ?? 'peak',
        buckets,
        tokens: rowTokens,
        priced: false,
        currency: null,
        amount: null,
        components: null,
        entryId: null,
      })
      continue
    }
    const cost = costOfEntry(entry, row.tariff ?? tariffAt(entry, row.time), buckets)
    byCurrency[cost.currency] = (byCurrency[cost.currency] ?? 0) + cost.amount
    if (cost.currency === displayCurrency) amount += cost.amount
    models.push({
      provider: row.provider,
      model: row.model,
      tariff: cost.tariff,
      buckets,
      tokens: rowTokens,
      priced: true,
      currency: cost.currency,
      amount: cost.amount,
      components: cost.components,
      entryId: cost.entryId,
    })
  }
  return {
    currency: displayCurrency,
    amount,
    tokens,
    models,
    unpriced,
    byCurrency,
    /** 展示币种之外还存在金额时为 true，调用方应提示「另有其他币种费用」。 */
    mixedCurrency: Object.keys(byCurrency).some(currency => currency !== displayCurrency && byCurrency[currency] > 0),
  }
}
