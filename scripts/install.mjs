#!/usr/bin/env node
/**
 * dsh-token-fee 备选安装器（CLI）。
 *
 * 标准安装路径是 `dsh plugin --profile web add <本目录>`：本包声明了
 * `dsh.bundle.patch`，dsh 会把它并入 profile 的 bundle 层，无需手工编辑
 * profile 的 cordis.patch.yml。本脚本用于无法使用 `dsh plugin`（例如没有
 * pnpm）的场景：把运行文件复制进 profile 的 node_modules，并幂等地向
 * profile patch 追加一条 insert 记录。
 *
 * 两条路径只需其一；同时使用会重复挂载。
 *
 * 逻辑都在 `scripts/install-lib.mjs`（可导入，便于进程内测试）；本文件只解析参数。
 *
 * 用法：
 *   node scripts/install.mjs [--check|--dry-run|--no-enable|--help]
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { install, installTarget, verify } from './install-lib.mjs'

const KNOWN_FLAGS = new Set(['--check', '--dry-run', '--no-enable', '--help'])
const args = new Set(process.argv.slice(2))
for (const arg of args) {
  if (!KNOWN_FLAGS.has(arg)) {
    console.error(`未知选项：${arg}`)
    process.exit(2)
  }
}

if (args.has('--help')) {
  console.log(`dsh-token-fee 安装器

用法：
  node scripts/install.mjs [选项]

选项：
  --check      校验已安装的包、运行时文件与 patch 记录，不做修改
  --dry-run    只打印将要写入的路径
  --no-enable  只复制文件，不改动 profile 的 cordis.patch.yml
  --help       显示本帮助

设置 DSH_HOME 可覆盖默认的 ~/.dsh 位置。
推荐改用：dsh plugin --profile web add <本目录>`)
  process.exit(0)
}

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const enable = !args.has('--no-enable')
const target = installTarget(dshHome, sourcePackage.name)
const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

if (args.has('--dry-run')) {
  console.log(`将安装 ${sourcePackage.name}@${sourcePackage.version}`)
  console.log(`  包目录：${target}`)
  console.log(`  patch： ${enable ? patchPath : '不改动（--no-enable）'}`)
  process.exit(0)
}

if (args.has('--check')) {
  try {
    const result = await verify({ sourceRoot, dshHome, packageName: sourcePackage.name, expectEnabled: enable })
    console.log(`已校验 ${result.sourcePackage.name}@${result.sourcePackage.version}`)
    console.log(`  包目录：${result.target}`)
    if (enable) console.log(`  patch： ${result.patchPath}`)
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
  process.exit(0)
}

try {
  const result = await install({ sourceRoot, dshHome, packageName: sourcePackage.name, enable })
  console.log(`已校验 ${result.sourcePackage.name}@${result.sourcePackage.version}`)
  console.log(`  包目录：${result.target}`)
  if (enable) console.log(`  patch： ${result.patchPath}`)
  console.log('安装完成。重启 dsh web，然后硬刷新浏览器。')
} catch (error) {
  console.error(`安装失败：${String(error?.message ?? error)}`)
  process.exit(1)
}
