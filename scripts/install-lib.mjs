/**
 * dsh-token-fee 安装器的可复用逻辑。
 *
 * 与 CLI（`scripts/install.mjs`）分开，是为了能**在进程内**测试：本机沙箱禁止带管道
 * 的 `child_process`（EPERM），而安装器的价值恰恰在于「装完之后副本能不能真的
 * import 起来」——那条断言只有在同一进程里 `import()` 安装副本才能做。
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * 必须随包落地的运行时文件。
 *
 * `lib/index.js` 在模块顶层同步读 `data/cn-holidays.json`（缺失即抛），因此安装器
 * 只要漏拷 `data/`，装出来的插件在 `dsh web` 装载期就 FAILED——而用户按提示重启后
 * 只会看到功能消失。这条清单让 `--check` 能当场发现这类「装了一半」。
 */
export const RUNTIME_FILES = [
  'package.json',
  'cordis.patch.yml',
  join('lib', 'index.js'),
  join('lib', 'client.js'),
  join('lib', 'pricing.js'),
  join('data', 'cn-holidays.json'),
]

/** 安装器自身要复制过去的脚本（install.mjs 复用本模块，所以两个都要）。 */
export const INSTALLER_FILES = ['install.mjs', 'install-lib.mjs']

/** 随包发布的顶层条目（package.json 的 `files` 白名单之外的回退清单）。 */
const FALLBACK_ENTRIES = ['lib', 'data', 'docs', 'cordis.patch.yml', 'README.md', 'README.en.md', 'LICENSE']

/**
 * 复制清单：与 package.json 的 `files` 对齐，避免发布清单加了目录而安装器跟不上
 * （`data/` 就是这样漏掉的）。`package.json` 不在 `files` 里（npm 隐式包含），
 * 必须显式补上；`scripts/` 只单独复制安装器自身，不整目录搬。
 * @param pkg - 本包 package.json 的内容。
 * @returns 需要整体复制的顶层条目。
 */
export function shippedEntries(pkg) {
  const listed = Array.isArray(pkg.files) && pkg.files.length > 0 ? pkg.files : FALLBACK_ENTRIES
  const entries = new Set(['package.json'])
  for (const entry of listed) {
    const clean = String(entry).replace(/\/+$/, '')
    if (clean === '') continue
    const top = clean.split('/')[0]
    if (top === 'scripts') continue
    entries.add(top)
  }
  return [...entries]
}

/** 目标安装目录。 */
export function installTarget(dshHome, packageName) {
  const packagePath = packageName.split('/')
  if (packagePath.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`非法的包名：${packageName}`)
  }
  return join(dshHome, 'profiles', 'node_modules', ...packagePath)
}

/** 幂等追加插件 patch 记录时用的那一行匹配式。 */
export function nameLineOf(packageName) {
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s+name:\\s*${escapeRegExp(JSON.stringify(packageName))}\\s*$`, 'm')
}

/** 去掉只含空根序列 `[]` 的文档，避免与后续列表项冲突。 */
export function withoutEmptyRoot(text) {
  return text
    .split(/\r?\n/)
    .filter(line => line.trim() !== '[]' && line.trim() !== '...')
    .join('\n')
    .trimEnd()
}

/**
 * 幂等地追加插件 patch 记录。
 *
 * 返回值**不带**尾换行：写入方统一补一个 `\n`。两边都加会让第一次写入比后续多出
 * 一个空行，从而破坏幂等（第二次安装"改变了"文件）。
 * @param text - 现有 patch 内容。
 * @param packageName - 包名。
 * @param comment - 引言注释。
 * @returns 追加后的内容（不带尾换行）。
 */
export function enablePlugin(text, packageName, comment = '# dsh-token-fee：会话实时花费') {
  const base = withoutEmptyRoot(text)
  if (nameLineOf(packageName).test(base)) return base
  const block = `${comment}\n- insert:\n    - id: token-fee\n      name: ${JSON.stringify(packageName)}`
  return base.trim() === '' ? block : `${base}\n\n${block}`
}

/** 读文件，不存在时返回 null。 */
export async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 校验安装结果。
 * @param options - `{ sourceRoot, dshHome, packageName, expectEnabled }`。
 * @returns 校验通过时的安装目录。
 * @throws 已安装版本与源不一致、缺少运行时文件、或 patch 缺少记录时。
 */
export async function verify({ sourceRoot, dshHome, packageName, expectEnabled }) {
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const target = installTarget(dshHome, packageName)
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')
  const installedRaw = await readOptional(join(target, 'package.json'))
  if (installedRaw === null) throw new Error(`尚未安装到 ${target}`)
  const installed = JSON.parse(installedRaw)
  if (installed.name !== sourcePackage.name || installed.version !== sourcePackage.version) {
    throw new Error(`已安装的是 ${installed.name ?? '未知'}@${installed.version ?? '未知'}，期望 ${sourcePackage.name}@${sourcePackage.version}`)
  }
  const missing = []
  for (const relative of RUNTIME_FILES) {
    // 用读文件而不是 existsSync：目录也能「存在」，但读不出内容同样是装坏了。
    if (await readOptional(join(target, relative)) === null) missing.push(relative)
  }
  if (missing.length > 0) {
    throw new Error(`安装不完整，缺少运行时文件：${missing.join(', ')}（host 半会在装载期失败）`)
  }
  if (expectEnabled) {
    const patch = await readOptional(patchPath) ?? ''
    if (!nameLineOf(packageName).test(patch)) throw new Error(`${patchPath} 中缺少 ${JSON.stringify(packageName)} 记录`)
  }
  return { target, patchPath, sourcePackage }
}

/**
 * 执行安装：复制运行文件，按需追加 patch 记录，最后自校验。
 * @param options - `{ sourceRoot, dshHome, packageName, enable }`。
 * @returns `{ target, patchPath, sourcePackage }`。
 */
export async function install({ sourceRoot, dshHome, packageName, enable }) {
  const sourcePackage = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'))
  const target = installTarget(dshHome, packageName)
  const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

  await mkdir(target, { recursive: true })
  for (const entry of shippedEntries(sourcePackage)) {
    await cp(join(sourceRoot, entry), join(target, entry), { recursive: true, force: true })
  }
  await mkdir(join(target, 'scripts'), { recursive: true })
  for (const file of INSTALLER_FILES) {
    await cp(join(sourceRoot, 'scripts', file), join(target, 'scripts', file), { force: true })
  }

  if (enable) {
    await mkdir(dirname(patchPath), { recursive: true })
    const current = await readOptional(patchPath) ?? ''
    const next = enablePlugin(current, packageName)
    if (next !== current) await writeFile(patchPath, `${next}\n`, 'utf8')
  }

  return await verify({ sourceRoot, dshHome, packageName, expectEnabled: enable })
}
