// 端到端：假 dsh + 真实 Chromium。没有浏览器时跳过浏览器用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClone } from '../lib/clone.js'
import { findBrowser } from '../lib/locate.js'

const here = dirname(fileURLToPath(import.meta.url))
const dsh = { command: process.execPath, args: [join(here, 'fixtures', 'fake-dsh.mjs')], env: {}, shell: false, source: 'test' }
const browser = findBrowser()
const browserArgs = process.platform === 'linux' ? ['--no-sandbox'] : []

async function bundle(behavior) {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@t/${behavior}`, fakeBehavior: behavior, dsh: { bundle: { patch: './p.yml' } } }))
  return dir
}

async function run(behavior, extra = {}) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'e2e-'))
  const artifactsDir = join(tmpRoot, 'shots')
  const r = await runClone({ dsh, browser, browserArgs, packageDir: behavior && await bundle(behavior), tmpRoot, artifactsDir, settleMs: 800, startTimeoutMs: 20000, ...extra })
  const left = (await readdir(tmpRoot)).filter(n => n.startsWith('dsh-clone-'))
  return { r, left }
}

test('正常插件：PASS，截图生成，临时目录清理', { skip: !browser }, async () => {
  const { r, left } = await run('ok', { expectText: 'clone ok' })
  assert.equal(r.ok, true, JSON.stringify(r, null, 2))
  assert.equal(r.visualVerified, true)
  assert.ok(r.page.screenshot && existsSync(r.page.screenshot))
  assert.deepEqual(left, [])
})

test('前端崩溃：FAIL 并带回 pageerror', { skip: !browser }, async () => {
  const { r } = await run('client-crash')
  assert.equal(r.ok, false)
  assert.ok(r.page.errors.some(e => e.includes('slot entry crashed')), r.page.errors.join('\n'))
})

test('白屏：FAIL', { skip: !browser }, async () => {
  const { r } = await run('blank')
  assert.equal(r.ok, false)
  assert.ok(r.verdict.reasons.some(x => x.includes('空白')))
})

test('Host 起不来：FAIL 并带回日志', async () => {
  const { r, left } = await run('host-crash')
  assert.equal(r.ok, false)
  assert.match(r.error, /就绪前退出/)
  assert.match(r.steps.at(-1).stderr || r.serverLog, /boom/)
  assert.deepEqual(left, [])
})

test('没有浏览器：降级为 HTTP 检查并注明', async () => {
  const { r } = await run('ok', { browser: undefined })
  assert.equal(r.ok, true)
  assert.equal(r.visualVerified, false)
  assert.ok(r.notes.some(n => n.includes('没找到')))
})

test('keepAlive：保留分身直到 close', { skip: !browser }, async () => {
  const { r } = await run('ok', { keepAlive: true })
  assert.equal(r.kept, true)
  const res = await fetch(r.viewUrl)
  assert.equal(res.status, 200)
  await r.close()
  await assert.rejects(fetch(r.viewUrl))
  assert.equal(existsSync(r.root), false)
})

test('复制模式：复制 profile 并去掉桌面 bundle', async () => {
  const src = await mkdtemp(join(tmpdir(), 'srchome-'))
  const prof = join(src, 'profiles', 'desktop')
  await mkdir(prof, { recursive: true })
  await writeFile(join(prof, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-host'] } } }))
  await writeFile(join(src, 'cordis.patch.yml'), '[]\n')
  const { r } = await run('ok', { mode: 'copy', browser: undefined, sourceProfileDir: prof, sourceHome: src })
  assert.equal(r.ok, true, JSON.stringify(r, null, 2))
  assert.ok(r.notes.some(n => n.includes('dsh-desktop-host')))
  assert.ok(r.notes.some(n => n.includes('home 级')))
})

test('参数校验：相对路径被拒绝', async () => {
  await assert.rejects(runClone({ dsh, packageDir: 'relative/dir' }), /绝对路径/)
})
