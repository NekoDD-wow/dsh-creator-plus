# Changelog

本项目遵循语义化版本；记录到每次 GitHub Release 的变更。

## v0.1.3（2026-11-07）

### 修复

- **copy 模式在真实宿主进程里拿不到当前 profile**：`DSH_PROFILE_DIR` 只由
  `shell-env` 注入给工具 shell，宿主进程（例如用 `dsh web` 启动）的
  `process.env` 里没有它，导致 `clone_check { mode: "copy" }` 在「复制当前 profile」
  一步就以「复制模式需要当前 profile 目录」失败。现在优先从 `profileContext`
  服务取 `dir` / `home`（`shell-env` 也是从这里取的），`DSH_PROFILE_DIR` /
  `DSH_HOME` 只作兜底；两者都拿不到时错误信息会写明。
  真机验证：标准 web profile 的 copy 模式 PASS（2476 文件 / 252 目录 / 3 junction，
  复制 2.7s，整次 13s）。

## v0.1.2（2026-11-07）

### 修复

- **激活失败漏判（P0）**：DSH 0.2.2 对 `apply()` 抛错的可选插件只打一行
  `dsh: warning: N entry did not activate` 并照常提供页面，旧实现看到 `dsh web:` 行就判 PASS。
  现在解析 stderr 的告警块，页面检查后复查，命中即判 FAIL，并把告警与栈带回
  `activationWarnings` / `serverLog`。
- **Windows copy 模式 EPERM（P0）**：`fs.cp({ verbatimSymlinks: true })` 重建 pnpm junction 会因缺少
  符号链接权限失败。Windows 改为自写遍历：目录链接按原目标重建 junction（无需权限），文件链接解引用，
  失效链接跳过并记 note；POSIX 保持 `fs.cp`。

### 新增

- **斜杠指令**（不进模型上下文、不烧 token）：`/clone-check <dir> [clean|copy] [keep]`、
  `/clone-close`（关闭所有保留分身）。
- **`/clone-grant` / `/clone-revoke`**：给非创造模式（标准模式等）的会话临时注入
  `clone_check` / `clone_close` 与提醒；人类触发、会话级、下一步生效，切回目标预设时自动去重。
- **`scripts/verify-preset.mjs`**：真机回归——copy 模式 clone 当前 profile、切创造模式、发消息，
  从会话日志确认 REMINDER 与工具列表里有 `clone_check` / `clone_close`。
- README 增加「兼容性（DSH 0.2.2-rc.1）」与斜杠指令说明。

### 加固

- `packageDir` 含 Windows shell 元字符（`& | < > ^ % ! "`）或控制字符时直接拒绝
  （PATH 回退时 spawn 经过 cmd.exe，宁拒绝不拼命令）。

### 测试

- `npm test` 28 项通过（单元 + Host 接线 + 端到端，假 dsh + 真实 Chromium）。
- 真机 DSH 0.2.2-rc.1 验证：对照插件 FAIL、基线/真插件 PASS、Windows copy 模式 PASS、
  创造模式工具注册 PASS、标准模式 `/clone-grant` 注入工具 PASS。

## v0.1.1（2026-10-24）

- 修复：桌面版启动分身时，内置 CLI 路径改为按目标平台拼接（`posix` / `win32`）；
  原实现用宿主 `path.join`，在 Windows 上解析 darwin 路径会得到反斜杠。
- 增强：`runClone` 新增 `browserTimeoutMs` 选项（默认 30000），用于冷启动更慢的 CI。
- 文档：README 版本号对齐 `package.json`。
- 仓库新增：`scripts/build-zip.py`（可复现打包）与 GitHub Actions CI
  （ubuntu/windows × node 22/24）。

## v0.1.0

- 首个内部版本（未单独打 tag）：`clone_check` / `clone_close` 工具与创造模式提醒。
