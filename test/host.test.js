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

let agentSeq = 0

function fakeAgent(preset) {
  const agent = { id: `session-${++agentSeq}`, preset, tools: [], sections: [], commands: [], disposed: 0 }
  agent.ctx = {
    inject(_deps, cb) {
      const scope = {
        tools: { register: t => agent.tools.push(t.name) },
        systemPrompt: { section: s => agent.sections.push(s) },
        commands: { register: c => agent.commands.push(c) },
      }
      cb(scope)
      return { dispose: async () => { agent.disposed++; agent.tools = []; agent.sections = []; agent.commands = [] } }
    },
  }
  return agent
}

function fakeCtx(agents) {
  const handlers = {}
  const effects = []
  const commands = []
  const ctx = {
    handlers, effects, commands,
    agents: { list: () => agents, get: id => agents.find(a => a.id === id) },
    agentPresets: { composedPreset: c => agents.find(a => a.ctx === c)?.preset },
    on: (ev, fn) => { (handlers[ev] ||= []).push(fn) },
    emit: async (ev, p) => { for (const fn of handlers[ev] || []) await fn(p) },
    effect: fn => effects.push(fn()),
    logger: { warn() {} },
  }
  // 根上下文的可选注入：全局命令（clone-grant / clone-revoke）走这里。
  ctx.inject = (_deps, cb) => {
    cb({ commands: { register: c => commands.push(c) } })
    return { dispose: async () => {} }
  }
  return ctx
}

test('只给 cordis 预设安装，切换预设时增删', async () => {
  const { apply, normalizeConfig } = await loadPlugin()
  const creator = fakeAgent('cordis')
  const std = fakeAgent('standard')
  const ctx = fakeCtx([creator, std])
  apply(ctx, { presets: ['cordis'] })
  assert.deepEqual(creator.tools, ['clone_check', 'clone_close'])
  assert.deepEqual(creator.commands.map(c => c.name), ['clone-check', 'clone-close'])
  assert.equal(creator.sections.length, 1)
  assert.match(creator.sections[0].text(), /clone_check/)
  assert.deepEqual(std.tools, [])
  assert.deepEqual(std.commands, [])

  const late = fakeAgent('cordis')
  ctx.agents.list().push(late)
  await ctx.emit('agent/created', { agent: late })
  assert.deepEqual(late.tools, ['clone_check', 'clone_close'])
  assert.deepEqual(late.commands.map(c => c.name), ['clone-check', 'clone-close'])

  std.preset = 'cordis'
  await ctx.emit('tools/change')
  assert.deepEqual(std.tools, ['clone_check', 'clone_close'])
  assert.deepEqual(std.commands.map(c => c.name), ['clone-check', 'clone-close'])
  creator.preset = 'standard'
  await ctx.emit('tools/change')
  // 每个 agent 两条 fiber（tools+systemPrompt / commands），dispose 计两次
  assert.equal(creator.disposed, 2)

  await ctx.emit('agent/disposed', { agent: late })
  assert.equal(late.disposed, 2)
  await ctx.effects[0]()
  assert.equal(std.disposed, 2)

  assert.throws(() => normalizeConfig({ presets: 'cordis' }), /presets/)
})

test('clone-grant / clone-revoke：给非目标预设临时注入工具，收回后清空', async () => {
  const { apply } = await loadPlugin()
  const std = fakeAgent('standard')
  const creator = fakeAgent('cordis')
  const ctx = fakeCtx([std, creator])
  apply(ctx, { presets: ['cordis'] })

  // 全局可见的两条授权指令
  assert.deepEqual(ctx.commands.map(c => c.name), ['clone-grant', 'clone-revoke'])
  const grant = ctx.commands.find(c => c.name === 'clone-grant')
  const revoke = ctx.commands.find(c => c.name === 'clone-revoke')
  const signal = new AbortController().signal

  assert.deepEqual(std.tools, [])
  const r1 = await grant.handler({ agent: { id: std.id }, rawInput: '', signal })
  assert.equal(r1.kind, 'success')
  assert.deepEqual(std.tools, ['clone_check', 'clone_close'])
  assert.deepEqual(std.commands.map(c => c.name), ['clone-check', 'clone-close'])
  assert.equal(std.sections.length, 1)
  assert.match(std.sections[0].text(), /clone_check/)

  const again = await grant.handler({ agent: { id: std.id }, rawInput: '', signal })
  assert.match(again.text, /已经注入过/)
  // 目标预设自带工具，不需要注入
  const noop = await grant.handler({ agent: { id: creator.id }, rawInput: '', signal })
  assert.match(noop.text, /无需注入/)

  const r2 = await revoke.handler({ agent: { id: std.id }, rawInput: '', signal })
  assert.equal(r2.kind, 'success')
  assert.deepEqual(std.tools, [])
  assert.equal(std.sections.length, 0)

  // 再授权一次，agent 销毁时应自动回收（2 条 fiber）
  await grant.handler({ agent: { id: std.id }, rawInput: '', signal })
  await ctx.emit('agent/disposed', { agent: std })
  assert.deepEqual(std.tools, [])
  assert.equal(std.disposed, 4)
})

test('clone_check 的 mode 校验、clone_close 与斜杠指令处理器', async () => {
  const { apply } = await loadPlugin()
  const a = fakeAgent('cordis')
  let check, close
  const commands = []
  a.ctx.inject = (_d, cb) => {
    cb({
      tools: { register: t => { if (t.name === 'clone_check') check = t; else close = t } },
      systemPrompt: { section() {} },
      commands: { register: c => commands.push(c) },
    })
    return { dispose: async () => {} }
  }
  apply(fakeCtx([a]), {})
  await assert.rejects(check.execute({ mode: 'weird' }, {}), /mode/)
  const r = await close.execute({ id: 'all' })
  assert.deepEqual(r.closed, [])
  assert.match(close.output.render({}, r)[0].text, /No matching/)

  const signal = new AbortController().signal
  const checkCmd = commands.find(c => c.name === 'clone-check')
  const closeCmd = commands.find(c => c.name === 'clone-close')
  assert.ok(checkCmd && closeCmd, JSON.stringify(commands.map(c => c.name)))
  const usage = await checkCmd.handler({ rawInput: '', signal })
  assert.equal(usage.kind, 'error')
  assert.match(usage.text, /用法/)
  const tooMany = await checkCmd.handler({ rawInput: 'a b', signal })
  assert.equal(tooMany.kind, 'error')
  assert.match(tooMany.text, /用法/)
  const noClone = await closeCmd.handler({ rawInput: 'all', signal })
  assert.equal(noClone.kind, 'success')
  assert.match(noClone.text, /No matching clone/)
})
