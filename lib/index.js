/**
 * dsh-token-fee — host 半。
 *
 * 两件事：
 *   1. 注册一个会话投影 `tokenFee`，把每次模型调用的计费用量按
 *      `(provider, model, 时段)` 折叠成整段日志的累计值，供 Web 客户端读取。
 *   2. 注册两个仅限回环的端点，让客户端读写用户价目表文件
 *      `<DSH_HOME>/token-fee.json`。
 *
 * 费用金额不在 host 计算：投影只携带 token 桶，客户端拿到同一份价目表后自行
 * 换算，因此改价格无需重启，也不会让持久化的投影缓存失效。
 *
 * @module @lantiosity/dsh-token-fee
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  BUCKET_KEYS,
  BUILTIN_PRICING,
  BUILTIN_SCHEDULES,
  DEFAULT_CURRENCY,
  assertCurrencyCode,
  matchEntry,
  mergePricingLayers,
  tariffAt,
  validatePricing,
  validateSchedules,
} from './pricing.js'

/** Cordis 插件名。 */
export const name = 'token-fee'

/** 价目表读写端点（精确路由，先于连接插件的 `/api` 前缀处理器命中）。 */
export const PRICING_PATH = '/api/token-fee/pricing'

/** 恢复内置价目表的端点（删除用户文件）。 */
export const PRICING_RESET_PATH = '/api/token-fee/pricing/reset'

/** 写操作必须携带的自定义请求头；它让浏览器把请求当成非简单请求，从而挡掉跨站伪造。 */
const ACTION_HEADER = 'x-dsh-token-fee-action'

/** 请求体上限：价目表是人工维护的小文件。 */
const MAX_BODY_BYTES = 512 * 1024

/** 投影状态版本；状态结构或折叠语义变化时必须递增。 */
const STATE_VERSION = 2

//#region 配置

/** 用户价目表文件的默认位置。 */
export function defaultPricingFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'token-fee.json')
}

/** 本插件承认的配置键；其余键在装载期报错而不是被静默忽略。 */
const CONFIG_KEYS = new Set(['displayCurrency', 'pricingFile', 'pricing', 'schedules'])

/**
 * 插件配置的 Standard Schema 校验器。
 *
 * cordis 只要求 `Config['~standard'].validate`（`vendor/cordis/src/fiber.ts:53`：
 * 同步返回 `{ value }` 或 `{ issues }`），因此这里手写一个符合该规范的对象，
 * 而不是 `import '@deepseek-ai/schemastery'`：本插件以 link 方式安装，Node 从
 * 插件真实路径逐级向上找 `node_modules`，够不到 `$DSH_HOME/profiles/node_modules`，
 * 引入那个包会让插件在装载期直接失败（已实测 `ERR_MODULE_NOT_FOUND`）。
 *
 * schema 负责结构、类型、默认值与未知键；跨字段规则（价目条目引用命名调度）
 * 由 {@link resolveConfig} 承担，Standard Schema 表达不了它。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: '@lantiosity/dsh-token-fee',
    /**
     * 校验并填默认值。
     * @param value - `cordis.yml` 中该条目的 `config`。
     * @returns 通过时为 `{ value }`，否则为 `{ issues }`。
     */
    validate(value) {
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
        return { issues: [{ message: 'token-fee: config 必须是对象' }] }
      }
      const source = value ?? {}
      const issues = []
      for (const key of Object.keys(source)) {
        if (!CONFIG_KEYS.has(key)) {
          issues.push({ message: `token-fee: 未知配置项 ${JSON.stringify(key)}；可用：${[...CONFIG_KEYS].join('、')}` })
        }
      }
      const displayCurrency = source.displayCurrency ?? DEFAULT_CURRENCY
      try {
        assertCurrencyCode(displayCurrency, 'token-fee: displayCurrency')
      } catch (error) {
        issues.push({ message: String(error?.message ?? error) })
      }
      if (source.pricingFile !== undefined && (typeof source.pricingFile !== 'string' || source.pricingFile.trim() === '')) {
        issues.push({ message: 'token-fee: pricingFile 必须是非空路径字符串' })
      }
      if (source.schedules !== undefined && source.schedules !== null) {
        try {
          validateSchedules(source.schedules, 'token-fee: schedules')
        } catch (error) {
          issues.push({ message: String(error?.message ?? error) })
        }
      }
      if (source.pricing !== undefined && source.pricing !== null) {
        try {
          validatePricing(
            source.pricing,
            'token-fee: pricing',
            mergeSchedules(BUILTIN_SCHEDULES, source.schedules),
          )
        } catch (error) {
          issues.push({ message: String(error?.message ?? error) })
        }
      }
      return issues.length > 0 ? { issues } : { value: { ...source, displayCurrency } }
    },
  },
}

/** 解析插件配置；未配置的字段回落到默认值，非法值直接抛错（fail loud）。 */
export function resolveConfig(raw) {
  const source = raw === null || raw === undefined || typeof raw !== 'object' ? {} : raw
  const rawCurrency = source.displayCurrency
  const displayCurrency = rawCurrency === undefined
    ? DEFAULT_CURRENCY
    : assertCurrencyCode(rawCurrency, 'token-fee: displayCurrency')
  const rawFile = source.pricingFile
  if (rawFile !== undefined && (typeof rawFile !== 'string' || rawFile.trim() === '')) {
    throw new Error('token-fee: pricingFile 必须是非空路径字符串')
  }
  const file = rawFile === undefined ? defaultPricingFile() : resolvePricingFile(rawFile.trim())
  return {
    displayCurrency,
    pricingFile: file,
    schedules: source.schedules === undefined || source.schedules === null
      ? null
      : validateSchedules(source.schedules, 'token-fee config.schedules'),
    pricing: source.pricing === undefined || source.pricing === null
      ? null
      : validatePricing(source.pricing, 'token-fee config.pricing', mergeSchedules(BUILTIN_SCHEDULES, source.schedules)),
  }
}

/** 按名字合并多层命名调度表，后出现的层覆盖先出现的层。 */
function mergeSchedules(...layers) {
  const result = {}
  for (const layer of layers) {
    if (layer === null || layer === undefined) continue
    for (const [key, value] of Object.entries(layer)) result[key] = value
  }
  return validateSchedules(result, 'schedules')
}

/** 相对路径按 `DSH_HOME` 解析，绝对路径原样使用。 */
function resolvePricingFile(value) {
  if (isAbsolute(value)) return value
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, value)
}

//#endregion

//#region 价目表装载

/**
 * 有效价目表：内置层 → 用户文件层 → 插件配置层，后者覆盖前者。命名调度表按同样
 * 的顺序合并，因此用户可以覆盖内置的 `deepseek` 规则或新增自己的规则。
 *
 * 文件带 mtime 缓存，读取端点每次触达时最多做一次 `stat`，因此手工编辑
 * `token-fee.json` 后无需重启即可生效。
 */
export class PricingStore {
  /**
   * @param config - 已解析的插件配置。
   */
  constructor(config) {
    this.config = config
    this.fileEntries = []
    /** 落盘时的原始条目数组（未归一化）。 */
    this.rawFileEntries = []
    this.fileSchedules = null
    this.fileExists = false
    this.fileMtimeMs = -1
    this.fileError = null
    this.schedules = mergeSchedules(BUILTIN_SCHEDULES, config.schedules)
    this.entries = mergePricingLayers([BUILTIN_PRICING, config.pricing], this.schedules)
  }

  /** 重新读取用户文件（mtime 未变化时直接返回缓存结果）。 */
  async refresh() {
    let info = null
    try {
      info = await stat(this.config.pricingFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.fileError = `无法读取价目表文件：${String(error?.message ?? error)}`
        return
      }
    }
    if (info === null) {
      if (this.fileExists || this.fileMtimeMs !== -1) {
        this.fileExists = false
        this.fileMtimeMs = -1
        this.fileEntries = []
        this.rawFileEntries = []
        this.fileSchedules = null
        this.fileError = null
        this.rebuild()
      }
      return
    }
    if (this.fileExists && info.mtimeMs === this.fileMtimeMs) return
    try {
      const parsed = JSON.parse(await readFile(this.config.pricingFile, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : parsed?.entries
      const schedules = Array.isArray(parsed) || parsed?.schedules === undefined || parsed.schedules === null
        ? null
        : validateSchedules(parsed.schedules, 'token-fee.json schedules')
      const merged = mergeSchedules(BUILTIN_SCHEDULES, schedules, this.config.schedules)
      this.fileEntries = validatePricing(list, 'token-fee.json entries', merged)
      // 归一化会把 `schedule: "my-peak"` 展开成内联对象。编辑草稿必须拿原始层，
      // 否则每次经 UI 保存都会把命名引用改写成 inline-N 副本，并让引用集合落空。
      this.rawFileEntries = Array.isArray(list) ? list : []
      this.fileSchedules = schedules
      this.fileError = null
    } catch (error) {
      this.fileEntries = []
      this.rawFileEntries = []
      this.fileSchedules = null
      this.fileError = `价目表文件无效：${String(error?.message ?? error)}`
    }
    this.fileExists = true
    this.fileMtimeMs = info.mtimeMs
    this.rebuild()
  }

  /** 用当前三层重建有效表。 */
  rebuild() {
    this.schedules = mergeSchedules(BUILTIN_SCHEDULES, this.fileSchedules, this.config.schedules)
    this.entries = mergePricingLayers([BUILTIN_PRICING, this.fileEntries, this.config.pricing], this.schedules)
  }

  /** 覆盖写入用户文件并立即重建有效表。 */
  async save(payload) {
    await mkdir(dirname(this.config.pricingFile), { recursive: true })
    const temp = `${this.config.pricingFile}.${process.pid}.tmp`
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    await rename(temp, this.config.pricingFile)
    this.fileMtimeMs = -1
    await this.refresh()
  }

  /** 删除用户文件，回到内置 + 配置层。 */
  async reset() {
    await rm(this.config.pricingFile, { force: true })
    // 自行清空而不是交给 refresh：文件已不存在，refresh 的 mtime 分支不会再
    // 触发清理，残留的条目会继续生效。
    this.fileEntries = []
    this.rawFileEntries = []
    this.fileSchedules = null
    this.fileExists = false
    this.fileMtimeMs = -1
    this.fileError = null
    this.rebuild()
  }

  /** 客户端与端点共用的快照。 */
  snapshot() {
    return {
      displayCurrency: this.config.displayCurrency,
      entries: this.entries,
      builtin: BUILTIN_PRICING,
      schedules: this.schedules,
      builtinSchedules: BUILTIN_SCHEDULES,
      file: {
        path: this.config.pricingFile,
        exists: this.fileExists,
        // 归一化层：计价与只读展示用（价格已转成数字、调度已展开）。
        entries: this.fileEntries,
        // 原始层：编辑器草稿用，保留条目对命名调度的字符串引用。
        rawEntries: this.rawFileEntries,
        schedules: this.fileSchedules,
        error: this.fileError,
      },
      configEntryCount: this.config.pricing?.length ?? 0,
    }
  }
}

//#endregion

//#region 会话投影

/** 一个用量行的四个桶归零。 */
function zeroBuckets() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
}

/** 从一个 `TokenUsage` 取出四个计费桶。 */
function bucketsFrom(usage) {
  return {
    input: usage.inputTokens ?? 0,
    cacheRead: usage.cacheReadTokens ?? 0,
    cacheWrite: usage.cacheWriteTokens ?? 0,
    output: usage.outputTokens ?? 0,
  }
}

/** 两个桶对象相减，结果可能为负（替换旧样本时）。 */
function subtractBuckets(left, right) {
  const result = {}
  for (const bucket of BUCKET_KEYS) result[bucket] = (left?.[bucket] ?? 0) - (right?.[bucket] ?? 0)
  return result
}

/** 桶对象是否全为零。 */
function isZeroBuckets(value) {
  return BUCKET_KEYS.every(bucket => (value?.[bucket] ?? 0) === 0)
}

/** 两个桶对象相加。 */
function addBuckets(left, right) {
  const result = {}
  for (const bucket of BUCKET_KEYS) result[bucket] = (left?.[bucket] ?? 0) + (right?.[bucket] ?? 0)
  return result
}

/** 用量行的聚合键。 */
function rowKey(provider, model, tariff) {
  return `${provider}\u0000${model}\u0000${tariff}`
}

/**
 * 一个持久事件携带的用量样本。
 *
 * `assistant/message` 直接带 `usage`；否则回退到事件流里最后一个 `usage`
 * 原始分片（`assistant/attempt` 走这条路径）。
 */
export function usageOf(event) {
  if (event?.type === 'assistant/message' && event.data?.usage !== undefined) return event.data.usage
  if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') return undefined
  let found
  for (const record of event.data?.stream ?? []) {
    if (record?.type !== 'chunk') continue
    if (record.chunk?.type === 'usage' && record.chunk.usage !== undefined) found = record.chunk.usage
  }
  return found
}

/** 从 `request/header` 事件读出路由。 */
function routeOfHeader(event) {
  const config = event.data?.header?.config
  if (config === undefined) return null
  return { provider: String(config.provider), model: String(config.model) }
}

/** 从 `request/context` 事件读出路由。 */
function routeOfContext(event) {
  const data = event.data
  if (data === undefined) return null
  return { provider: String(data.provider), model: String(data.model) }
}

/**
 * 构造 `tokenFee` 投影单元。
 *
 * 折叠语义与 `tokenUsage` 一致：同一 `(turn, step)` 的后续样本替换先前样本，
 * `llm/retry-started` 关闭该替换槽位，因此同一步骤中的重试会各自计费。差别只在
 * 于每个样本按当时的 `(provider, model)` 与事件时间所属时段分桶。
 *
 * @param store - 价目表存储，用于判定时段。
 * @returns 满足 `ctx.sessionProjections.register()` 契约的投影定义。
 */
export function createProjectionDefinition(store) {
  return {
    key: 'tokenFee',
    stateVersion: STATE_VERSION,
    stateSchema: {
      parse(value) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('tokenFee 状态必须是对象')
        }
        const rows = {}
        const rawRows = value.rows
        if (rawRows !== null && typeof rawRows === 'object' && !Array.isArray(rawRows)) {
          for (const [key, row] of Object.entries(rawRows)) {
            if (row === null || typeof row !== 'object') throw new Error('tokenFee 状态行必须是对象')
            const buckets = {}
            for (const bucket of BUCKET_KEYS) {
              const count = row[bucket]
              if (!Number.isInteger(count) || count < 0) throw new Error(`tokenFee 状态行 ${bucket} 必须是非负整数`)
              buckets[bucket] = count
            }
            rows[key] = {
              provider: String(row.provider),
              model: String(row.model),
              tariff: row.tariff === 'offPeak' ? 'offPeak' : 'peak',
              ...buckets,
            }
          }
        }
        const route = value.route
        const last = value.last
        const parseLastBuckets = (source) => {
          const parsed = {}
          for (const bucket of BUCKET_KEYS) {
            const count = source?.[bucket]
            if (!Number.isInteger(count) || count < 0) throw new Error(`tokenFee 状态 last.${bucket} 必须是非负整数`)
            parsed[bucket] = count
          }
          return parsed
        }
        return {
          route: route === null || typeof route !== 'object'
            ? null
            : { provider: String(route.provider), model: String(route.model) },
          rows,
          last: last === null || typeof last !== 'object'
            ? null
            : {
              turn: Number(last.turn),
              step: Number(last.step),
              key: String(last.key),
              buckets: parseLastBuckets(last.buckets),
            },
        }
      },
    },
    init: () => ({ route: null, rows: {}, last: null }),
    apply: (state, event) => {
      if (event.type === 'llm/retry-started') {
        return state.last !== null && state.last.turn === event.data.turn && state.last.step === event.data.step
          ? { ...state, last: null }
          : state
      }
      if (event.type === 'request/header') {
        const route = routeOfHeader(event)
        if (route === null || (state.route !== null && state.route.provider === route.provider && state.route.model === route.model)) {
          return state
        }
        return { ...state, route }
      }
      if (event.type === 'request/context') {
        const route = routeOfContext(event)
        if (route === null || (state.route !== null && state.route.provider === route.provider && state.route.model === route.model)) {
          return state
        }
        return { ...state, route }
      }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state
      const usage = usageOf(event)
      if (usage === undefined || state.route === null) return state
      const { turn, step } = event.data
      const { provider, model } = state.route
      const entry = matchEntry(store.entries, provider, model)
      const tariff = entry === null ? 'peak' : tariffAt(entry, event.time)
      const key = rowKey(provider, model, tariff)
      const buckets = bucketsFrom(usage)
      // 同一步骤的后续样本替换先前样本：先把它从所属行里减掉，再加回新样本。
      // 行本身可能聚合了多个步骤，因此必须减去上一个样本的桶而不是整行。
      const replacing = state.last !== null && state.last.turn === turn && state.last.step === step
        ? state.last
        : null
      const rows = { ...state.rows }
      if (replacing !== null) {
        const current = rows[replacing.key]
        if (current !== undefined) {
          const remaining = subtractBuckets(current, replacing.buckets)
          if (isZeroBuckets(remaining)) delete rows[replacing.key]
          else rows[replacing.key] = { ...current, ...remaining }
        }
      }
      const merged = addBuckets(rows[key], buckets)
      if (isZeroBuckets(merged)) delete rows[key]
      else rows[key] = { provider, model, tariff, ...merged }
      return { route: state.route, rows, last: { turn, step, key, buckets } }
    },
    wire: {
      viewSchema: {
        parse(value) {
          if (value === null || typeof value !== 'object' || !Array.isArray(value.rows)) {
            throw new Error('tokenFee 视图必须是含 rows 数组的对象')
          }
          return value
        },
      },
      view: state => ({
        route: state.route,
        rows: Object.values(state.rows).map(row => ({
          provider: row.provider,
          model: row.model,
          tariff: row.tariff,
          input: row.input,
          cacheRead: row.cacheRead,
          cacheWrite: row.cacheWrite,
          output: row.output,
        })),
      }),
    },
  }
}

//#endregion

//#region HTTP 端点

/** 写一个 JSON 响应。 */
function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 判断一个 socket 地址是否属于回环网段（IPv4 映射的 IPv6 会被归一化）。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.toLowerCase()
  if (value === '::1') return true
  const ipv4 = value.startsWith('::ffff:') ? value.slice(7) : value
  const octets = ipv4.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** 解析 Host 头里的主机名，兼容带方括号的 IPv6 字面量。 */
function hostNameOf(value) {
  if (typeof value !== 'string') return null
  const host = value.trim().toLowerCase()
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    if (close <= 1) return null
    const suffix = host.slice(close + 1)
    if (suffix !== '' && !/^:\d+$/.test(suffix)) return null
    return host.slice(1, close)
  }
  const firstColon = host.indexOf(':')
  const lastColon = host.lastIndexOf(':')
  if (firstColon !== lastColon) return host
  if (lastColon === -1) return host.replace(/\.$/, '')
  if (!/^\d+$/.test(host.slice(lastColon + 1))) return null
  return host.slice(0, lastColon).replace(/\.$/, '')
}

/** 请求是否来自回环（以对端 socket 为准，Host 头只作附加校验）。 */
function isLoopbackRequest(req) {
  const peer = req.socket?.remoteAddress
  if (!isLoopbackAddress(peer)) return false
  const host = hostNameOf(req.headers.host)
  return host === 'localhost' || isLoopbackAddress(host)
}

/** 读取并解析 JSON 请求体，超限或非法时返回 null。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * 列出当前已配置的 provider 与其模型，供价格编辑器做输入建议。
 *
 * 结果只是建议：adapter 允许接受未列出的模型 id，因此客户端仍必须保持自由
 * 输入。`llm` 服务或某个路由的模型发现不可用时，该部分退化为空列表而不是
 * 让整个请求失败。
 * @param ctx - 端点所在的上下文。
 * @returns `[{ id, name, models: [{ id, name }] }]`，按 provider 注册顺序。
 */
async function listConfiguredRoutes(ctx) {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  let providers
  try {
    providers = llm.listProviders()
  } catch {
    // 路由建议是便利功能，服务异常不应让整个请求失败。
    return []
  }
  return Promise.all(providers.map(async (provider) => {
    let models = []
    try {
      models = (await llm.listModels(provider.id)).map(model => ({ id: model.id, name: model.name }))
    } catch {
      // 模型发现失败只影响建议列表，路由本身仍然可用。
      models = []
    }
    return { id: provider.id, name: provider.name, models }
  }))
}

/**
 * 注册两个价目表端点。
 *
 * handler 必须把 Promise **返回**给 webserver：它用 `await route.handler(...)`
 * 并挂 `.catch()` 做 per-request 兜底。丢弃 Promise（`void handle…`）会让兜底
 * 失效，逃逸的 rejection 落到 app-boot 注册的全局 `unhandledRejection` 处理器，
 * 而那个处理器的行为是直接 `process.exit(1)`——一个端点异常会终止 `dsh web`。
 */
function registerEndpoints(ctx, store) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PRICING_PATH,
    handler: (req, res) => handlePricing(ctx, store, req, res),
  }), 'token-fee: pricing route')
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: PRICING_RESET_PATH,
    handler: (req, res) => handleReset(store, req, res),
  }), 'token-fee: pricing reset route')
}

/** `GET` 返回当前有效价目表，`POST` 用请求体覆盖用户文件。 */
async function handlePricing(ctx, store, req, res) {
  if (!isLoopbackRequest(req)) {
    json(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (req.method === 'GET') {
    await store.refresh()
    json(res, 200, { ok: true, routes: await listConfiguredRoutes(ctx), ...store.snapshot() })
    return
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (req.headers[ACTION_HEADER] !== 'save') {
    json(res, 403, { ok: false, error: 'forbidden-action' })
    return
  }
  const body = await readJsonBody(req)
  if (body === null || body === undefined || typeof body !== 'object') {
    json(res, 400, { ok: false, error: 'invalid-body' })
    return
  }
  try {
    const schedules = body.schedules === undefined || body.schedules === null
      ? null
      : validateSchedules(body.schedules, 'token-fee.json schedules')
    const merged = mergeSchedules(BUILTIN_SCHEDULES, schedules, store.config.schedules)
    // 只校验，不写回归一化结果：条目对命名调度的字符串引用必须原样落盘，
    // 否则规则改动不会传播到引用它的条目。
    validatePricing(body.entries, 'token-fee.json entries', merged)
    await store.save({
      version: 1,
      ...schedules === null ? {} : { schedules: body.schedules },
      entries: body.entries,
    })
  } catch (error) {
    json(res, 400, { ok: false, error: 'invalid-pricing', message: String(error?.message ?? error) })
    return
  }
  json(res, 200, { ok: true, ...store.snapshot() })
}

/** 删除用户文件，回到内置 + 配置层。 */
async function handleReset(store, req, res) {
  if (!isLoopbackRequest(req)) {
    json(res, 403, { ok: false, error: 'forbidden' })
    return
  }
  if (req.method !== 'POST') {
    json(res, 405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (req.headers[ACTION_HEADER] !== 'reset') {
    json(res, 403, { ok: false, error: 'forbidden-action' })
    return
  }
  try {
    await store.reset()
  } catch (error) {
    // 删除失败（权限、占用）要变成可读响应，而不是让异常逃逸到进程级处理器。
    json(res, 500, { ok: false, error: 'reset-failed', message: String(error?.message ?? error) })
    return
  }
  json(res, 200, { ok: true, ...store.snapshot() })
}

//#endregion

/**
 * 插件入口。
 * @param ctx - host 根上下文。
 * @param config - cordis 传入的插件配置。
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const store = new PricingStore(resolved)
  void store.refresh()

  ctx.inject(['sessionProjections'], (scoped) => {
    scoped.effect(
      () => scoped.sessionProjections.register(createProjectionDefinition(store)),
      'token-fee: tokenFee projection',
    )
  })

  ctx.inject(['webServer'], (scoped) => {
    registerEndpoints(scoped, store)
  })
}

export { BUILTIN_PRICING, DEFAULT_CURRENCY }
