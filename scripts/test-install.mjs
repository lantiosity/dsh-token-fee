#!/usr/bin/env node
/**
 * dsh-token-fee 安装器（`scripts/install.mjs` + `install-lib.mjs`）的端到端测试。
 *
 * 覆盖「装完到底能不能用」：安装器把运行文件复制进临时 DSH_HOME 之后，**真的
 * `import()` 安装副本的 host 半**——`lib/index.js` 在模块顶层同步读
 * `data/cn-holidays.json`，只要复制清单漏了 `data/`，这一步就会 ENOENT
 * （v0.6.0 正是如此：README 宣传的兜底安装路径装完即坏）。
 *
 * 走进程内导入而不是 spawn：本机沙箱禁止带管道的 `child_process`（EPERM），而
 * 安装逻辑本来就不需要子进程。
 *
 * 全程只用临时目录，不触碰真实 `~/.dsh`。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { install, installTarget, shippedEntries, verify } from './install-lib.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const packageJson = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const NAME = packageJson.name

let passed = 0
const failures = []

async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name}`)
    console.log(`  ${error?.message ?? error}`)
  }
}

async function withHome(body) {
  const home = await mkdtemp(join(tmpdir(), 'token-fee-install-'))
  try {
    return await body(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

await test('复制清单与 package.json 的 files 对齐（含 data/）', async () => {
  const entries = shippedEntries(packageJson)
  for (const required of ['lib', 'data', 'cordis.patch.yml']) {
    assert.ok(entries.includes(required), `清单应包含 ${required}，实际 ${entries.join(', ')}`)
  }
  assert.ok(!entries.includes('scripts'), 'scripts 只单独复制安装器自身')
})

await test('安装后 host 半能真的 import（顶层读取的运行时文件都在）', async () => {
  await withHome(async (home) => {
    const result = await install({ sourceRoot: ROOT, dshHome: home, packageName: NAME, enable: false })
    const root = installTarget(home, NAME)
    assert.equal(result.target, root)
    for (const relative of ['lib/index.js', 'lib/client.js', 'lib/pricing.js', 'data/cn-holidays.json', 'cordis.patch.yml', 'package.json']) {
      await stat(join(root, relative))
    }
    // 真正的装载：模块顶层会读 data/cn-holidays.json，缺失即抛。
    const loaded = await import(`${pathToFileURL(join(root, 'lib', 'index.js')).href}?probe=${Date.now()}`)
    assert.equal(typeof loaded.apply, 'function', 'host 半应导出 apply(ctx)')
    assert.equal(loaded.name, 'token-fee')
    // 已安装副本自校验通过。
    const checked = await verify({ sourceRoot: ROOT, dshHome: home, packageName: NAME, expectEnabled: false })
    assert.equal(checked.target, root)
  })
})

await test('运行时文件缺失时 --check 失败而不是报「已校验」', async () => {
  await withHome(async (home) => {
    await install({ sourceRoot: ROOT, dshHome: home, packageName: NAME, enable: false })
    const root = installTarget(home, NAME)
    // 复现 v0.6.0 的缺陷：删掉 data/ 后旧实现仍然打印「已校验」。
    await rm(join(root, 'data'), { recursive: true, force: true })
    await assert.rejects(
      () => verify({ sourceRoot: ROOT, dshHome: home, packageName: NAME, expectEnabled: false }),
      (error) => {
        assert.match(String(error.message), /data[\\/]cn-holidays\.json/, '错误信息应点名缺失的文件')
        return true
      },
    )
  })
})

await test('安装器幂等：重复安装不会重复写 patch 记录', async () => {
  await withHome(async (home) => {
    await install({ sourceRoot: ROOT, dshHome: home, packageName: NAME, enable: true })
    const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const first = await readFile(patchPath, 'utf8')
    await install({ sourceRoot: ROOT, dshHome: home, packageName: NAME, enable: true })
    const second = await readFile(patchPath, 'utf8')
    assert.equal(second, first, '第二次安装不应改变 patch 文件')
    assert.equal((second.match(new RegExp(`name: ${JSON.stringify(NAME)}`, 'g')) ?? []).length, 1, '只应有一条记录')
    // 空根序列 `[]` 被清掉，避免与列表项冲突。
    assert.doesNotMatch(second, /^\s*\[\]\s*$/m)
  })
})

await test('已安装版本与源不一致时校验报错', async () => {
  await withHome(async (home) => {
    await install({ sourceRoot: ROOT, dshHome: home, packageName: NAME, enable: false })
    const manifestPath = join(installTarget(home, NAME), 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.version = '0.0.0-stale'
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    await assert.rejects(
      () => verify({ sourceRoot: ROOT, dshHome: home, packageName: NAME, expectEnabled: false }),
      /0\.0\.0-stale/,
    )
  })
})

if (failures.length > 0) {
  console.log(`\n${passed} 个用例通过，${failures.length} 个失败（安装器）`)
  process.exit(1)
}
console.log(`\n${passed} 个用例通过，0 个失败（安装器）`)
