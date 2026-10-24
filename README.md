# 创造模式增强 · Creator Mode Plus

**v0.1.1** · DSH Host 插件 · 包名 `@dsh-external/dsh-creator-plus`

创造模式经常安装、修改、调试插件，一不小心就把本体客户端弄崩。本插件给创造模式加一个「分身」：
在临时的纯净 `DSH_HOME` 里启动一个 DSH，把待测插件装进去，用无头浏览器打开它的前端，确认能正常启动，**再**装进本体。

## 它做了什么

- **`clone_check` 工具**：临时 DSH_HOME → 建 profile（纯净 / 复制）→ `dsh plugin add` 待测包 → `--no-open --port <空闲端口>` 启动 → 等 `dsh web:` 就绪行 → 无头 Edge/Chrome/Chromium 打开 → 收集 pageerror、console.error、资源报错，检查非白屏、可选期望文字/元素 → 截图 → 清理。
- **`clone_close` 工具**：关掉 `keepAlive` 保留的分身。
- **创造模式提醒**：只给 `cordis`（创造模式）预设的会话注入一段短提醒：装进本体前先跑 `clone_check`，并显式说明这是官方 verification 指引中「不要另起浏览器 / 改 HOME」的唯一例外。其他预设看不到工具也不付提示词成本。

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
| `copy`（可选） | 复制当前 profile（含已装插件）和 home 级 `cordis.patch.yml`，再装待测插件 | 最接近你真实会崩的环境，能抓插件冲突、服务重复注册、patch 改坏组合 | 更慢更占盘；崩了难定位，需用 clean 对照；会去掉桌面专属 bundle；patch 里若有明文密钥会进临时目录（结束即删）；Windows 上 node_modules 的 junction 可能仍指向本体 |

## 用法

装好后在创造模式里照常让 AI 写插件即可，它会在安装前自己调用：

```
clone_check { "packageDir": "D:/work/my-plugin", "expectText": "My Panel" }
clone_check { "packageDir": "D:/work/my-plugin", "mode": "copy" }
clone_check { "packageDir": "D:/work/my-plugin", "keepAlive": true }   # 返回 viewUrl，可在侧边栏浏览器打开看
clone_close { "id": "all" }
```

## 配置（`cordis.patch.yml` 行的 `config`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `presets` | `["cordis"]` | 哪些预设获得工具和提醒 |
| `dshCommand` | 自动 | 手动指定启动命令数组，如 `["C:/Program Files/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd"]` |
| `browserPath` | 自动 | 浏览器可执行文件；也可设环境变量 `DSH_CLONE_BROWSER` |
| `browserArgs` | `[]` | 额外浏览器参数（Linux 容器里可能需要 `--no-sandbox`） |
| `startTimeoutSeconds` | 120 | 等分身就绪的上限 |
| `loadTimeoutSeconds` | 60 | 等页面 load 的上限 |
| `settleSeconds` | 5 | load 后再等多久收集报错 |
| `keepAliveMinutes` | 30 | 保留的分身多久自动关闭 |
| `ignoreErrors` | `[]` | 忽略的报错正则 |
| `artifactsDir` | 系统临时目录 `/dsh-creator-plus/shots` | 截图存放处 |

## 已知局限

- 只检查新会话落地页：只在已打开会话里才出现的插槽（例如 `conversation.composer.dock`）不会被渲染，这类崩溃查不出来（真机实测确认）。
- 验不到桌面专属路径：`dsh-app://` 协议、preload 桥、原生对话框。
- 分身没有你的模型凭据，只验证前端能启动，不跑模型对话。
- 找不到浏览器时降级为「后端就绪 + 首页可取」，结果里会写明未做视觉验证。
- 侧边栏查看依赖你把聊天链接偏好设为「应用内侧边栏」；Web 版侧边栏浏览器默认关闭，需要在 profile patch 里启用 `ui-sidebar-browser`。

## 安装

GitHub Release 附件（不发 npm）。解压后：

- Web/CLI：`dsh plugin --profile web add <解压目录>`
- 桌面版：先完全退出应用，`dsh plugin --profile desktop add <解压目录>`，再打开
- 或在创造模式里让 AI 用 `plugin_manager install_bundle` 安装该目录

## 真机实测（2026-10-24，DSH 0.2.1-rc.2，Linux + Chromium）

- 纯净分身：建 profile 约 0.2 秒，启动约 6 秒，无头检查约 8 秒。
- 能抓到：`apply()` 抛错（`web boot: 1 entry did not activate`）、首页插槽渲染抛错（`slot entry crashed in ...`）。
- 创造模式真实会话里，DeepSeek-V4.1-Flash 自己调用了 `clone_check`，正确报告 FAIL、定位到出错行，并说明页面因插槽错误边界没有白屏。

## 测试

```
npm test        # 单元 + Host 接线 + 端到端（假 dsh + 真实 Chromium；找不到浏览器会跳过浏览器用例）
```
