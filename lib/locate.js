// 找到「怎么启动 dsh」和「用哪个浏览器」。纯函数为主，便于单测。
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, delimiter, posix, win32 } from 'node:path'
import { createRequire } from 'node:module'

const CLI_ENTRY_RE = /[\\/]@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/

/**
 * 解析启动分身用的 dsh 命令。顺序：配置覆盖 → 桌面版内置 CLI → 当前进程的 CLI 入口 → 可解析的 @deepseek-ai/dsh → PATH。
 * 始终优先与本体同一个运行时与同一个 dsh 版本，不依赖 PATH。
 * @returns {{command: string, args: string[], env: Record<string,string>, shell: boolean, source: string}}
 */
export function resolveDshCommand({
  override,
  platform = process.platform,
  execPath = process.execPath,
  argv = process.argv,
  versions = process.versions,
  exists = existsSync,
  realpath = safeRealpath,
  requireFrom = defaultRequireFrom,
} = {}) {
  if (Array.isArray(override) && override.length > 0) {
    return { command: override[0], args: override.slice(1), env: {}, shell: false, source: 'config' }
  }
  if (versions && versions.electron) {
    // 桌面版：Host 跑在 Electron RunAsNode 子进程里；与安装包内 resources/runtime/cli/bin/dsh(.cmd) 等价。
    // 路径跟随目标平台（不是宿主平台）：便于在 Windows 上单测 darwin/linux 分支。
    const p = platform === 'win32' ? win32 : posix
    const resources = platform === 'darwin'
      ? p.join(p.dirname(execPath), '..', 'Resources')
      : p.join(p.dirname(execPath), 'resources')
    const cli = p.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
    return {
      command: execPath,
      args: ['--expose-internals', cli],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
      source: 'desktop',
    }
  }
  const entry = argv && argv[1] ? realpath(argv[1]) : undefined
  if (entry && CLI_ENTRY_RE.test(entry) && exists(entry)) {
    return { command: execPath, args: [entry], env: {}, shell: false, source: 'cli-entry' }
  }
  for (const base of [entry, import.meta.url]) {
    if (!base) continue
    try {
      const pkg = requireFrom(base).resolve('@deepseek-ai/dsh/package.json')
      const bin = join(dirname(pkg), 'lib', 'bin.js')
      if (exists(bin)) return { command: execPath, args: [bin], env: {}, shell: false, source: 'resolved' }
    } catch { /* 继续下一种方式 */ }
  }
  return {
    command: platform === 'win32' ? 'dsh.cmd' : 'dsh',
    args: [],
    env: {},
    shell: platform === 'win32',
    source: 'path',
  }
}

function safeRealpath(p) {
  try { return realpathSync(p) } catch { return p }
}

function defaultRequireFrom(base) {
  return createRequire(base)
}

/** 当前平台上常见的 Chromium 系浏览器位置（Edge 优先，因为 Windows 自带）。 */
export function browserCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)
    const rel = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ]
    const out = []
    for (const r of rel) for (const root of roots) out.push(join(root, ...r))
    return out
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      join(env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
  }
  const names = ['microsoft-edge', 'microsoft-edge-stable', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean)
  const out = []
  for (const n of names) for (const d of dirs) out.push(join(d, n))
  return out
}

/** 找浏览器：配置路径 → 环境变量 DSH_CLONE_BROWSER → 常见位置。找不到返回 undefined。 */
export function findBrowser({ override, platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (override) return exists(override) ? override : undefined
  if (env.DSH_CLONE_BROWSER && exists(env.DSH_CLONE_BROWSER)) return env.DSH_CLONE_BROWSER
  return browserCandidates({ platform, env }).find(p => exists(p))
}
