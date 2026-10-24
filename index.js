// 创造模式增强（Creator Mode Plus）· Host 插件
// 只给使用指定预设（默认 cordis）的 agent 注册 clone_check / clone_close 和一段提醒；其他预设零成本。
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDshCommand, findBrowser } from './lib/locate.js'
import { runClone, redactUrl } from './lib/clone.js'
import { REMINDER, CHECK_DESCRIPTION, CLOSE_DESCRIPTION } from './lib/prompt.js'

export const name = 'dsh-creator-plus'
export const inject = ['agents', 'agentPresets']

const DEFAULTS = {
  presets: ['cordis'],
  dshCommand: undefined, // 例如 ["C:/.../dsh.cmd"]；默认自动解析
  browserPath: undefined,
  browserArgs: [],
  startTimeoutSeconds: 120,
  loadTimeoutSeconds: 60,
  settleSeconds: 5,
  keepAliveMinutes: 30,
  ignoreErrors: [],
  artifactsDir: undefined,
  sectionOrder: 9000,
}

// 不 import @deepseek-ai/dsh-tools：外部插件以 link/Release 安装时解析不到宿主的包（真机实测 ERR_MODULE_NOT_FOUND）。
// 直接给 ctx.tools.register 一个已编译的定义：参数用 JSON Schema，返回值转成无损 JSON（去掉 undefined，宿主会拒收含 undefined 的值）。
export function toLossless(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value))
}

export function defineTool({ parameters, execute, output, ...rest }) {
  const properties = {}
  const required = []
  for (const [k, { required: req, ...v }] of Object.entries(parameters || {})) {
    properties[k] = v
    if (req === true) required.push(k)
  }
  const schema = { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) }
  return {
    ...rest,
    parameters: schema,
    output: { ...output, schema: { type: 'object', additionalProperties: true } },
    async execute(args, exec) {
      const a = args || {}
      for (const k of required) if (a[k] === undefined || a[k] === null) throw new Error(`缺少参数 ${k}`)
      for (const [k, v] of Object.entries(a)) {
        const spec = properties[k]
        if (!spec) throw new Error(`未知参数 ${k}`)
        if (v !== undefined && v !== null && typeof v !== spec.type) throw new Error(`参数 ${k} 应为 ${spec.type}`)
      }
      return toLossless(await execute(a, exec))
    },
  }
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULTS, ...(raw || {}) }
  if (!Array.isArray(c.presets) || c.presets.some(p => typeof p !== 'string')) throw new Error('dsh-creator-plus: presets 必须是字符串数组')
  if (c.dshCommand !== undefined && (!Array.isArray(c.dshCommand) || c.dshCommand.length === 0)) throw new Error('dsh-creator-plus: dshCommand 必须是非空字符串数组')
  for (const k of ['startTimeoutSeconds', 'loadTimeoutSeconds', 'settleSeconds', 'keepAliveMinutes']) {
    if (typeof c[k] !== 'number' || !(c[k] >= 0)) throw new Error(`dsh-creator-plus: ${k} 必须是非负数字`)
  }
  return c
}

function renderCheck(v) {
  const lines = []
  lines.push(`${v.ok ? 'PASS' : 'FAIL'} · clone ${v.id} · mode ${v.mode} · ${Math.round((v.ms || 0) / 1000)}s · dsh via ${v.dshSource}`)
  if (v.error) lines.push(`Error: ${v.error}`)
  if (v.verdict?.reasons?.length) lines.push(`Reasons: ${v.verdict.reasons.join('; ')}`)
  for (const s of v.steps || []) lines.push(`- ${s.ok ? 'ok' : 'FAILED'} ${s.name} (${s.ms}ms)${s.detail && !s.ok ? `: ${s.detail}` : ''}${s.stderr ? `\n  stderr: ${s.stderr.slice(-1500)}` : ''}`)
  if (v.page?.errors?.length) {
    lines.push('Page errors:')
    for (const e of v.page.errors.slice(0, 20)) lines.push(`  ${e}`)
    if (v.page.errors.length > 20) lines.push(`  … ${v.page.errors.length - 20} more`)
  }
  if (v.page?.probe) lines.push(`Page: title=${JSON.stringify(v.page.probe.title)} textLength=${v.page.probe.textLength} rootChildren=${v.page.probe.rootChildren}`)
  if (v.screenshot) lines.push(`Screenshot: ${v.screenshot} (view with read_image)`)
  if (v.visualVerified === false) lines.push('Visual check: NOT performed (no headless browser).')
  if (v.viewUrl) lines.push(`Clone kept alive until clone_close or ${v.expiresAt}. viewUrl (give to the user as a link): ${v.viewUrl}`)
  for (const n of v.notes || []) lines.push(`Note: ${n}`)
  if (v.serverLog && !v.ok) lines.push(`Clone log tail:\n${v.serverLog.slice(-3000)}`)
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const kept = new Map() // id -> { close, timer, expiresAt }
  const artifactsDir = config.artifactsDir || join(tmpdir(), 'dsh-creator-plus', 'shots')

  async function closeClone(id) {
    const entry = kept.get(id)
    if (!entry) return false
    kept.delete(id)
    clearTimeout(entry.timer)
    await entry.close().catch(err => ctx.logger?.warn?.(`dsh-creator-plus: close ${id} failed: ${err?.message ?? err}`))
    return true
  }

  const checkTool = defineTool({
    name: 'clone_check',
    description: CHECK_DESCRIPTION,
    timeoutMs: 15 * 60 * 1000,
    parameters: {
      packageDir: { type: 'string', description: 'Absolute directory of the bundle under test (its package.json declares dsh.bundle.patch). Omit to check the clone baseline only.' },
      mode: { type: 'string', description: '"clean" (default): fresh shipped web profile. "copy": copy of the current profile, its installed plugins and the home-level patch, to reproduce conflicts.' },
      keepAlive: { type: 'boolean', description: 'Keep the clone running after the check so the user can open viewUrl; close it with clone_close.' },
      expectText: { type: 'string', description: 'Text that must appear on the page, e.g. a label your plugin renders.' },
      expectSelector: { type: 'string', description: 'CSS selector that must match, e.g. an element your plugin renders.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderCheck(value) }],
    },
    async execute(args, exec) {
      const mode = args.mode === undefined || args.mode === '' ? 'clean' : args.mode
      if (mode !== 'clean' && mode !== 'copy') throw new Error('mode 只能是 "clean" 或 "copy"')
      const dsh = resolveDshCommand({ override: config.dshCommand })
      const browser = findBrowser({ override: config.browserPath })
      const r = await runClone({
        dsh,
        browser,
        browserArgs: config.browserArgs,
        packageDir: args.packageDir || undefined,
        mode,
        keepAlive: args.keepAlive === true,
        expectText: args.expectText || undefined,
        expectSelector: args.expectSelector || undefined,
        startTimeoutMs: config.startTimeoutSeconds * 1000,
        loadTimeoutMs: config.loadTimeoutSeconds * 1000,
        settleMs: config.settleSeconds * 1000,
        ignoreErrors: config.ignoreErrors,
        artifactsDir,
        sourceProfileDir: process.env.DSH_PROFILE_DIR,
        sourceHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
        signal: exec?.signal,
      })
      let expiresAt
      if (r.kept) {
        const ms = config.keepAliveMinutes * 60 * 1000
        expiresAt = new Date(Date.now() + ms).toISOString()
        const timer = setTimeout(() => { void closeClone(r.id) }, ms)
        timer.unref?.()
        kept.set(r.id, { close: r.close, timer, expiresAt })
      }
      // 只返回可序列化字段
      return {
        id: r.id,
        ok: r.ok,
        mode: r.mode,
        ms: r.ms,
        dshSource: r.dshSource,
        error: r.error,
        verdict: r.verdict,
        visualVerified: r.visualVerified,
        steps: r.steps,
        page: r.page ? { loaded: r.page.loaded, crashed: r.page.crashed, navError: r.page.navError, errors: r.page.errors, probe: r.page.probe } : undefined,
        screenshot: r.page?.screenshot || undefined,
        http: r.http,
        notes: r.notes,
        serverLog: r.ok ? undefined : r.serverLog,
        viewUrl: r.kept ? r.viewUrl : undefined,
        viewUrlRedacted: r.kept ? redactUrl(r.viewUrl) : undefined,
        expiresAt,
      }
    },
  })

  const closeTool = defineTool({
    name: 'clone_close',
    description: CLOSE_DESCRIPTION,
    parameters: {
      id: { type: 'string', required: true, description: 'Clone id from clone_check, or "all".' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.closed.length ? `Closed: ${value.closed.join(', ')}` : 'No matching clone is running.' }],
    },
    async execute(args) {
      const ids = args.id === 'all' ? [...kept.keys()] : [args.id]
      const closed = []
      for (const id of ids) if (await closeClone(id)) closed.push(id)
      return { closed }
    },
  })

  // ---- 按 agent 安装 ----
  const installs = new Map() // agent -> fiber
  const presetOf = agent => {
    try { return ctx.agentPresets?.composedPreset(agent.ctx) } catch { return undefined }
  }
  const wants = agent => config.presets.includes(presetOf(agent))

  const sync = agent => {
    const has = installs.has(agent)
    if (wants(agent) && !has) {
      const fiber = agent.ctx.inject(['systemPrompt', 'tools'], scope => {
        scope.tools.register(checkTool)
        scope.tools.register(closeTool)
        scope.systemPrompt.section({
          name: 'dsh-creator-plus:clone-check',
          order: config.sectionOrder,
          interpolate: false,
          text: () => (wants(agent) ? REMINDER : ''),
        })
      })
      installs.set(agent, fiber)
    } else if (!wants(agent) && has) {
      const fiber = installs.get(agent)
      installs.delete(agent)
      fiber.dispose().catch(err => ctx.logger?.warn?.(`dsh-creator-plus: uninstall failed: ${err?.message ?? err}`))
    }
  }

  for (const agent of ctx.agents.list()) sync(agent)
  ctx.on('agent/created', ({ agent }) => { sync(agent) })
  // 空白会话切换预设时注册表会发 tools/change；据此增删。
  ctx.on('tools/change', () => { for (const agent of ctx.agents.list()) sync(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const fiber = installs.get(agent)
    if (!fiber) return
    installs.delete(agent)
    fiber.dispose().catch(() => {})
  })

  ctx.effect(() => async () => {
    const fibers = [...installs.values()]
    installs.clear()
    await Promise.all(fibers.map(f => f.dispose().catch(() => {})))
    await Promise.all([...kept.keys()].map(id => closeClone(id)))
  }, 'dsh-creator-plus: clones')
}
