// 端到端：假 dsh + 真实 Chromium。没有浏览器时跳过浏览器用例。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readdir, mkdir, symlink, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runClone } from '../lib/clone.js'
import { findBrowser } from '../lib/locate.js'

const here = dirname(fileURLToPath(import.meta.url))
const dsh = { command: process.execPath, args: [join(here, 'fixtures', 'fake-dsh.mjs')], env: {}, shell: false, source: 'test' }
const browser = findBrowser()
// CI 的无头 Chromium 冷启动更慢，且 /dev/shm 偏小；放宽就绪上限并禁用 dev-shm。
const browserArgs = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []
const browserTimeoutMs = 60000

async function bundle(behavior) {
  const dir = await mkdtemp(join(tmpdir(), 'bundle-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: `@t/${behavior}`, fakeBehavior: behavior, dsh: { bundle: { patch: './p.yml' } } }))
  return dir
}

async function run(behavior, extra = {}) {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'e2e-'))
  const artifactsDir = join(tmpRoot, 'shots')
  const r = await runClone({ dsh, browser, browserArgs, browserTimeoutMs, packageDir: behavior && await bundle(behavior), tmpRoot, artifactsDir, settleMs: 800, startTimeoutMs: 20000, ...extra })
  const left = (await readdir(tmpRoot)).filter(n => n.startsWith('dsh-clone-'))
  return { r, left }
}

test('正常插件：PASS，截图生成，临时目录清理', { skip: !browser }, async () => {
  const { r, left } = await run('ok', { expectText: 'clone ok' })
  assert.equal(r.ok, true, JSON.stringify(r, null, 2))
  assert.equal(r.visualVerified, true)
  assert.equal(r.activationWarnings, undefined, '正常启动不应有激活告警')
  assert.ok(r.page.screenshot && existsSync(r.page.screenshot))
  assert.deepEqual(left, [])
})

test('可选 entry 未激活：页面正常也必须 FAIL，并带回 did not activate 告警', async () => {
  // 对应 0.2.2 的漏判：apply() 抛错时只打 stderr 告警，`dsh web:` 照常打印、页面 200。
  const { r, left } = await run('inactive-entry', { browser: undefined })
  assert.equal(r.ok, false, JSON.stringify(r, null, 2))
  assert.ok(r.activationWarnings?.length >= 1, '应解析出激活告警块')
  assert.match(r.activationWarnings[0], /did not activate/)
  assert.match(r.activationWarnings[0], /boom on purpose/)
  assert.ok(r.verdict.reasons.some(x => x.includes('did not activate')), r.verdict.reasons.join('\n'))
  assert.match(r.serverLog || '', /did not activate/)
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

test('复制模式：目录链接在副本里被重建（Windows junction 不依赖符号链接权限）', async () => {
  const src = await mkdtemp(join(tmpdir(), 'srchome-'))
  const prof = join(src, 'profiles', 'web')
  const dep = join(src, 'plugin-src')
  await mkdir(join(prof, 'node_modules'), { recursive: true })
  await mkdir(dep, { recursive: true })
  await writeFile(join(dep, 'index.js'), 'export default 1')
  await writeFile(join(prof, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  await symlink(dep, join(prof, 'node_modules', 'linked-plugin'), 'junction')

  const { r } = await run('ok', { mode: 'copy', browser: undefined, sourceProfileDir: prof, sourceHome: src, keepAlive: true })
  try {
    assert.equal(r.ok, true, JSON.stringify(r, null, 2))
    const copied = join(r.root, 'home', 'profiles', 'clone', 'node_modules', 'linked-plugin')
    assert.ok(existsSync(join(copied, 'index.js')), '副本里的目录链接应能解析到插件内容')
    if (process.platform === 'win32') {
      assert.ok(r.notes.some(n => n.includes('junction')), r.notes.join('\n'))
      assert.equal((await lstat(copied)).isSymbolicLink(), true)
    }
  } finally {
    await r.close?.()
  }
})

test('参数校验：相对路径被拒绝', async () => {
  await assert.rejects(runClone({ dsh, packageDir: 'relative/dir' }), /绝对路径/)
})

test('参数校验：packageDir 含 shell 元字符直接拒绝（不交给 shell）', async () => {
  const malicious = process.platform === 'win32' ? 'C:/work/a&calc' : '/tmp/a&calc'
  await assert.rejects(runClone({ dsh, packageDir: malicious }), /参数不合法/)
})
