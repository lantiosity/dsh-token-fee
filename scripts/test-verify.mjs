#!/usr/bin/env node
/**
 * `scripts/verify.mjs` 的退出码语义测试。
 *
 * 这条覆盖的是「发布闸门本身」：进程级套件在没有 dsh 的环境里退出 77，必须被当成
 * **跳过**而不是失败（否则 CI 的离线 job 必红）；严格模式下则必须变红。
 * 只测纯判定函数，不真的跑套件——所以不会拖慢闸门。
 *
 * 运行：node scripts/test-verify.mjs
 */

import assert from 'node:assert/strict'

import { SKIP_CODE, classifyProcessExit } from './verify.mjs'

let passed = 0
const failures = []

function test(name, body) {
  try {
    body()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name}`)
    console.log(`  ${error?.message ?? error}`)
  }
}

test('普通模式：0 通过、77 跳过、其它失败', () => {
  assert.equal(classifyProcessExit(0, false), 'ok')
  assert.equal(classifyProcessExit(SKIP_CODE, false), 'skipped')
  assert.equal(classifyProcessExit(1, false), 'failed')
  assert.equal(classifyProcessExit(2, false), 'failed')
  assert.equal(SKIP_CODE, 77, '跳过码必须与 test-process.mjs 的约定一致（77）')
})

test('严格模式：除 0 以外都算失败（跳过也不再放过）', () => {
  assert.equal(classifyProcessExit(0, true), 'ok')
  assert.equal(classifyProcessExit(SKIP_CODE, true), 'failed')
  assert.equal(classifyProcessExit(1, true), 'failed')
})

if (failures.length > 0) {
  console.log(`\n${passed} 个用例通过，${failures.length} 个失败（闸门语义）`)
  process.exit(1)
}
console.log(`\n${passed} 个用例通过，0 个失败（闸门语义）`)
