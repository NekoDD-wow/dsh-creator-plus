import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUrlLine, redactUrl, filterBundlesForClone, childEnv, judge, filterIgnored } from '../lib/clone.js'
import { resolveDshCommand, browserCandidates, findBrowser } from '../lib/locate.js'

test('parseUrlLine 识别 dsh web 行并去掉 ANSI', () => {
  assert.equal(parseUrlLine('boot...\n\x1b[32mdsh web:\x1b[0m http://127.0.0.1:5000/?token=abc\n'), 'http://127.0.0.1:5000/?token=abc')
  assert.equal(parseUrlLine('nothing here'), undefined)
})

test('redactUrl 隐去 token', () => {
  assert.equal(redactUrl('http://127.0.0.1:1/?token=abc&x=1'), 'http://127.0.0.1:1/?token=***&x=1')
})

test('复制模式过滤桌面专属 bundle', () => {
  const r = filterBundlesForClone(['@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-host', '@x/y'])
  assert.deepEqual(r.kept, ['@deepseek-ai/dsh-web-app', '@x/y'])
  assert.deepEqual(r.dropped, ['@deepseek-ai/dsh-desktop-host'])
})

test('childEnv 不把本体 profile 泄漏给分身', () => {
  const env = childEnv({ PATH: '/bin', DSH_PROFILE: 'desktop', DSH_PROFILE_DIR: '/p', DSH_SESSION_ID: 's', ELECTRON_RUN_AS_NODE: '1' }, '/tmp/h', { ELECTRON_RUN_AS_NODE: '1' })
  assert.equal(env.DSH_HOME, '/tmp/h')
  assert.equal(env.DSH_PROFILE, undefined)
  assert.equal(env.DSH_PROFILE_DIR, undefined)
  assert.equal(env.DSH_SESSION_ID, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.PATH, '/bin')
})

test('resolveDshCommand：桌面版走内置 CLI', () => {
  const r = resolveDshCommand({ platform: 'win32', execPath: 'C:\\App\\DeepSeek Harness.exe', versions: { electron: '33' }, argv: [] })
  assert.equal(r.source, 'desktop')
  assert.equal(r.command, 'C:\\App\\DeepSeek Harness.exe')
  assert.equal(r.args[0], '--expose-internals')
  assert.match(r.args[1].replace(/\\/g, '/'), /resources\/app\.asar\/dsh\/node_modules\/@deepseek-ai\/dsh-desktop-host\/lib\/cli\.js$/)
  assert.equal(r.env.ELECTRON_RUN_AS_NODE, '1')
})

test('resolveDshCommand：macOS 桌面 Resources 路径', () => {
  const r = resolveDshCommand({ platform: 'darwin', execPath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', versions: { electron: '33' }, argv: [] })
  assert.match(r.args[1], /DeepSeek Harness\.app\/Contents\/Resources\/app\.asar\/dsh\//)
})

test('resolveDshCommand：CLI 入口与 PATH 兜底', () => {
  const entry = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const r = resolveDshCommand({ platform: 'linux', execPath: '/usr/bin/node', versions: {}, argv: ['/usr/bin/node', entry], exists: p => p === entry, realpath: p => p })
  assert.deepEqual([r.source, r.command, r.args[0]], ['cli-entry', '/usr/bin/node', entry])
  const f = resolveDshCommand({ platform: 'win32', versions: {}, argv: [], exists: () => false, requireFrom: () => { throw new Error('x') } })
  assert.deepEqual([f.source, f.command, f.shell], ['path', 'dsh.cmd', true])
})

test('resolveDshCommand：配置覆盖', () => {
  const r = resolveDshCommand({ override: ['/opt/dsh', '--x'] })
  assert.deepEqual([r.command, r.args, r.source], ['/opt/dsh', ['--x'], 'config'])
})

test('浏览器候选：Windows Edge 优先', () => {
  const c = browserCandidates({ platform: 'win32', env: { 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' } })
  assert.match(c[0], /Edge.*msedge\.exe$/)
  assert.ok(findBrowser({ platform: 'darwin', env: {}, exists: p => p.includes('Google Chrome') }).includes('Google Chrome'))
  assert.equal(findBrowser({ platform: 'linux', env: { PATH: '' }, exists: () => false }), undefined)
})

test('judge 判定', () => {
  const okProbe = { textLength: 10, rootChildren: 2, expectTextFound: null, expectSelectorFound: null }
  assert.equal(judge({ navigated: true, loaded: true, errors: [], probe: okProbe }).ok, true)
  assert.equal(judge({ navigated: true, loaded: true, errors: ['[pageerror] x'], probe: okProbe }).ok, false)
  assert.equal(judge({ navigated: true, loaded: true, errors: [], probe: { ...okProbe, textLength: 0, rootChildren: 0 } }).ok, false)
  assert.equal(judge({ navigated: true, loaded: true, errors: [], probe: { ...okProbe, expectTextFound: false } }).ok, false)
  assert.equal(judge({ navigated: false, navError: 'net::ERR', errors: [] }).ok, false)
})

test('filterIgnored', () => {
  assert.deepEqual(filterIgnored(['[log] favicon 404', '[pageerror] boom'], ['favicon']), ['[pageerror] boom'])
})

test('defineTool 产出合法 JSON Schema：required 提到顶层、返回值去掉 undefined', async () => {
  const { defineTool } = await import('../index.js')
  const t = defineTool({ name: 'x', description: 'd', parameters: { id: { type: 'string', required: true, description: 'i' }, n: { type: 'boolean' } }, output: { schema: { type: 'json' }, render: () => [] }, execute: async () => ({ a: 1, b: undefined, c: [undefined] }) })
  assert.deepEqual(t.parameters, { type: 'object', properties: { id: { type: 'string', description: 'i' }, n: { type: 'boolean' } }, additionalProperties: false, required: ['id'] })
  assert.deepEqual(await t.execute({ id: 'q' }), { a: 1, c: [null] })
  await assert.rejects(t.execute({}), /缺少参数 id/)
  await assert.rejects(t.execute({ id: 'q', n: 'yes' }), /应为 boolean/)
})
