// 分身生命周期：临时 DSH_HOME → 建 profile（纯净/复制）→ 装待测插件 → 启动 web → 无头检查 → 清理或保留。
// 不依赖任何 DSH 包，只靠 dsh CLI，因此 Web/CLI 与桌面版共用。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, cp, readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, basename } from 'node:path'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { launchBrowser, Cdp, checkPage, hasWebSocket, tail, sleep } from './cdp.js'

export const CLONE_PROFILE = 'clone'
const URL_LINE_RE = /dsh web:\s*(https?:\/\/\S+)/
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
/** 子进程不应继承本体的这些变量，否则分身会指回本体。 */
const STRIP_ENV = ['DSH_HOME', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']

/** 从启动输出里取出 `dsh web:` 行的 URL（带一次性 token）。 */
export function parseUrlLine(text) {
  const m = URL_LINE_RE.exec(String(text).replace(ANSI_RE, ''))
  return m ? m[1] : undefined
}

/** 去掉 URL 中的凭据参数，用于对外展示。 */
export function redactUrl(url) {
  try {
    const u = new URL(url)
    for (const k of [...u.searchParams.keys()]) if (/token|auth|key|secret/i.test(k)) u.searchParams.set(k, '***')
    return u.toString()
  } catch { return url }
}

/** 复制模式下，过滤掉 CLI 无法启动的桌面专属 bundle。 */
export function filterBundlesForClone(bundles) {
  if (!Array.isArray(bundles)) return { kept: [], dropped: [] }
  const kept = []
  const dropped = []
  for (const b of bundles) (/desktop/i.test(String(b)) ? dropped : kept).push(b)
  return { kept, dropped }
}

export function childEnv(base, home, extra = {}) {
  const env = { ...base }
  for (const k of STRIP_ENV) delete env[k]
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, DSH_HOME: home, ...extra }
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function spawnDsh(dsh, args, env, { detached = false } = {}) {
  return spawn(dsh.command, [...dsh.args, ...args], {
    env,
    shell: dsh.shell,
    windowsHide: true,
    detached: detached && process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 跑一条一次性 dsh 命令，返回退出码与输出尾部。 */
export function runOnce(dsh, args, env, { timeoutMs = 180000, signal } = {}) {
  return new Promise(resolve => {
    const proc = spawnDsh(dsh, args, env)
    let out = ''
    let err = ''
    proc.stdout.setEncoding('utf8').on('data', d => { out += d })
    proc.stderr.setEncoding('utf8').on('data', d => { err += d })
    const timer = setTimeout(() => { void killTree(proc); resolve({ code: null, timedOut: true, stdout: tail(out), stderr: tail(err) }) }, timeoutMs)
    const onAbort = () => { void killTree(proc) }
    signal?.addEventListener('abort', onAbort, { once: true })
    proc.on('error', e => { clearTimeout(timer); resolve({ code: null, error: e.message, stdout: tail(out), stderr: tail(err) }) })
    proc.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: tail(out), stderr: tail(err) })
    })
  })
}

/** 后台启动分身 web，等到 `dsh web:` 行（Loader 结算并通过 required 启动检查后才打印）。 */
export function startServer(dsh, port, env, { timeoutMs = 120000, signal } = {}) {
  const proc = spawnDsh(dsh, [CLONE_PROFILE, '--no-open', '--port', String(port)], env, { detached: true })
  const log = { out: '', err: '' }
  proc.stdout.setEncoding('utf8').on('data', d => { log.out = tail(log.out + d, 20000) })
  proc.stderr.setEncoding('utf8').on('data', d => { log.err = tail(log.err + d, 20000) })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`分身 ${Math.round(timeoutMs / 1000)}s 内没有打印 dsh web: 行`)), timeoutMs)
    const onAbort = () => finish(reject, new Error('已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })
    const onData = () => {
      const url = parseUrlLine(log.out) || parseUrlLine(log.err)
      if (url) finish(resolve, url)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('error', e => finish(reject, e))
    proc.on('exit', code => finish(reject, new Error(`分身进程在就绪前退出（code ${code}）`)))
    function finish(fn, v) {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      proc.stdout.off('data', onData)
      proc.stderr.off('data', onData)
      proc.removeAllListeners('exit')
      fn(v)
    }
  })
  return { proc, log, ready }
}

export async function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise(resolve => {
    const hard = setTimeout(() => {
      try { process.platform !== 'win32' && proc.pid ? process.kill(-proc.pid, 'SIGKILL') : proc.kill('SIGKILL') } catch { /* */ }
      resolve()
    }, 8000)
    proc.once('exit', () => { clearTimeout(hard); resolve() })
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') }
      }
    } catch { clearTimeout(hard); resolve() }
  })
}

async function copyCurrentProfile({ sourceProfileDir, sourceHome, home, notes }) {
  if (!sourceProfileDir || !existsSync(sourceProfileDir)) {
    throw new Error('复制模式需要当前 profile 目录（DSH_PROFILE_DIR），本体不是以 profile 启动的，无法复制')
  }
  const target = join(home, 'profiles', CLONE_PROFILE)
  await mkdir(join(home, 'profiles'), { recursive: true })
  await cp(sourceProfileDir, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: src => !/[\\/]\.[^\\/]*\.staging-[^\\/]*$/.test(src) && !/cordis\.patch\.yml\.bak-/.test(basename(src)),
  })
  const pkgPath = join(target, 'package.json')
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    const { kept, dropped } = filterBundlesForClone(bundles)
    if (dropped.length) {
      pkg.dsh.profile.bundles = kept
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2))
      notes.push(`复制模式：去掉了 CLI 无法启动的桌面专属 bundle：${dropped.join(', ')}`)
    }
  }
  const homePatch = sourceHome && join(sourceHome, 'cordis.patch.yml')
  if (homePatch && existsSync(homePatch)) {
    await cp(homePatch, join(home, 'cordis.patch.yml'))
    notes.push('复制模式：同时复制了 home 级 cordis.patch.yml')
  }
  if (process.platform === 'win32') {
    notes.push('复制模式（Windows）：node_modules 里的 junction 可能仍指向本体 profile；若怀疑依赖问题，用纯净模式对照')
  }
}

/**
 * 跑一次分身检查。
 * @param {object} o
 * @param {{command:string,args:string[],env:object,shell:boolean,source:string}} o.dsh
 * @param {string} [o.packageDir] 待测 bundle 的绝对目录；省略则只检查基线
 * @param {'clean'|'copy'} [o.mode]
 * @param {string|undefined} o.browser 浏览器可执行文件；undefined 时降级为 HTTP 检查
 */
export async function runClone(o) {
  const t0 = Date.now()
  const steps = []
  const notes = []
  const mode = o.mode === 'copy' ? 'copy' : 'clean'
  const step = async (name, fn) => {
    const s = Date.now()
    try {
      const detail = await fn()
      steps.push({ name, ok: true, ms: Date.now() - s, ...(detail ? { detail } : {}) })
      return detail
    } catch (e) {
      steps.push({ name, ok: false, ms: Date.now() - s, detail: e.message, ...(e.stderr ? { stderr: e.stderr } : {}) })
      throw e
    }
  }

  if (o.packageDir && !isAbsolute(o.packageDir)) throw new Error('packageDir 必须是绝对路径')
  if (o.packageDir) {
    const st = await stat(o.packageDir).catch(() => null)
    if (!st?.isDirectory() || !existsSync(join(o.packageDir, 'package.json'))) throw new Error(`packageDir 不是含 package.json 的目录：${o.packageDir}`)
  }

  const root = await mkdtemp(join(o.tmpRoot || tmpdir(), 'dsh-clone-'))
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const env = childEnv(o.baseEnv || process.env, home, o.dsh.env)
  const id = `clone-${randomBytes(3).toString('hex')}`
  let server
  let browser
  let cdp
  let result = { id, ok: false, mode, dshSource: o.dsh.source, steps, notes }

  const cleanup = async () => {
    cdp?.close()
    await browser?.close().catch(() => {})
    await killTree(server?.proc)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {
      notes.push(`临时目录未能删除：${root}`)
    })
  }

  try {
    if (mode === 'copy') {
      await step('复制当前 profile', () => copyCurrentProfile({ sourceProfileDir: o.sourceProfileDir, sourceHome: o.sourceHome, home, notes }))
    } else {
      await step('建立纯净 profile', async () => {
        const r = await runOnce(o.dsh, [CLONE_PROFILE, '--from-default-profile', 'web', '--dump-config'], env, { timeoutMs: 120000, signal: o.signal })
        if (r.code !== 0) throw Object.assign(new Error(`dsh --from-default-profile 失败（code ${r.code}）${r.error ? `：${r.error}` : ''}`), { stderr: r.stderr })
      })
    }
    if (o.packageDir) {
      await step('装入待测插件', async () => {
        const r = await runOnce(o.dsh, ['plugin', '--profile', CLONE_PROFILE, 'add', o.packageDir], env, { timeoutMs: o.installTimeoutMs || 300000, signal: o.signal })
        if (r.code !== 0) throw Object.assign(new Error(`dsh plugin add 失败（code ${r.code}）`), { stderr: r.stderr || r.stdout })
        if (/plain dependency|not a profile layer/i.test(r.stdout + r.stderr)) {
          notes.push('待测包没有声明 dsh.bundle.patch，只被装成普通依赖，不会真正装配')
        }
      })
    }
    const port = await freePort()
    let url
    await step('启动分身 web', async () => {
      server = startServer(o.dsh, port, env, { timeoutMs: o.startTimeoutMs || 120000, signal: o.signal })
      try {
        url = await server.ready
      } catch (e) {
        await sleep(300)
        throw Object.assign(e, { stderr: tail(server.log.err || server.log.out) })
      }
      return { url: redactUrl(url) }
    })

    if (o.browser && hasWebSocket()) {
      await step('无头浏览器检查', async () => {
        browser = await launchBrowser(o.browser, { userDataDir: join(root, 'browser'), extraArgs: o.browserArgs, signal: o.signal })
        cdp = new Cdp(browser.wsEndpoint)
        await cdp.open()
        const shotPath = o.artifactsDir ? join(o.artifactsDir, `${id}.png`) : undefined
        const page = await checkPage(cdp, url, {
          loadTimeoutMs: o.loadTimeoutMs, settleMs: o.settleMs,
          expectText: o.expectText, expectSelector: o.expectSelector,
          screenshotPath: shotPath, signal: o.signal,
        })
        result.page = { ...page, errors: filterIgnored(page.errors, o.ignoreErrors) }
        return { loaded: page.loaded, errors: result.page.errors.length }
      })
      result.verdict = judge(result.page)
      result.visualVerified = true
    } else {
      await step('HTTP 降级检查', async () => {
        const { res, body } = await fetchWithCookies(url, o.signal)
        const hasScript = /<script[\s>]/i.test(body)
        result.http = { status: res.status, hasScript }
        if (!res.ok || !hasScript) throw new Error(`首页返回 ${res.status}${hasScript ? '' : '，且没有 script'}`)
      })
      result.verdict = { ok: true, reasons: [] }
      result.visualVerified = false
      notes.push(o.browser ? '运行时没有全局 WebSocket，未做浏览器检查' : '没找到 Edge/Chrome/Chromium，只验证了后端就绪和首页可取；前端运行时报错未检查（可在配置 browserPath 指定浏览器）')
    }
    result.ok = result.verdict.ok
    if (o.keepAlive) {
      result.kept = true
      result.viewUrl = url
      result.close = cleanup
      result.root = root
    }
    return result
  } catch (e) {
    result.ok = false
    result.error = e.message
    if (server?.log) result.serverLog = tail(`${server.log.out}\n${server.log.err}`.trim(), 6000)
    return result
  } finally {
    result.ms = Date.now() - t0
    if (!result.kept) await cleanup()
  }
}

/** 带 cookie 跟随重定向：启动 URL 先用 token 换 cookie 再 302，原生 fetch 不会带上 cookie。 */
export async function fetchWithCookies(url, signal, maxHops = 5) {
  const jar = new Map()
  let current = url
  for (let i = 0; i <= maxHops; i++) {
    const headers = jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}
    const res = await fetch(current, { redirect: 'manual', headers, signal })
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const c of setCookies) {
      const [pair] = c.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {})
      current = new URL(loc, current).toString()
      continue
    }
    return { res, body: await res.text() }
  }
  throw new Error('重定向次数过多')
}

export function filterIgnored(errors, patterns) {
  if (!patterns?.length) return errors
  const res = patterns.map(p => { try { return new RegExp(p, 'i') } catch { return null } }).filter(Boolean)
  return errors.filter(e => !res.some(r => r.test(e)))
}

/** 判定前端是否「正常启动」。 */
export function judge(page) {
  const reasons = []
  if (!page) return { ok: false, reasons: ['没有页面结果'] }
  if (page.navError) reasons.push(`导航失败：${page.navError}`)
  if (page.crashed) reasons.push('渲染进程崩溃')
  if (page.navigated && !page.loaded) reasons.push('load 事件超时')
  if (page.errors?.length) reasons.push(`${page.errors.length} 条运行时报错`)
  const p = page.probe
  if (p) {
    if (p.textLength === 0 && p.rootChildren === 0) reasons.push('页面是空白的（根节点没有渲染内容）')
    if (p.expectTextFound === false) reasons.push('没找到期望文字')
    if (p.expectSelectorFound === false) reasons.push('没找到期望元素')
  } else if (!page.crashed && !page.navError) {
    reasons.push('无法读取页面状态')
  }
  return { ok: reasons.length === 0, reasons }
}
