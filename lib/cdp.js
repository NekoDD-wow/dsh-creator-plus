// 零依赖的无头浏览器检查：启动系统 Chromium 系浏览器（Edge/Chrome/Chromium），通过 CDP 打开页面、
// 收集报错、读页面状态并截图。需要全局 WebSocket（Node 22+ / 现代 Electron 自带）。
import { spawn } from 'node:child_process'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export function hasWebSocket() {
  return typeof globalThis.WebSocket === 'function'
}

/**
 * 启动无头浏览器，等待 "DevTools listening on ws://..."。
 * @returns {Promise<{wsEndpoint: string, proc: import('node:child_process').ChildProcess, close: () => Promise<void>}>}
 */
export function launchBrowser(executable, { userDataDir, extraArgs = [], timeoutMs = 30000, signal } = {}) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1400,900',
    ...extraArgs,
    'about:blank',
  ]
  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  const close = () => killQuietly(proc)
  return new Promise((resolve, reject) => {
    let stderr = ''
    const timer = setTimeout(() => fail(new Error(`浏览器 ${timeoutMs}ms 内未就绪`)), timeoutMs)
    const onAbort = () => fail(new Error('已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    function fail(err) {
      done()
      void close()
      reject(Object.assign(err, { stderr: tail(stderr) }))
    }
    proc.on('error', fail)
    proc.on('exit', code => fail(new Error(`浏览器提前退出（code ${code}）：${tail(stderr)}`)))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', chunk => {
      stderr += chunk
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (m) {
        done()
        proc.removeAllListeners('exit')
        resolve({ wsEndpoint: m[1], proc, close })
      }
    })
  })
}

/** 极简 CDP 连接，使用 flatten 会话。 */
export class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
  }

  open(timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
      ws.addEventListener('close', () => {
        for (const { reject: rj } of this.pending.values()) rj(new Error('CDP 连接已关闭'))
        this.pending.clear()
      })
      ws.addEventListener('message', ev => {
        let msg
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
          else p.resolve(msg.result ?? {})
          return
        }
        if (msg.method) for (const fn of this.listeners) fn(msg)
      })
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify(payload))
    })
  }

  onEvent(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    try { this.ws?.close() } catch { /* ignore */ }
  }
}

const PROBE = (expectText, expectSelector) => `(() => {
  const root = document.querySelector('#root, #app, [data-dsh-root]')
  const text = (document.body && document.body.innerText || '').trim()
  return JSON.stringify({
    href: location.href,
    title: document.title,
    readyState: document.readyState,
    textLength: text.length,
    rootFound: !!root,
    rootChildren: root ? root.childElementCount : (document.body ? document.body.childElementCount : 0),
    expectTextFound: ${expectText ? `text.includes(${JSON.stringify(expectText)})` : 'null'},
    expectSelectorFound: ${expectSelector ? `!!document.querySelector(${JSON.stringify(expectSelector)})` : 'null'},
  })
})()`

const DISMISS_NOTICE_JS = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const visible = el => {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
  }
  const NOTICE_TEXT = /预览版说明|预览版|Preview notice|Early Access|Welcome/i
  const ACTION = /^(继续|继续使用|我知道了|知道了|开始使用|Continue|Got it|OK|I understand)$/i
  const ONBOARDING_TEXT = /开始使用|Get started|Add API Key|添加 API Key|登录 DeepSeek/i
  const CLOSE = /^(关闭|关闭对话框|Close|Dismiss|×|✕|X)$/i
  const clicked = []
  const pickNotice = dialog => {
    if (NOTICE_TEXT.test(dialog.innerText || '')) {
      const button = [...dialog.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(b => ACTION.test((b.innerText || '').trim()))
      if (button) return button
    }
    // 未登录时的「开始使用 / 添加 API Key」引导：不点“登录/添加”，只点右上角关闭。
    if (ONBOARDING_TEXT.test(dialog.innerText || '')) {
      const close = [...dialog.querySelectorAll('button, [role="button"]')]
        .filter(visible)
        .find(b => {
          const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.innerText || '').trim()
          return CLOSE.test(label)
        })
      if (close) return close
    }
    return null
  }
  for (let round = 0; round < 4; round++) {
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')].filter(visible)
    let hit = null
    for (const dialog of dialogs) {
      hit = pickNotice(dialog)
      if (hit) break
    }
    if (!hit) break
    const label = (hit.getAttribute('aria-label') || hit.innerText || '').trim().slice(0, 20) || '关闭'
    clicked.push(label)
    hit.click()
    await sleep(350)
  }
  return clicked
})()`

/**
 * 自动点掉 clone 首页的「预览版说明」弹窗（以及同类的欢迎/预览弹窗）。
 * 只在 dialog 文本命中欢迎/预览关键词、且按钮文案是「继续/Continue」时才点，
 * 避免误关真正的错误弹窗。返回已点击的按钮文案数组。
 */
export async function dismissWelcomeNotices(cdp, sessionId) {
  try {
    const r = await cdp.send('Runtime.evaluate', { expression: DISMISS_NOTICE_JS, awaitPromise: true, returnByValue: true }, sessionId)
    return Array.isArray(r.result?.value) ? r.result.value : []
  } catch {
    return []
  }
}

/**
 * 在 settle 窗口内反复检查并点掉「预览版说明」类弹窗。
 * 弹窗可能比 load 晚出现（要等客户端设置加载完），所以不能只在 load 后点一次。
 */
export async function dismissDuringSettle(cdp, sessionId, settleMs) {
  const clicked = []
  const deadline = Date.now() + Math.max(Number(settleMs) || 0, 800)
  let quiet = 0
  while (Date.now() < deadline) {
    const got = await dismissWelcomeNotices(cdp, sessionId)
    if (got.length) { clicked.push(...got); quiet = 0 } else quiet++
    // 已经点掉且连续两次没有新弹窗，就不用把 settle 时间耗完。
    if (clicked.length && quiet >= 2) break
    await sleep(250)
  }
  return clicked
}

/**
 * 打开 url 并检查。
 * @returns {Promise<{navigated: boolean, loaded: boolean, crashed: boolean, errors: string[], probe: object|null, screenshot: string|null, dismissed: string[], navError?: string}>}
 */
export async function checkPage(cdp, url, {
  loadTimeoutMs = 60000,
  settleMs = 5000,
  expectText,
  expectSelector,
  screenshotPath,
  signal,
} = {}) {
  const errors = []
  let crashed = false
  let loaded = false
  let loadResolve
  const loadPromise = new Promise(r => { loadResolve = r })
  let dismissed = []

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  const off = cdp.onEvent(msg => {
    if (msg.sessionId !== sessionId) return
    const p = msg.params || {}
    switch (msg.method) {
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails || {}
        errors.push(`[pageerror] ${d.exception?.description || d.text || 'unknown'}`.slice(0, 2000))
        break
      }
      case 'Runtime.consoleAPICalled':
        if (p.type === 'error' || p.type === 'assert') {
          const text = (p.args || []).map(a => a.value ?? a.description ?? a.type).join(' ')
          errors.push(`[console.${p.type}] ${text}`.slice(0, 2000))
        }
        break
      case 'Log.entryAdded':
        if (p.entry?.level === 'error') errors.push(`[log] ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ''}`.slice(0, 2000))
        break
      case 'Page.loadEventFired':
        loaded = true
        loadResolve()
        break
      case 'Inspector.targetCrashed':
        crashed = true
        loadResolve()
        break
    }
  })
  try {
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Log.enable', {}, sessionId)
    await cdp.send('Inspector.enable', {}, sessionId).catch(() => {})
    const nav = await cdp.send('Page.navigate', { url }, sessionId)
    if (nav.errorText) {
      return { navigated: false, loaded: false, crashed, errors, probe: null, screenshot: null, dismissed: [], navError: nav.errorText }
    }
    await raceAbort(Promise.race([loadPromise, sleep(loadTimeoutMs)]), signal)
    // 首启「预览版说明」这类弹窗是客户端设置加载后才渲染的：在 settle 窗口内持续尝试点掉，
    // 既当 settle 等待、又不会让截图被弹窗挡住。
    if (!crashed) dismissed = await dismissDuringSettle(cdp, sessionId, settleMs)
    let probe = null
    if (!crashed) {
      const r = await cdp.send('Runtime.evaluate', { expression: PROBE(expectText, expectSelector), returnByValue: true }, sessionId)
      try { probe = JSON.parse(r.result?.value) } catch { probe = null }
    }
    let screenshot = null
    if (screenshotPath && !crashed) {
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
        await mkdir(dirname(screenshotPath), { recursive: true })
        await writeFile(screenshotPath, Buffer.from(shot.data, 'base64'))
        screenshot = screenshotPath
      } catch { /* 截图失败不影响判定 */ }
    }
    return { navigated: true, loaded, crashed, errors, probe, screenshot, dismissed }
  } finally {
    off()
    await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

function raceAbort(promise, signal) {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('已取消'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('已取消'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(v => { signal.removeEventListener('abort', onAbort); resolve(v) },
      e => { signal.removeEventListener('abort', onAbort); reject(e) })
  })
}

export function tail(s, n = 4000) {
  return s.length > n ? `…${s.slice(-n)}` : s
}

export async function killQuietly(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise(resolve => {
    const t = setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* */ } resolve() }, 5000)
    proc.once('exit', () => { clearTimeout(t); resolve() })
    try {
      if (process.platform === 'win32' && proc.pid) {
        spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } else {
        proc.kill('SIGTERM')
      }
    } catch { clearTimeout(t); resolve() }
  })
}
