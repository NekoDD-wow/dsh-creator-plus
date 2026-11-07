#!/usr/bin/env node
// 创造模式工具注册的端到端回归（真机、真 DSH）：
//   copy 模式 clone 当前 profile（含已装的 dsh-creator-plus）→ 打开 clone 的 Web UI →
//   切到「创造模式」→ 发一条消息 → 读 clone home 的会话日志，确认：
//     1) 系统提示里带有插件注入的 REMINDER（"Clone check before touching the live client"）
//     2) 模型请求头的工具列表里真的有 clone_check / clone_close
// 模型轮在 clone 里必然失败（临时 DSH_HOME 没有模型凭据），但系统提示与请求头在调用前就已落盘，
// 所以既能拿到证据，又不消耗额度。
//
// 用法:
//   node scripts/verify-preset.mjs                       # 用当前 DSH_PROFILE_DIR / DSH_HOME
//   node scripts/verify-preset.mjs --profile-dir <dir> --home <dir>
//   node scripts/verify-preset.mjs --keep                # 失败/成功都保留 clone 现场
// 选项:
//   --artifacts <dir>    截图与报告输出目录（默认 <tmp>/dsh-creator-plus/verify-preset）
//   --wait-seconds <n>   发送消息后等会话日志落盘的上限（默认 60）
//
// 退出码: 0 = PASS；1 = FAIL；2 = 环境不满足（没有浏览器 / profile 不存在 / clone 起不来）。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import { runClone } from '../lib/clone.js'
import { launchBrowser, Cdp, sleep } from '../lib/cdp.js'
import { findBrowser, resolveDshCommand } from '../lib/locate.js'

const here = dirname(fileURLToPath(import.meta.url))
const REMINDER_MARK = 'Clone check before touching the live client'
const CREATOR_RE = /^(创造模式|Creator Mode)/
const SEAT_RE = /(模式|Mode)$/

function parseArgs(argv) {
  const o = { keep: false, waitSeconds: 60 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--keep') o.keep = true
    else if (a === '--profile-dir') o.profileDir = argv[++i]
    else if (a === '--home') o.home = argv[++i]
    else if (a === '--artifacts') o.artifacts = argv[++i]
    else if (a === '--wait-seconds') o.waitSeconds = Number(argv[++i]) || 60
    else if (a === '-h' || a === '--help') o.help = true
    else throw new Error(`未知参数：${a}`)
  }
  return o
}

function fail(msg, code = 2) {
  console.error(`FAIL: ${msg}`)
  process.exit(code)
}

/** 遍历 clone home 的 sessions 目录，找 .zstd 会话文件。 */
async function listSessionFiles(root) {
  const dir = join(root, 'home', 'sessions')
  const out = []
  const walk = async d => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name.endsWith('.zstd')) out.push(p)
    }
  }
  if (existsSync(dir)) await walk(dir).catch(() => {})
  return out
}

/** 解析一个会话文件，返回证据字段；写到一半的文件返回 null。 */
async function parseSession(file) {
  let txt
  try { txt = zstdDecompressSync(await readFile(file)).toString('utf8') } catch { return null }
  const events = txt.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (!events.length) return null
  const header = events.find(e => e.type === 'session')
  const systemMessages = events.filter(e => e.type === 'system/message')
  const requests = events.filter(e => e.type === 'request/header')
  const presetEvent = [...events].reverse().find(e => e.type === 'agent-preset/selected')
  const toolNames = []
  for (const r of requests) for (const t of (r.data?.header?.tools || [])) toolNames.push(t.name)
  return {
    file,
    events: events.length,
    turnStarted: events.some(e => e.type === 'turn/start'),
    sessionId: header?.data?.id || header?.id,
    agentPreset: header?.data?.agentPreset,
    presetSelected: presetEvent?.data ?? null,
    systemMessages: systemMessages.length,
    systemHasReminder: systemMessages.some(e => JSON.stringify(e).includes(REMINDER_MARK)),
    requestHeaders: requests.length,
    toolCount: toolNames.length,
    toolsHasCloneCheck: toolNames.includes('clone_check'),
    toolsHasCloneClose: toolNames.includes('clone_close'),
    // 模型轮失败原因（clone 没有凭据时应有 MISSING_CREDENTIAL 之类，仅作记录）
    assistantAttempts: events.filter(e => e.type === 'assistant/attempt').length,
    eventTypes: [...new Set(events.map(e => e.type))],
  }
}

const opt = parseArgs(process.argv.slice(2))
if (opt.help) {
  console.log('node scripts/verify-preset.mjs [--profile-dir <dir>] [--home <dir>] [--artifacts <dir>] [--wait-seconds <n>] [--keep]')
  process.exit(0)
}
const profileDir = resolve(opt.profileDir || process.env.DSH_PROFILE_DIR || '')
const homeDir = resolve(opt.home || process.env.DSH_HOME || '')
if (!opt.profileDir && !process.env.DSH_PROFILE_DIR) fail('没有 --profile-dir，也不在 DSH 会话里（DSH_PROFILE_DIR 未设置）')
if (!existsSync(profileDir)) fail(`profile 目录不存在：${profileDir}`)
const artifacts = opt.artifacts ? resolve(opt.artifacts) : join(tmpdir(), 'dsh-creator-plus', 'verify-preset')
await mkdir(artifacts, { recursive: true })

const dsh = resolveDshCommand()
const browser = findBrowser()
if (!browser) fail('没找到 Edge/Chrome/Chromium，无法驱动 clone 的 Web UI')
console.log(`dsh: ${JSON.stringify(dsh)}`)
console.log(`browser: ${browser}`)
console.log(`source profile: ${profileDir}`)
console.log(`artifacts: ${artifacts}`)

// 1) copy 模式 clone（保留现场），clone 里带着当前 profile 已装的 dsh-creator-plus。
const clone = await runClone({
  dsh, browser, mode: 'copy', keepAlive: true,
  sourceProfileDir: profileDir,
  sourceHome: homeDir || undefined,
  startTimeoutMs: 120000, loadTimeoutMs: 60000, settleMs: 2000,
  artifactsDir: artifacts,
})
console.log(`clone: ok=${clone.ok} ms=${clone.ms} steps=${(clone.steps || []).map(s => `${s.ok ? 'ok' : 'FAILED'}:${s.name}`).join(' | ')}`)
for (const n of clone.notes || []) console.log(`  note: ${n}`)
if (!clone.ok || !clone.kept) {
  console.log(JSON.stringify(clone.verdict || { error: clone.error }, null, 2))
  if (clone.kept) await clone.close?.().catch(() => {})
  fail('clone 没有起来，无法做创造模式 E2E', 2)
}

let br
let cdp
let result = { ok: false, reason: 'not-run', evidence: null, screenshots: [] }
try {
  // 2) 打开 clone 的 Web UI
  br = await launchBrowser(browser, { userDataDir: join(artifacts, 'browser-profile'), timeoutMs: 60000 })
  cdp = new Cdp(br.wsEndpoint)
  await cdp.open()
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  for (const d of ['Page', 'Runtime']) await cdp.send(`${d}.enable`, {}, sessionId)
  await cdp.send('Page.navigate', { url: clone.viewUrl }, sessionId)

  const evalJs = async expression => {
    const x = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (x.exceptionDetails) throw new Error(JSON.stringify(x.exceptionDetails).slice(0, 800))
    return x.result?.value
  }
  const rectOf = js => evalJs(`(() => {
    const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' }
    const el = ${js}
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height, text: (el.innerText || '').trim().slice(0, 60) }
  })()`)
  const clickRect = async r => {
    const x = r.x + r.width / 2, y = r.y + r.height / 2
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId)
  }
  const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    const p = join(artifacts, `${name}.png`)
    await writeFile(p, Buffer.from(data, 'base64'))
    result.screenshots.push(p)
    return p
  }

  // 等前端渲染出预设按钮
  let seat = null
  for (let i = 0; i < 30 && !seat; i++) {
    await sleep(500)
    seat = await rectOf(`[...document.querySelectorAll('button')].filter(vis).find(b => ${SEAT_RE}.test(b.innerText.trim()))`)
  }
  const bodyBefore = String(await evalJs('document.body.innerText.slice(0, 800)')).replace(/\s+/g, ' ')
  if (!seat) {
    await shot('no-preset-seat').catch(() => {})
    result.reason = `clone 页面里没找到预设按钮；页面文本：${bodyBefore}`
    throw new Error(result.reason)
  }
  await shot('0-before')

  // 3) 切到创造模式
  await clickRect(seat)
  await sleep(1500)
  const option = await rectOf(`[...document.querySelectorAll('div,button,li')].filter(vis).filter(el => ${CREATOR_RE}.test((el.innerText||'').trim())).sort((a,b)=>a.innerText.length-b.innerText.length)[0]`)
  if (!option) {
    await shot('no-creator-option').catch(() => {})
    result.reason = '预设菜单里没有「创造模式」选项（clone profile 可能没带 cordis 预设）'
    throw new Error(result.reason)
  }
  await clickRect(option)
  await sleep(2500)
  const seatAfter = await rectOf(`[...document.querySelectorAll('button')].filter(vis).find(b => ${SEAT_RE}.test(b.innerText.trim()))`)
  await shot('1-creator-mode')
  if (!seatAfter || !CREATOR_RE.test(seatAfter.text)) {
    result.reason = `切创造模式失败，按钮文本：${seatAfter?.text}`
    throw new Error(result.reason)
  }

  // 4) 发一条消息，让会话落盘（模型轮会因 clone 没有凭据而失败，不影响证据）
  const sent = await evalJs(`(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const ed = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(vis)[0]
    if (!ed) return { sent: false, reason: 'no-composer' }
    ed.focus()
    document.execCommand('insertText', false, 'ping')
    await sleep(500)
    const send = [...document.querySelectorAll('button')].filter(vis).find(b => b.getAttribute('aria-label') === '发送消息' || String(b.className).includes('primary'))
    if (!send) return { sent: false, reason: 'no-send-button' }
    send.click()
    return { sent: true }
  })()`)
  if (!sent?.sent) {
    await shot('no-send').catch(() => {})
    result.reason = `没发出消息：${sent?.reason}`
    throw new Error(result.reason)
  }
  await sleep(1500)
  await shot('2-sent')

  // 5) 轮询会话日志，等系统提示 + 请求头落盘
  const deadline = Date.now() + opt.waitSeconds * 1000
  let evidence = null
  while (Date.now() < deadline) {
    const files = await listSessionFiles(clone.root)
    const parsed = []
    for (const f of files) {
      const p = await parseSession(f)
      if (p) parsed.push(p)
    }
    evidence = parsed.find(p => p.systemHasReminder && p.toolsHasCloneCheck && p.toolsHasCloneClose) || parsed.find(p => p.systemHasReminder) || parsed[0] || null
    if (evidence && evidence.systemHasReminder && evidence.requestHeaders > 0) break
    await sleep(2000)
  }
  if (!evidence) {
    result.reason = '会话日志里没有找到任何 session（消息没触发一轮）'
    throw new Error(result.reason)
  }
  result.evidence = evidence
  result.ok = Boolean(evidence.systemHasReminder && evidence.toolsHasCloneCheck && evidence.toolsHasCloneClose)
  result.reason = result.ok ? 'ok' : `证据不完整：reminder=${evidence.systemHasReminder} clone_check=${evidence.toolsHasCloneCheck} clone_close=${evidence.toolsHasCloneClose} requestHeaders=${evidence.requestHeaders}`
} catch (e) {
  result.reason = result.reason && result.reason !== 'not-run' ? result.reason : e.message
} finally {
  cdp?.close?.()
  await br?.close?.().catch(() => {})
  if (!opt.keep) await clone.close?.().catch(() => {})
  else console.log(`clone 保留中：${clone.viewUrl}（root: ${clone.root}）`)
}

const report = { time: new Date().toISOString(), dsh, profileDir, cloneId: clone.id, ok: result.ok, reason: result.reason, evidence: result.evidence, screenshots: result.screenshots, cloneNotes: clone.notes }
const reportPath = join(artifacts, `verify-preset-${Date.now()}.json`)
await writeFile(reportPath, JSON.stringify(report, null, 2))

console.log('\n=== evidence ===')
console.log(JSON.stringify(result.evidence, null, 2))
console.log('screenshots: ' + (result.screenshots.join(', ') || '(none)'))
console.log('report: ' + reportPath)
console.log(`\nRESULT ${result.ok ? 'PASS' : 'FAIL'} — ${result.reason}`)
process.exitCode = result.ok ? 0 : 1
