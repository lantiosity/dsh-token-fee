#!/usr/bin/env node
/**
 * dsh-token-fee 备选安装器。
 *
 * 标准安装路径是 `dsh plugin --profile web add <本目录>`：本包声明了
 * `dsh.bundle.patch`，dsh 会把它并入 profile 的 bundle 层，无需手工编辑
 * profile 的 cordis.patch.yml。本脚本用于无法使用 `dsh plugin`（例如没有
 * pnpm）的场景：把运行文件复制进 profile 的 node_modules，并幂等地向
 * profile patch 追加一条 insert 记录。
 *
 * 两条路径只需其一；同时使用会重复挂载。
 *
 * 用法：
 *   node scripts/install.mjs [--check|--dry-run|--no-enable|--help]
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  --check      校验已安装的包与 patch 记录，不做修改
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
const packagePath = sourcePackage.name.split('/')
if (packagePath.some(part => part === '' || part === '.' || part === '..')) {
  throw new Error(`非法的包名：${sourcePackage.name}`)
}
const target = join(dshHome, 'profiles', 'node_modules', ...packagePath)
const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
const quotedName = JSON.stringify(sourcePackage.name)
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const nameLine = new RegExp(`^\\s+name:\\s*${escapeRegExp(quotedName)}\\s*$`, 'm')
const patchBlock = `# dsh-token-fee：会话实时花费
- insert:
    - id: token-fee
      name: ${quotedName}
`

/** 去掉只含空根序列 `[]` 的文档，避免与后续列表项冲突。 */
function withoutEmptyRoot(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '[]' && line.trim() !== '...')
    .join('\n')
    .trimEnd()
}

/** 幂等地追加插件 patch 记录。 */
function enablePlugin(text) {
  const base = withoutEmptyRoot(text)
  if (nameLine.test(base)) return base
  return base.trim() === '' ? patchBlock : `${base}\n\n${patchBlock}`
}

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function verify(expectEnabled) {
  const installedRaw = await readOptional(join(target, 'package.json'))
  if (installedRaw === null) throw new Error(`尚未安装到 ${target}`)
  const installed = JSON.parse(installedRaw)
  if (installed.name !== sourcePackage.name || installed.version !== sourcePackage.version) {
    throw new Error(`已安装的是 ${installed.name ?? '未知'}@${installed.version ?? '未知'}，期望 ${sourcePackage.name}@${sourcePackage.version}`)
  }
  if (expectEnabled) {
    const patch = await readOptional(patchPath) ?? ''
    if (!nameLine.test(patch)) throw new Error(`${patchPath} 中缺少 ${quotedName} 记录`)
  }
  console.log(`已校验 ${sourcePackage.name}@${sourcePackage.version}`)
  console.log(`  包目录：${target}`)
  if (expectEnabled) console.log(`  patch： ${patchPath}`)
}

const enable = !args.has('--no-enable')

if (args.has('--dry-run')) {
  console.log(`将安装 ${sourcePackage.name}@${sourcePackage.version}`)
  console.log(`  包目录：${target}`)
  console.log(`  patch： ${enable ? patchPath : '不改动（--no-enable）'}`)
  process.exit(0)
}

if (args.has('--check')) {
  await verify(enable)
  process.exit(0)
}

await mkdir(target, { recursive: true })
for (const entry of ['lib', 'cordis.patch.yml', 'package.json', 'README.md', 'LICENSE']) {
  await cp(join(sourceRoot, entry), join(target, entry), { recursive: true, force: true })
}
await mkdir(join(target, 'scripts'), { recursive: true })
await cp(fileURLToPath(import.meta.url), join(target, 'scripts', 'install.mjs'), { force: true })

if (enable) {
  await mkdir(dirname(patchPath), { recursive: true })
  const current = await readOptional(patchPath) ?? ''
  const next = enablePlugin(current)
  if (next !== current) await writeFile(patchPath, `${next}\n`, 'utf8')
}

await verify(enable)
console.log('安装完成。重启 dsh web，然后硬刷新浏览器。')
