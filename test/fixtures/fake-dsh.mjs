#!/usr/bin/env node
// 假的 dsh CLI：只实现分身用到的几条命令，用来端到端测试 runClone。
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'

const home = process.env.DSH_HOME
const args = process.argv.slice(2)
const profileDir = name => join(home, 'profiles', name)

if (args[0] === 'plugin') {
  // plugin --profile clone add <dir>
  const dir = profileDir(args[2])
  if (!existsSync(dir)) { console.error('profile not initialized'); process.exit(1) }
  const pkg = JSON.parse(readFileSync(join(args[4], 'package.json'), 'utf8'))
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ dir: args[4], name: pkg.name, behavior: pkg.fakeBehavior || 'ok' }))
  console.log(`installed ${pkg.name}`)
  process.exit(0)
}
const name = args[0]
if (args.includes('--from-default-profile')) {
  mkdirSync(profileDir(name), { recursive: true })
  writeFileSync(join(profileDir(name), 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }))
}
if (args.includes('--dump-config')) { console.log('- id: fake'); process.exit(0) }
if (!existsSync(profileDir(name))) { console.error(`no profile ${name}`); process.exit(1) }
const installedPath = join(profileDir(name), 'installed.json')
const behavior = existsSync(installedPath) ? JSON.parse(readFileSync(installedPath, 'utf8')).behavior : 'ok'
if (behavior === 'host-crash') { console.error('TypeError: plugin apply failed: boom'); process.exit(1) }
const port = Number(args[args.indexOf('--port') + 1])
const script = behavior === 'client-crash'
  ? `throw new Error('slot entry crashed: Cannot read properties of undefined')`
  : behavior === 'blank' ? `` : `document.getElementById('root').innerHTML = '<h1>DeepSeek Harness</h1><p>clone ok</p>'`
createServer((req, res) => {
  if (req.url.startsWith('/app.js')) { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(script); return }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><title>DSH</title><div id="root"></div><script src="/app.js"></script>`)
}).listen(port, '127.0.0.1', () => {
  console.log(`dsh web: http://127.0.0.1:${port}/?token=secret123`)
})
