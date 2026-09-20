#!/usr/bin/env node
/**
 * dsh-token-fee 进程级回归。
 *
 * `test-host.mjs` 用 `fakeContext()` 手搭上下文，覆盖不到真实装载路径。这里用
 * `--patch` overlay 把插件装进一个真实的 `dsh web` 进程，探测两个端点，并验证
 * **端点异常时进程仍然存活**——P0-1 的原始症状正是一个逃逸的 rejection 会让
 * `dsh web` 直接退出。
 *
 * 需要 `dsh` 在 PATH 上且本机可启动 web profile；任一条不满足时整体跳过（退出码
 * 0），因此可以在没有 dsh 的环境里安全运行。
 *
 * 运行：node scripts/test-process.mjs
 */

import { spawn } from 'node:child_process'
import { request as httpRequest, createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`
const PRICING = `${BASE}/api/token-fee/pricing`
const RESET = `${BASE}/api/token-fee/pricing/reset`
const ACTION_HEADER = 'x-dsh-token-fee-action'
const START_TIMEOUT_MS = 120_000

/**
 * 取一个当前空闲的端口。
 *
 * 固定端口会让并行运行互相冲突（本机 GUI 也可能占用），因此让 OS 分配后立刻释放。
 * @returns 可用的端口号。
 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('未能取到空闲端口'))))
    })
  })
}

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

/** 轮询直到服务器应答或超时。 */
async function waitForServer(deadline) {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(PRICING, { headers: { accept: 'application/json' } })
      if (response.status > 0) return true
    } catch {
      // 还没起来，继续等。
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/** 带超时的 fetch，避免用例挂死。 */
async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
}

/**
 * 用 node:http 发一个可以自定义 `Host` 的原始请求。
 *
 * undici 的 fetch 把 `Host` 当受限头，手工设置会被忽略，因此验证 Host 防线
 * 只能走这一层。
 * @param path - 请求路径。
 * @param host - 要伪造的 Host 头。
 * @returns 状态码。
 */
async function requestWithHost(path, host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: PORT,
      path,
      method: 'GET',
      headers: { host, accept: 'application/json' },
      timeout: 15_000,
    }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('timeout', () => { req.destroy(new Error('请求超时')) })
    req.on('error', reject)
    req.end()
  })
}

// 用 id 定向的 config 覆盖，而不是 insert 一个新条目：插件本就以 bundle 形式装在
// web profile 里，insert 会让同一个插件跑两份实例（同 key 投影 + 同路径端点）。
// 覆盖只把它指向临时价目表，用户的 ~/.dsh/token-fee.json 全程不被触碰。
const overlayDir = await mkdtemp(join(tmpdir(), 'token-fee-process-'))
const overlayPath = join(overlayDir, 'overlay.yml')
const pricingFile = join(overlayDir, 'token-fee.json')
await writeFile(overlayPath, [
  '# 进程级回归用的临时 overlay：把已安装实例的价目表指向临时文件。',
  '- id: token-fee',
  '  config:',
  `    pricingFile: ${JSON.stringify(pricingFile)}`,
  '',
].join('\n'), 'utf8')

// shell 与 args 数组同用会触发 DEP0190；这里把整条命令拼成一个字符串，
// 各段都是本脚本自己产生的值（端口是数字，路径来自 mkdtemp 并加了引号）。
const command = `dsh --profile web --patch "${overlayPath}" --port ${PORT} --no-open`

/**
 * 启动子进程；无法启动时按「跳过」处理。
 *
 * 脚本承诺「没有 dsh 也能安全运行」，而 spawn 本身在受限沙箱、无 spawn 权限的
 * 容器、禁止管道 stdio 的环境里都会失败——那时必须以 0 退出，不能把未捕获异常
 * 抛出去，否则恰好是它最想避免的行为。
 * @returns 子进程，或 null（无法启动）。
 */
function startChild() {
  try {
    return spawn(command, { stdio: ['ignore', 'pipe', 'pipe'], shell: true })
  } catch (error) {
    return { failed: String(error?.message ?? error) }
  }
}

const spawned = startChild()
if (spawned.failed !== undefined || spawned === null) {
  console.log(`跳过进程级回归：无法启动 dsh（${spawned?.failed ?? 'spawn 返回空'}）。`)
  process.exit(0)
}
const child = spawned

let childOutput = ''
let spawnFailure = null
child.stdout.on('data', chunk => { childOutput += chunk })
child.stderr.on('data', chunk => { childOutput += chunk })
let childExited = null
child.on('exit', (code) => { childExited = code ?? 0 })
// 'error' 是异步的 spawn 失败（ENOENT/EPERM），与同步 throw 同样要按跳过处理。
child.on('error', (error) => { spawnFailure = String(error?.message ?? error) })

/** 停掉子进程并等它真正退出。 */
async function stopChild() {
  if (childExited !== null) return
  child.kill()
  const deadline = Date.now() + 15_000
  while (childExited === null && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (childExited === null) child.kill('SIGKILL')
}

let started = false
try {
  started = await waitForServer(Date.now() + START_TIMEOUT_MS)
} catch {
  started = false
}

/** 清理临时目录，避免测试留下垃圾。 */
async function cleanup() {
  await rm(overlayDir, { recursive: true, force: true })
}

if (spawnFailure !== null) {
  await cleanup()
  console.log(`跳过进程级回归：无法启动 dsh（${spawnFailure}）。`)
  process.exit(0)
}

if (!started) {
  await stopChild()
  await cleanup()
  const hint = childExited !== null ? `子进程已退出（code ${childExited}）` : '启动超时'
  console.log(`跳过进程级回归：dsh web 未能在 ${PORT} 上应答（${hint}）。`)
  console.log(childOutput.trim().split('\n').slice(-6).join('\n'))
  process.exit(0)
}

// 插件未装进 web profile 时端点不会注册，请求会落到 connection 的 /api 前缀
// 处理器上（401）或直接 404。这是环境前提不满足，不是回归，因此跳过。
const probe = await fetchWithTimeout(PRICING)
if (probe.status === 401 || probe.status === 404) {
  await stopChild()
  await cleanup()
  console.log(`跳过进程级回归：web profile 中未安装 @lantiosity/dsh-token-fee（探测返回 ${probe.status}）。`)
  console.log('先运行 dsh plugin --profile web add <本目录>，再执行本用例。')
  process.exit(0)
}

try {
  await test('真实装载路径下 GET 返回价目表与路由', async () => {
    const response = await fetchWithTimeout(PRICING)
    if (response.status !== 200) throw new Error(`期望 200，得到 ${response.status}`)
    const body = await response.json()
    if (body.ok !== true) throw new Error(`ok 不为 true：${JSON.stringify(body)}`)
    if (!Array.isArray(body.entries) || body.entries.length === 0) throw new Error('内置条目为空')
    if (!Array.isArray(body.routes)) throw new Error('routes 不是数组')
    if (typeof body.file?.path !== 'string') throw new Error('file.path 缺失')
    // 临时 overlay 的 config 覆盖必须生效：写的是临时文件，不是用户的 ~/.dsh。
    if (body.file.path !== pricingFile) {
      throw new Error(`pricingFile 覆盖未生效：期望 ${pricingFile}，得到 ${body.file.path}`)
    }
  })

  await test('缺少动作头的写请求被拒绝且进程存活', async () => {
    const response = await fetchWithTimeout(PRICING, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries: [] }),
    })
    if (response.status !== 403) throw new Error(`期望 403，得到 ${response.status}`)
    const alive = await fetchWithTimeout(PRICING)
    if (alive.status !== 200) throw new Error('拒绝写请求后端点不再应答')
  })

  await test('非法请求体返回 400 且进程存活', async () => {
    const response = await fetchWithTimeout(PRICING, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'save' },
      body: '{ not json',
    })
    if (response.status !== 400) throw new Error(`期望 400，得到 ${response.status}`)
  })

  await test('非法价目表返回 400 而不是让进程退出', async () => {
    const response = await fetchWithTimeout(PRICING, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'save' },
      body: JSON.stringify({ entries: [{ id: 'x', provider: 'p', model: '', prices: { peak: {} } }] }),
    })
    if (response.status !== 400) throw new Error(`期望 400，得到 ${response.status}`)
  })

  await test('非回环 Host 被拒绝', async () => {
    // Host 头是 DNS-rebinding 防线的一部分：连接落在本机但 Host 是外部域名时拒绝。
    const status = await requestWithHost('/api/token-fee/pricing', 'evil.example.com')
    if (status !== 403) throw new Error(`期望 403，得到 ${status}`)
  })

  await test('回环 Host 仍然放行', async () => {
    const status = await requestWithHost('/api/token-fee/pricing', `127.0.0.1:${PORT}`)
    if (status !== 200) throw new Error(`期望 200，得到 ${status}`)
  })

  await test('reset 生效并回到内置价目', async () => {
    const save = await fetchWithTimeout(PRICING, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'save' },
      body: JSON.stringify({
        entries: [{
          id: 'probe',
          provider: 'my-gateway',
          model: 'glm-5',
          currency: 'CNY',
          prices: { peak: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } },
        }],
      }),
    })
    if (save.status !== 200) throw new Error(`保存失败：${save.status}`)
    const saved = await save.json()
    if (saved.entries.length !== 3) throw new Error(`期望 3 条，得到 ${saved.entries.length}`)
    const reset = await fetchWithTimeout(RESET, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ACTION_HEADER]: 'reset' },
      body: '{}',
    })
    if (reset.status !== 200) throw new Error(`reset 失败：${reset.status}`)
    const after = await reset.json()
    if (after.entries.length !== 2) throw new Error(`reset 后期望 2 条内置，得到 ${after.entries.length}`)
  })

  await test('全程结束后进程仍然存活', async () => {
    if (childExited !== null) {
      throw new Error(`子进程已退出（code ${childExited}）：\n${childOutput.trim().split('\n').slice(-8).join('\n')}`)
    }
    const response = await fetchWithTimeout(PRICING)
    if (response.status !== 200) throw new Error(`端点不再应答：${response.status}`)
  })
} finally {
  await stopChild()
  await cleanup()
}

for (const failure of failures) {
  console.error(`✗ ${failure.label}`)
  console.error(`  ${failure.error.stack ?? failure.error.message}`)
}
console.log(`\n${passed} 个用例通过，${failures.length} 个失败（进程级）`)
process.exit(failures.length === 0 ? 0 : 1)
