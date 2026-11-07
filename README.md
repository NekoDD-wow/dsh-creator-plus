# 创造模式增强 · Creator Mode Plus

[![CI](https://github.com/NekoDD-wow/dsh-creator-plus/actions/workflows/ci.yml/badge.svg)](https://github.com/NekoDD-wow/dsh-creator-plus/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/NekoDD-wow/dsh-creator-plus?label=release)](https://github.com/NekoDD-wow/dsh-creator-plus/releases)

**v0.1.6** · DSH Host 插件 · 包名 `@dsh-external/dsh-creator-plus`

创造模式经常安装、修改、调试插件，一不小心就把本体客户端弄崩。本插件给创造模式加一个「分身」：
在临时的纯净 `DSH_HOME` 里启动一个 DSH，把待测插件装进去，用无头浏览器打开它的前端，确认能正常启动，**再**装进本体。

## 它做了什么

- **`clone_check` 工具**：临时 DSH_HOME → 建 profile（纯净 / 复制）→ `dsh plugin add` 待测包 → `--no-open --port <空闲端口>` 启动 → 等 `dsh web:` 就绪行 → 无头 Edge/Chrome/Chromium 打开 → 收集 pageerror、console.error、资源报错，检查非白屏、可选期望文字/元素 → 截图 → 清理。
- **`clone_close` 工具**：关掉 `keepAlive` 保留的分身。
- **自动点掉首启弹窗**：clone 首次打开时的「预览版说明」和未登录的「开始使用」引导会被自动关闭，截图/检查结果更干净（命中记录写进 `page.dismissed`）。
- **创造模式提醒**：只给 `cordis`（创造模式）预设的会话注入一段短提醒：装进本体前先跑 `clone_check`，并显式说明这是官方 verification 指引中「不要另起浏览器 / 改 HOME」的唯一例外。其他预设看不到工具也不付提示词成本。
- **斜杠指令**（不进模型上下文、不烧 token）：`/clone-check`、`/clone-close`；`/clone-grant` / `/clone-revoke` 可以给标准模式等非创造模式会话临时注入工具使用权。

## 桌面版与 Web 都兼容

| | Web / CLI | 桌面版 |
|---|---|---|
| 启动分身 | 当前进程的 node + `@deepseek-ai/dsh/lib/bin.js` | 本体 Electron + `ELECTRON_RUN_AS_NODE=1` + 安装包内 `dsh-desktop-host/lib/cli.js`（与「管理 dsh 命令」安装的 dsh 等价） |
| 无头浏览器 | 系统 Edge / Chrome / Chromium，CDP 直连 | 同左（Windows 自带 Edge） |
| PATH | 不依赖 | 不依赖 |

分身一律起 **web** profile（桌面版的 `desktop` profile 由 Electron 独占，CLI 起不来），所以验证的是同一套 Web 客户端。

## 两种模式

| 模式 | 做法 | 利 | 弊 |
|---|---|---|---|
| `clean`（默认） | 官方 web 模板 + 只装待测插件 | 快；结果干净，崩了就是这个插件的问题；不带个人配置 | 测不出与已装插件的冲突、profile patch 的问题 |
| `copy`（可选） | 复制当前 profile（含已装插件）和 home 级 `cordis.patch.yml`，再装待测插件 | 最接近你真实会崩的环境，能抓插件冲突、服务重复注册、patch 改坏组合 | 更慢更占盘；崩了难定位，需用 clean 对照；会去掉桌面专属 bundle；patch 里若有明文密钥会进临时目录（结束即删）；Windows 上 junction 按原目标重建 |

`copy` 模式的两个环境细节已在 0.2.2 上处理：当前 profile 从 `profileContext` 解析（宿主进程没有 `DSH_PROFILE_DIR` 也能用）；装新包时对齐跨盘 pnpm store 并重建 `node_modules`（避免 `ERR_PNPM_UNEXPECTED_STORE`）。

## 用法

装好后在创造模式里照常让 AI 写插件即可，它会在安装前自己调用：

```
clone_check { "packageDir": "D:/work/my-plugin", "expectText": "My Panel" }
clone_check { "packageDir": "D:/work/my-plugin", "mode": "copy" }
clone_check { "packageDir": "D:/work/my-plugin", "keepAlive": true }   # 返回 viewUrl，可在侧边栏浏览器打开看
clone_close { "id": "all" }
```

### 斜杠指令（不进模型上下文）

不想走模型轮时，在 Web / 桌面输入框里直接执行：

```
/clone-check D:/work/my-plugin             # 默认 clean；可加 copy / keep
/clone-check "D:/my work/my-plugin" copy   # 路径带空格用双引号
/clone-close                               # 关闭所有 keepAlive 保留的分身
/clone-grant                               # 给当前会话临时注入 clone_check / clone_close + 提醒
/clone-revoke                              # 收回 /clone-grant 注入的那份
```

- `/clone-check` 参数与工具一致：`clean|copy`、`keep`；结果直接显示在会话里，完整步骤/截图仍在 `clone_check` 工具结果中。
- 指定单个分身的 id 用 `clone_close` 工具（`/clone-close` 只关闭全部）。
- `/clone-grant` 用于**非创造模式**：标准模式等任意预设的会话都能用它临时装上工具与提醒（模型下一步就能调用 `clone_check`），`/clone-revoke` 收回。授权是会话级的，客户端重启/会话恢复后不保留；切到目标预设时预设自带的那份优先，不会重复注册。
- 斜杠指令只在交互式 UI（Web / 桌面）可用；headless / ACP 自动化没有命令面。

## 配置（`cordis.patch.yml` 行的 `config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `presets` | `["cordis"]` | 哪些预设获得工具和提醒 |
| `dshCommand` | 自动 | 手动指定启动命令数组，如 `["C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"]` |
| `browserPath` | 自动 | 浏览器可执行文件；也可设环境变量 `DSH_CLONE_BROWSER` |
| `browserArgs` | `[]` | 额外浏览器参数（Linux 容器里可能需要 `--no-sandbox`） |
| `startTimeoutSeconds` | 120 | 等分身就绪的上限 |
| `loadTimeoutSeconds` | 60 | 等页面 load 的上限 |
| `settleSeconds` | 2 | load 后再等多久收集报错（慢机器可调大） |
| `keepAliveMinutes` | 30 | 保留的分身多久自动关闭 |
| `ignoreErrors` | `[]` | 忽略的报错正则 |
| `artifactsDir` | 系统临时目录 `/dsh-creator-plus/shots` | 截图存放处 |

## 已知局限

- 只检查新会话落地页：只在已打开会话里才出现的插槽（例如 `conversation.composer.dock`）不会被渲染，这类崩溃查不出来（真机实测确认）。
- 验不到桌面专属路径：`dsh-app://` 协议、preload 桥、原生对话框。
- 分身没有你的模型凭据，只验证前端能启动，不跑模型对话。
- 找不到浏览器时降级为「后端就绪 + 首页可取」，结果里会写明未做视觉验证。
- 侧边栏查看依赖你把聊天链接偏好设为「应用内侧边栏」；Web 版侧边栏浏览器默认关闭，需要在 profile patch 里启用 `ui-sidebar-browser`。
- `/clone-grant` 的授权是会话级、不持久：客户端重启或会话恢复后要重新执行；恢复的会话不会自动回放授权。
- `packageDir` 含 Windows shell 元字符（`& | < > ^ % ! "`）或控制字符时会被直接拒绝（`dsh` 走 PATH 回退时 spawn 经过 cmd.exe，宁拒绝不拼命令）。
- 启动耗时的大头仍是 `dsh web` 本身（约 6s）；再往下提速只能做常驻分身 + 热重载，本插件暂不提供。

## 安装

GitHub Release 附件（不发 npm）。解压后：

- Web/CLI：`dsh plugin --profile web add <解压目录>`
- 桌面版：先完全退出应用，`dsh plugin --profile desktop add <解压目录>`，再打开
- 或在创造模式里让 AI 用 `plugin_manager install_bundle` 安装该目录

## 兼容性（DSH 0.2.2-rc.1，2026-11-07 实测）

结论：能安装、能激活、CLI / API / 预设 id 都在；0.1.1 在该版本上的缺陷都已在 v0.1.2–v0.1.6 修完。

| 版本 | 修复 / 改动 |
|---|---|
| v0.1.2 | 不再漏判「宿主插件激活失败」（stderr 的 `did not activate` 判 FAIL）；Windows copy 模式改用 junction 重建（EPERM 修复） |
| v0.1.3 | copy 模式从 `profileContext` 解析当前 profile（宿主进程没有 `DSH_PROFILE_DIR`） |
| v0.1.4 | copy 模式装入待测插件：已 `link` 的包跳过重装；新包对齐跨盘 pnpm store 并重建 `node_modules` |
| v0.1.5 | 提速：默认 `settleSeconds` 5 → 2（省 3s），浏览器启动与 profile/web 启动并行 |
| v0.1.6 | 首启弹窗自动点掉（「预览版说明」「开始使用」引导），截图/检查更干净 |

**创造模式工具注册 E2E**（`scripts/verify-preset.mjs`）：copy 模式 clone 当前 web profile → 打开 clone 的 Web UI → 切「创造模式」→ 发一条消息 → 读 clone home 的 `sessions/**.zstd`。2026-11-07 在 Windows + DSH 0.2.2-rc.1 上 PASS，证据：

- 会话事件 `agent-preset/selected = cordis`（这一轮确实跑在创造模式下）；
- `system/message` 含 REMINDER 原文 `Clone check before touching the live client`；
- `request/header` 的工具列表含 `clone_check` 与 `clone_close`；
- 截图与 JSON 报告写在 `--artifacts` 目录，默认 `%TEMP%\dsh-creator-plus\verify-preset`。

clone 用的是临时 `DSH_HOME`，没有模型凭据，所以那条消息对应的一轮会以 `MISSING_CREDENTIAL` 失败——但系统提示与请求头在调用模型前就已落盘，既能拿到证据，也不消耗额度。复现：

```powershell
node scripts/verify-preset.mjs \
  --profile-dir "C:\Users\<你>\.dsh\profiles\web" \
  --home "C:\Users\<你>\.dsh"
```

## 真机实测（2026-11-07，DSH 0.2.2-rc.1，Windows 11 + Edge）

| 场景 | 结果 |
|---|---|
| clean 基线 | PASS，约 9.2s（建 profile 0.3s + 启动 web 6.1s + 无头检查 2.8s） |
| clean + 真插件 | PASS，约 11.3s（装入插件 ~1.1s） |
| 对照插件（`apply()` 抛错） | FAIL，`activationWarnings` 带回 `did not activate` 与完整栈 |
| 负向对照（期望文字不存在） | FAIL，原因「没找到期望文字」——判定不是空跑 |
| Windows copy（跳过重装） | PASS，约 13.4–14.5s（复制 2.8–3.2s，重建 3 个 junction） |
| copy + 装新包（跨盘） | PASS，装入 2.96s；修复前同场景失败 |
| 标准模式 `/clone-grant` | 请求头工具 54 → 56，含 `clone_check` / `clone_close`，系统提示带 REMINDER |
| 首启弹窗 | 自动点掉「继续」「关闭」，截图无弹窗 |

更早的实测记录见 [CHANGELOG.md](CHANGELOG.md)。

## 测试

```
npm test        # 单元 + Host 接线 + 端到端（假 dsh + 真实 Chromium；找不到浏览器会跳过浏览器用例）
                # 当前 36 项全绿

# 真机回归：创造模式下工具是否真的注册了（需要本机已装 dsh 与 Edge/Chrome）
npm run verify-preset -- --profile-dir "C:\Users\<你>\.dsh\profiles\web" --home "C:\Users\<你>\.dsh"
```

注：`scripts/verify-preset.mjs` 与 `npm run verify-preset` 只在 GitHub 源码仓库里，发布 zip 不含 `scripts/`。
