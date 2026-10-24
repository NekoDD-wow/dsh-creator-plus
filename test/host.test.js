// Host 接线：用桩替换 @deepseek-ai/dsh-tools 和 Cordis 上下文，检查只给指定预设的 agent 安装工具与提醒。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, cp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadPlugin() {
  const dir = await mkdtemp(join(tmpdir(), 'host-'))
  await cp(join(root, 'index.js'), join(dir, 'index.js'))
  await cp(join(root, 'lib'), join(dir, 'lib'), { recursive: true })
  await writeFile(join(dir, 'package.json'), '{"type":"module"}')
  const stub = join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools')
  await mkdir(stub, { recursive: true })
  await writeFile(join(stub, 'package.json'), '{"name":"@deepseek-ai/dsh-tools","type":"module","exports":"./index.js"}')
  return import(pathToFileURL(join(dir, 'index.js')).href)
}

function fakeAgent(preset) {
  const agent = { preset, tools: [], sections: [], disposed: 0 }
  agent.ctx = {
    inject(_deps, cb) {
      const scope = {
        tools: { register: t => agent.tools.push(t.name) },
        systemPrompt: { section: s => agent.sections.push(s) },
      }
      cb(scope)
      return { dispose: async () => { agent.disposed++; agent.tools = []; agent.sections = [] } }
    },
  }
  return agent
}

function fakeCtx(agents) {
  const handlers = {}
  const effects = []
  return {
    handlers, effects,
    agents: { list: () => agents },
    agentPresets: { composedPreset: c => agents.find(a => a.ctx === c)?.preset },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    emit: async (ev, p) => { for (const fn of handlers[ev] || []) await fn(p) },
    effect: fn => effects.push(fn()),
    logger: { warn() {} },
  }
}

test('只给 cordis 预设安装，切换预设时增删', async () => {
  const { apply, normalizeConfig } = await loadPlugin()
  const creator = fakeAgent('cordis')
  const std = fakeAgent('standard')
  const ctx = fakeCtx([creator, std])
  apply(ctx, { presets: ['cordis'] })
  assert.deepEqual(creator.tools, ['clone_check', 'clone_close'])
  assert.equal(creator.sections.length, 1)
  assert.match(creator.sections[0].text(), /clone_check/)
  assert.deepEqual(std.tools, [])

  const late = fakeAgent('cordis')
  ctx.agents.list().push(late)
  await ctx.emit('agent/created', { agent: late })
  assert.deepEqual(late.tools, ['clone_check', 'clone_close'])

  std.preset = 'cordis'
  await ctx.emit('tools/change')
  assert.deepEqual(std.tools, ['clone_check', 'clone_close'])
  creator.preset = 'standard'
  await ctx.emit('tools/change')
  assert.equal(creator.disposed, 1)

  await ctx.emit('agent/disposed', { agent: late })
  assert.equal(late.disposed, 1)
  await ctx.effects[0]()
  assert.equal(std.disposed, 1)

  assert.throws(() => normalizeConfig({ presets: 'cordis' }), /presets/)
})

test('clone_check 的 mode 校验与 clone_close', async () => {
  const { apply } = await loadPlugin()
  const a = fakeAgent('cordis')
  let check, close
  a.ctx.inject = (_d, cb) => { cb({ tools: { register: t => { if (t.name === 'clone_check') check = t; else close = t } }, systemPrompt: { section() {} } }); return { dispose: async () => {} } }
  apply(fakeCtx([a]), {})
  await assert.rejects(check.execute({ mode: 'weird' }, {}), /mode/)
  const r = await close.execute({ id: 'all' })
  assert.deepEqual(r.closed, [])
  assert.match(close.output.render({}, r)[0].text, /No matching/)
})
