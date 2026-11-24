#!/usr/bin/env node
/**
 * 发布闸门编排器（`npm run verify`）。
 *
 * 为什么需要它而不是 `check && test && test:process`：进程级套件在没有 `dsh` 的环境里
 * 以 **77** 退出（autotools 的「skipped」约定）。用 `&&` 串联时 77 会原样传出去，
 * 于是「环境不满足」被当成「失败」——CI 的离线 job 必红，而注释还写着「不会变红」。
 * 这里显式区分三种结果：0 = 真跑过；77 = 跳过（可接受，但要说出来）；其它 = 失败。
 *
 * 设 `TOKEN_FEE_REQUIRE_PROCESS=1` 时，`test-process.mjs` 会把跳过变成失败（退出码 1），
 * 因此本编排器无需特判就能让 CI 的「真跑」job 变红。
 *
 * 运行：node scripts/verify.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 需要先做语法检查的源码文件。 */
const CHECK_FILES = [
  'lib/pricing.js',
  'lib/index.js',
  'lib/client.js',
  'scripts/install.mjs',
  'scripts/install-lib.mjs',
  'scripts/verify.mjs',
  'scripts/test-pricing.mjs',
  'scripts/test-host.mjs',
  'scripts/test-client.mjs',
  'scripts/test-install.mjs',
  'scripts/test-editor.mjs',
  'scripts/test-verify.mjs',
  'scripts/test-process.mjs',
]

/** 离线套件（不依赖 dsh）。 */
const SUITES = [
  'scripts/test-pricing.mjs',
  'scripts/test-host.mjs',
  'scripts/test-client.mjs',
  'scripts/test-install.mjs',
  'scripts/test-editor.mjs',
  'scripts/test-verify.mjs',
]

/** 进程级套件的跳过退出码。 */
export const SKIP_CODE = 77

/**
 * 判定进程级套件的退出码。
 * @param code - 子进程退出码（null 表示被信号终止）。
 * @param required - 是否处于「跳过即失败」的严格模式。
 * @returns `'ok'`、`'skipped'` 或 `'failed'`。
 */
export function classifyProcessExit(code, required) {
  if (required) return code === 0 ? 'ok' : 'failed'
  if (code === 0) return 'ok'
  if (code === SKIP_CODE) return 'skipped'
  return 'failed'
}

/** 跑一个子进程，输出直接透传（避免管道，Windows 沙箱里管道会 EPERM）。 */
function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  return { code: result.status, signal: result.signal }
}

/** 主流程。 */
function main() {
  for (const file of CHECK_FILES) {
    process.stdout.write(`\n> node --check ${file}\n`)
    const { code } = runNode(['--check', file])
    if (code !== 0) {
      console.error(`\n语法检查失败：${file}`)
      process.exit(1)
    }
  }

  for (const suite of SUITES) {
    process.stdout.write(`\n> node ${suite}\n`)
    const { code } = runNode([suite])
    if (code !== 0) {
      console.error(`\n套件失败：${suite}（退出码 ${code}）`)
      process.exit(code ?? 1)
    }
  }

  const required = process.env.TOKEN_FEE_REQUIRE_PROCESS === '1'
  process.stdout.write(`\n> node scripts/test-process.mjs${required ? '（严格模式：跳过即失败）' : ''}\n`)
  const { code } = runNode(['scripts/test-process.mjs'])
  const verdict = classifyProcessExit(code, required)
  if (verdict === 'failed') {
    console.error(`\n进程级套件失败（退出码 ${code}）`)
    process.exit(1)
  }
  if (verdict === 'skipped') {
    console.error('\n进程级套件已跳过：本机没有可用的 dsh。')
    console.error('  发布前请在装好 dsh 的环境里跑 `npm run verify:process`（或设 TOKEN_FEE_REQUIRE_PROCESS=1），')
    console.error('  否则真实装载路径上的回归（端点 404、装载崩溃、overlay 失效）不会被验证。')
  }

  console.log(`\n全部通过${verdict === 'skipped' ? '（进程级套件被跳过）' : ''}。`)
}

// 直接运行时才执行主流程；被测试 import 时只取导出。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
