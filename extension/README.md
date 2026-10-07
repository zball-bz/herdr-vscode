# Herdr Pane（VS Code 扩展）

把 herdr 会话里的 pane 显示成 VS Code 编辑器区的面板（WebviewPanel），布局交给 VS Code（分栏、拖动、标签页），不使用 herdr 自己的分屏。活动栏有一个 **Herdr** 视图，按“工作区 → pane”列出会话，带 agent 状态和“blocked”角标。画面由 herdr-web（GPUI 浏览器后端编译的 WASM）渲染；扩展宿主只负责连接守护进程并原样转发字节。

```
                         ┌─ 元数据连接（herdr-core Node 版，surface_active=false）→ 树、标题、状态图标、角标
herdr 守护进程 ──socket/ssh┤
                         └─ 每个面板一条连接 ──postMessage──► webview ──► herdr-web.wasm（config.tabId）
变更操作（tab.create / pane.move / rename / close …）→ JSON API socket herdr.sock（远端：ssh 上的 `herdr remote-api-bridge`，同一套 JSON 行协议）
```

每个面板对应一个 herdr tab（通常只含一个 pane），各自一条守护进程连接，herdr-web 把自己的连接固定在该 tab 上。

## 构建

```sh
npm install
npm run sync-web     # 复制 ../spike/herdr-web/pkg → media/herdr-web，../spike/herdr-core/pkg → media/herdr-core
                     # （WASM 重新构建后再跑；可用 -- --web <dir> --core <dir> 指定别的目录）
npm run build        # esbuild：dist/extension.js（Node/CJS）+ dist/webview.js（浏览器/ESM）
npm run typecheck    # tsc --noEmit
npm run package      # 可选：sync-web + build + vsce package → .vsix
npm run keybindings  # 修改 scripts/keybindings.mjs 后重新生成 package.json 里的快捷键
```

## 运行

```sh
code --extensionDevelopmentPath=$PWD
```

点击活动栏的 Herdr 图标，单击 pane 打开（`+` 新建终端），或在命令面板用 **Herdr: New Terminal** / **New Terminal to the Side**。输出通道 **Herdr** 有连接、字体、WASM 控制台日志。

## 测试

```sh
npm run test:unit                              # 配色（OKLab/APCA、各格式读写、优化器）、字体栈、socket/API 路径、远端 API 桥（假 herdr）、按键规范化、链接路径、SSH 握手（假 ssh）、断线重连
HERDR_E2E_DIR=/某个/临时目录 npm run test:e2e    # 真实 VS Code 端到端
HERDR_E2E_PERF=1 HERDR_E2E_GPU=1 node test/e2e.mjs  # 性能：打开/切回面板、按键回显、全屏刷新、内存（结果写 perf.json）
```

端到端测试：启动隔离会话 `herdr --session vscspike server`，建两个工作区（alpha、beta 在同一 tab 里分屏，alpha 报告为 blocked agent）；默认在私有 Xvfb 显示上（SwiftShader 软件 WebGL）用一次性的 `--user-data-dir`、`--extensions-dir`、`--shared-data-dir` 启动 `/usr/share/code/code`（`VSCODE_BIN` 可覆盖），`HERDR_E2E_GPU=1` 仍在 Xvfb 上但经 ANGLE/Vulkan 用真 GPU（WebGL2，和桌面 VS Code 一致），`HERDR_E2E_DISPLAY=desktop` 改用当前桌面（真 GPU，但用户的操作会抢焦点，结果可能不稳定）；`HERDR_E2E_FONT` 设编辑器字体（例如 `Sarasa Mono SC`），`HERDR_E2E_SCALE=1.75` 按分数缩放运行（`--force-device-scale-factor`，用来比较 HiDPI 下的文字），`HERDR_E2E_RETAIN=0` 关闭隐藏面板保活；通过 `--remote-debugging-port` + Playwright 驱动。覆盖：树和角标、`pane.move`、左右两个面板各自输入（用 `herdr pane read` 验证）、Ctrl+P 留在 shell、快捷键吞键、复制/粘贴（含真实鼠标选区）、查找、链接（含相对子目录的路径搜索、多处匹配时的选择列表、悬停工具栏的各个按钮、在集成浏览器中打开）、重命名、新建/关闭 pane、隐藏/显示（默认保活）、GPU 上下文丢失后自动重载、重载窗口后重新挂接、主题切换、设置页（齿轮入口、导入、优化、保存、设为面板配色、写入 VS Code 终端配色）、远端机器（真实 sshd，环回和 Tailscale 地址：添加、连通、开终端、连不上时的提示、移除）。`xdg-open` 被替换成记录 URL 的脚本。结束时关闭 VS Code、Xvfb，并 `herdr session stop/delete vscspike`。不会连接或停止默认会话，也不碰真实 VS Code 配置；复制/粘贴测试会改写系统剪贴板。`HERDR_E2E_HOLD=1` 只做准备并保持运行，便于调试。

## 使用

- **树**：工作区 → pane（不显示 herdr tab）。pane 图标：working（转圈）、blocked（铃铛，黄）、done（勾，绿）、idle（空心圆）、无 agent（终端）。活动栏角标 = blocked agent 数。实时刷新。
- **打开 pane**：单击打开；行内按钮/右键“Open Pane to the Side”在旁边打开。若该 pane 所在 tab 还有别的 pane，先 `pane.move` 到新 tab；若已有面板显示这个 tab，只是切换过去（同一 tab 两个视图会争 pty 尺寸）。
- **关闭面板只是分离**，pane 继续运行；**Close Pane (Terminate)**（确认后）才会结束进程。pane 结束或被关时面板自动关闭（herdr-web 的 `tabClosed`）。
- **New Terminal**（工作区行内 `+`、视图标题栏 `+`、命令面板、面板标题栏的分栏按钮）= `tab.create` 后打开。
- **Move to New Workspace**（pane 右键）= `pane.move` 到一个新工作区，进程不变。herdr 会给它新的 pane id 和 tab，显示它的面板跟过去，不会关闭。工作区里只剩这一个 pane 时不移动。
- **Open Folder in New Window / in This Window**（工作区右键）用 VS Code 打开该工作区的目录（herdr 的 `new_workspace_cwd`，没有时取其聚焦 pane 的目录）。远端机器上的工作区经 Remote - SSH 打开：目标按原样作为 `ssh-remote+…`，带端口的 `ssh://` 用 Remote - SSH 的十六进制 JSON 形式；没装 Remote - SSH 时提示安装。
- 重载窗口后面板通过 WebviewPanelSerializer 按 `{tabId, paneId}` 重新挂接。
- 面板标题 = pane 标签 / agent 名 / 当前目录名，图标随 agent 状态变化。
- **滚动条**：样式同 Konsole/Qt 的桌面滚动条，贴在面板右边缘，约 14 px 宽，由上箭头按钮、轨道、滑块和下箭头按钮组成。
  - **占位**：herdr 的 `pane_scrollbars`（默认开）会在 pane 右侧留一列。面板向 herdr 多报一列，让这一列刚好落在滚动条下面，不占文字区。
  - **何时显示**：没有回滚内容时只画轨道，不画滑块。全屏程序（备用屏幕，如 vim、codex）会拿回这一列，滚动条随之隐藏。
  - **操作**：
    - 箭头按钮滚一行，按住连续滚动。
    - 点轨道朝指针翻页，按住连续翻页。
    - Shift+点击轨道直接跳到该处。
    - 拖动滑块滚动。
    - 滚轮照常。
  - **请求**：同一时间只有一个 `pane.scroll` 在途，只发最新位置。
  - 分屏时不在最右边的 pane 仍用列内的细滑块。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `herdr.session` | `default` | 会话名。`default` → `$XDG_CONFIG_HOME/herdr/herdr-client.sock`，其他 → `…/herdr/sessions/<name>/herdr-client.sock` |
| `herdr.socketPath` | 空 | 显式的客户端协议 socket（`herdr-client.sock`）。API socket 取同目录的 `<stem>.sock` |
| `herdr.machines` | `[]` | 远端机器 `{name, target, session}`，通常用 Workspaces 视图的"Add Remote Machine"按钮添加 |
| `herdr.localMachine` | `true` | 是否显示本机的 herdr；只用来看远端的机器可以关掉 |
| `herdr.remote` | 空 | 已弃用：填了会当成一台远端机器显示，请改用 `herdr.machines` |
| `herdr.fontFallbacks` | `[]` | 字体栈之后再试的字体族。浏览器本身会为中文、emoji 等回退到已装字体，只在想指定某个字体时才需要 |
| `herdr.editorKeys` | 见下 | 面板聚焦时交给 VS Code 的按键 → 命令 |
| `herdr.retainContextWhenHidden` | `true` | 隐藏的面板是否保留 herdr-web 实例 |
| `herdr.colorScheme` | 空 | herdr 面板用的配色方案名；空则用 VS Code 主题的终端颜色 |
| `herdr.colorSchemes` | `[]` | 配色方案（由设置页导入和编辑，也可以直接改 settings.json） |

本地 socket 优先级：`herdr.socketPath` > `HERDR_CLIENT_SOCKET_PATH` > `HERDR_SOCKET_PATH` 旁的 `<stem>-client.sock` > `herdr.session`。

字体与外观：字体栈取 `terminal.integrated.fontFamily`（空则 `editor.fontFamily`），交给 webview 里的浏览器解析和绘制，与 VS Code 自己的终端相同：扩展不读也不传字体文件，任何已安装字体都能用（包括 .ttc 字体集合），中文、emoji 等由浏览器回退；远程窗口里用的也是显示窗口那台机器的字体。herdr-web 的 GPUI 对没有字节的字体族走“浏览器字体”（`spike/vendor/gpui-pre-web` 的补丁）：Canvas 按字素测宽、光栅化进 GPUI 的字形图集，字体度量取 `TextMetrics.fontBoundingBox*`；终端逐格排版，不做跨字素的整形（连字不生效）。字形按文字颜色的亮度光栅化，系统开启次像素抗锯齿时用 LCD 抗锯齿（与 VS Code 自己的终端相同，在 175% 下逐像素对比过），格宽和行高取整到设备像素，分数缩放下每一列都一样清晰。比所占格子宽的字形缩小到格内并居中（同 VS Code 的 `terminal.integrated.rescaleOverlappingGlyphs`），例如 Sarasa **Mono** 里全角的 `…` `—` `→` `①`；终端更推荐 Sarasa **Term**，这些东亚宽度有歧义的字符本身就是半角。`cellHeight = round(fontSize × terminal.integrated.lineHeight × 1.43)`。`terminal.integrated.copyOnSelection` → `copyOnSelect`。颜色取 `--vscode-terminal-*`（背景缺省用编辑器背景）。字体或主题变化时面板自动重新加载（会话不受影响）。

GPU 上下文丢失（驱动重置、GPU 进程重启）后 GPUI 无法在网页里恢复：补丁让它派发一次 `gpui-graphics-lost`，扩展自动重载该面板；30 秒内再次丢失则改为弹出错误提示。

### 性能（实测，Xvfb + ANGLE/Vulkan 真 GPU、WebGL2，1600×1000，`test/perf.mjs`）

| 项目 | 结果 |
| --- | --- |
| 打开第一个面板 → 画出 | 约 550 ms（其中 webview 自身约 220 ms；改用浏览器字体前 Sarasa 下 930 ms） |
| 同组里切到隐藏的面板 → 画出新帧 | 保活（默认）p50 51 ms、p95 70 ms，切换瞬间先显示旧画面；不保活 p50 298 ms、p95 595 ms（每次重建 webview，期间空白） |
| 按键 → 回显画出 | p50 约 4 ms |
| 全屏每帧整屏变化 | 60 帧/s，每帧主线程约 2.2 ms，扩展宿主转发约 4% CPU |
| 每个面板的 WASM / JS 堆 | 6 MB / 5 MB（改用浏览器字体前 Sarasa 下 62 MB / 116 MB，扩展宿主另占 130 MB） |
| 内存 | 第一个面板约 +200 MB（新起的 webview 渲染进程，各面板共用）；之后每个保活的隐藏面板约 +24 MB PSS（渲染进程约 22 MB、GPU 进程约 5 MB），不保活则不增加。隐藏的面板不收画面、不占 CPU |

webview 在每次加载时把各阶段耗时写进 Herdr 输出通道（`first paint … (webview ms: script, wasm, init, run, painted)`）。

## 远端机器

Workspaces 视图标题栏的"Add Remote Machine"按钮（远程图标）依次询问三项：
1. SSH 目标：`user@host`、`~/.ssh/config` 里的 Host 别名，或 `ssh://user@host:port`；
2. 那台机器上的 herdr 会话名（默认 `default`）；
3. 在树里显示的名字。

添加前会先 ssh 登录一次，确认那边能找到兼容的 herdr：
- 成功才写入 `herdr.machines`。
- 失败时说明原因和修法（主机密钥未确认、密钥登录失败、主机名解析不了、端口无人监听、网络不通、没装 herdr、herdr 版本不兼容），可以选"Add Anyway"仍然添加。

有远端机器时，树的最上面一层是机器节点（本机显示主机名和"this machine"），节点上显示连接状态。
- **行内按钮**：新建终端、重连。
- **右键菜单**：新建终端、新建工作区、重连、移除机器。移除只会关掉面板，那边的 pane 继续运行。

**两端各需要什么**

| | 运行程序的机器（herdr 所在） | 显示的机器（VS Code 所在） |
| --- | --- | --- |
| 软件 | herdr（在 PATH 上或 `~/.local/bin` 等常见位置）和 sshd | VS Code、本扩展、OpenSSH 客户端；不需要装 herdr |
| 服务 | 不用手动启动：第一次连接时 `herdr remote-client-bridge` 会自动启动该会话的服务器 | 无 |
| 认证 | 允许显示端的公钥登录（`authorized_keys`，或 Tailscale SSH） | 私钥在 ssh-agent 或 `~/.ssh/config` 里，并且已经确认过对方的主机密钥（先在终端里 `ssh host` 一次）。扩展用 BatchMode，不能输入密码 |
| 网络 | 只需要 SSH 端口可达，不开其他端口 | 无 |

**怎么连**：
- 每台机器的元数据连接、它的每个面板、各种 API 操作各走一条 `ssh … herdr --session S remote-client-bridge` / `remote-api-bridge`，共用一个私有 ControlMaster（`$TMPDIR/herdr-ssh-<uid>/%C`，ControlPersist 60 s），只做一次握手。SSH 参数和 herdr 自己的 `herdr --remote` 一致（BatchMode、StrictHostKeyChecking、ServerAlive 15 s × 4）。
- 远端面板的标题带机器名（`claude · devbox`），重载窗口后按 `{机器, tab, pane}` 重新挂接。
- 远端的路径链接不在本地打开；在远端新建工作区时不带本窗口的文件夹作为工作目录。

**实测**（`test/remote.mjs`，由 e2e 调用）：
- 测试在 127.0.0.1 和本机的 Tailscale 地址上起一个私有 sshd（临时主机密钥和客户端密钥，禁用密码），每台"远端机器"用一个隔离的 herdr 会话。
- 覆盖的场景：添加机器、连通、在远端开终端并输入、Tailscale 地址、连不上时的提示、移除机器。
- 经 SSH 环回，按键到回显 p50 3.8 ms，和本机直连一样。也就是说 SSH 本身几乎不加开销，真实网络下约为"一次往返 + 4 ms"。

## 设置页与配色方案

Workspaces 视图标题栏的齿轮按钮（或命令 **Herdr: Settings**）打开设置页，用来管理终端配色方案。

- **存储**：方案存在 `herdr.colorSchemes` 里，会随设置同步，也能直接手改 settings.json。`herdr.colorScheme` 指定面板当前用哪一个。面板使用的方案变了，面板会自动重新加载。
- **导入**：
  - 用"Import…"选文件，或把文件拖到页面上。
  - 支持的格式：Konsole `.colorscheme`、iTerm2 `.itermcolors`、Windows Terminal JSON（单个方案或含 `schemes` 的设置文件）、Ghostty、Alacritty TOML、kitty `.conf`、VS Code（`workbench.colorCustomizations` 或主题的 `colors`）、Xresources。
  - "Import from Konsole"列出本机的 Konsole 方案（读 `konsolerc` 的默认 profile，当前在用的排在第一）。
  - "From VS Code theme"把当前 VS Code 终端颜色存成一个方案。
- **导出**：导出成上面任一格式。"Use for VS Code's terminal"把方案写进 `workbench.colorCustomizations`，让 VS Code 自带终端也用同一套颜色；"Reset VS Code terminal"把这些键删掉。
- **编辑**：
  - 每个颜色显示对背景的 APCA Lc，不达标的标红。
  - 选中一个颜色后，可以用原生取色器、十六进制、OKLCH 三个滑条（亮度、彩度、色相）修改。
  - 可以锁定颜色，自动优化时就不动它。
  - 预览区展示常见输出：ls、git diff、Claude Code 风格的输出、编译器报错，以及 16 色分别作为前景和背景的效果。
- **可读性自动优化**（`src/colors/optimize.ts`）：
  - **角色与目标**：每个颜色有一个角色，对应一个对背景的最低 APCA |Lc|。三档目标（宽松/标准/高）：

    | 角色 | 宽松 | 标准 | 高 |
    | --- | --- | --- | --- |
    | 前景（正文） | 60 | 75 | 90 |
    | 彩色（1–7、9–15） | 45 | 60 | 75 |
    | 次要文字（8 亮黑：注释、暗淡输出） | 30 | 45 | 60 |
    | 光标 | 30 | 45 | 60 |

    深色方案里的黑（0）通常用作底色，不设目标；浅色方案里它是文字，按彩色的目标算。
  - **怎么调**：不达标的颜色只在 OKLCH 里改亮度，色相不变，彩度在 sRGB 色域允许的范围内尽量保留（色域外只降彩度）。用二分法找到达标所需的最小亮度变化，直接在 `#rrggbb` 上搜索，保证写回去以后仍然达标。背景色从不改动。
  - **事后检查**：
    - 亮色和对应的常规色在 OKLab 里相距（ΔE）不足 0.03、看起来几乎一样时，把亮色继续往远离背景的方向推一点。
    - 色相相近、又难以分辨的两个彩色，只提示，不改。
    - 结果表列出每个颜色前后的值、Lc 变化和 ΔE（OKLab 距离，0.02 约为刚能察觉的差别）。确认后再"Apply changes"。
  - **为什么用 APCA 测可读性、用 OKLab/OKLCH 来改**：
    - 文字可读性取决于文字和背景之间的亮度对比，APCA 正是按这个建模的，而且区分深字浅底和浅字深底两种极性。
    - OKLab 的亮度 L 会随彩度变高。纯蓝 `#0000ff` 在 OKLab 里 L = 0.45，看起来不算暗，但在黑底上只有 Lc 16（WCAG 2.4:1），很难读。
    - OKLab/OKLCH 用来改色和衡量改动幅度：等距的改动看起来幅度相同，色相也不会漂。

## 快捷键

面板聚焦时（上下文键 `herdr.paneFocused`，由 webview 上报焦点，按面板分别记录）：

- **发给终端，VS Code 不响应**：`Ctrl+A…Z`、`Alt+A…Z`、`Ctrl+Shift+A…Z`（绑定到空命令 `herdr.noop`）。包括 `Ctrl+P`（shell 历史）、`Ctrl+F`（forward-char）、`Ctrl+J`、`Ctrl+B`、`Ctrl+W`。
- **herdr-web 自己处理**：`Ctrl+Shift+C` 复制、`Ctrl+Shift+V` 粘贴（视图发 `requestPaste`，扩展读剪贴板回传）、`Ctrl+Shift+F` 查找（命令面板里 “Herdr: Find” 显示此快捷键）、有选区时 `Ctrl+C` 复制。macOS 的 `Cmd+C`/`Cmd+V` 同样交给视图（未在 macOS 测试）。
- **交给 VS Code（`herdr.editorKeys` 默认）**：`Ctrl+Shift+P`/`F1` 命令面板、`` Ctrl+` `` 切换终端面板、`` Ctrl+Shift+` `` 新建终端。webview 截获这些键，终端收不到，由扩展执行命令。想让 `Ctrl+P` 打开快速打开：`"herdr.editorKeys": { "ctrl+p": "workbench.action.quickOpen" }`。

为何不用 `activeWebviewPanelId == 'herdr.pane'`：它在面板内为真，但焦点在侧边栏/树里、而活动编辑器仍是 herdr 面板时也为真，会把在侧边栏按的 Ctrl+B 等吞掉。`focusedView` 只适用于视图，不适用于编辑器面板。

命令：Herdr: New Terminal / New Terminal to the Side / Open Pane / Open Pane to the Side / Rename Pane / Move to New Workspace / Close Pane (Terminate) / New Workspace / Rename Workspace / Open Folder in New Window / Open Folder in This Window / Close Workspace / Focus Terminal / Reconnect / Reload Panels / Copy / Paste / Find / Find Next / Find Previous / Close Find / Clear Selection / Scroll to Bottom。

## 消息协议（扩展 ⇄ webview）

见 `src/protocol.ts`（设置页另有 `SettingsToWebview`/`SettingsFromWebview` 一对消息）。webview → 扩展：`ready`、`started`、`painted{timings}`、`graphicsLost`、`send{data}`、`event{event}`（herdr-web 的 `status`/`openLink{open}`/`copy`/`requestPaste`/`tabClosed`；`linkHover` 由 webview 自己处理，不发给扩展）、`focus{focused}`、`key{key}`、`themeChanged`、`log{level,text}`。扩展 → webview：`init{config(含 tabId),options}`、`bytes{data}`、`host{event}`（`open`/`closed`/`paste`/`focus`/`command`/`visibility`）、`options{keys,linkHover}`。webview 用 `setState({tabId, paneId})` 供重载后挂接。

链接：
- **Ctrl+点击**（macOS 为 Cmd+点击）打开。
  - 网页链接交给 `vscode.env.openExternal`，所以遵循 VS Code 自己的设置，例如 `workbench.browser.openLocalhostLinks` 会把 localhost 链接交给集成浏览器。
  - 文件在主编辑器组（第一个组，左上）打开到对应行列；如果点击的终端本身就在主编辑器组，就开在它旁边，避免把终端盖住。目录在资源管理器中定位。
- **悬停工具栏**：指针在链接上停 0.5 秒，旁边出现工具栏（样式取 VS Code 悬停框的主题色，由 `terminal.integrated.showLinkHover` 控制，默认开）。
  - 网页链接：**Open in VS Code**、**Open in Browser**、**Copy**。
    - **Open in VS Code** 用 VS Code 的集成浏览器（`workbench.action.browser.open`；没有时用 Simple Browser）。没设置过 `workbench.browser.newTabPlacement` 时，开在终端旁边、专给浏览器用的锁定编辑器组里。
    - **Open in Browser** 总是交给系统浏览器：即使开了 `openLocalhostLinks`，本地扩展宿主也会直接调用系统的打开程序。
  - 路径：**Open**、**Open to the Side**、**Copy**。
- 网页链接只允许 http/https/mailto/ftp。
- **路径查找顺序**：先去掉 `:行[:列]`、展开 `~/`，再依次尝试：
  1. 相对 pane 的工作目录。
  2. 相对每个工作区文件夹。
  3. 在这些目录下按后缀搜索（VS Code 文件搜索，跳过 `node_modules` 和 `.git`；去掉开头的 `./` 和 `@/` 别名；没有扩展名时也匹配 `名字.*` 和 `名字/index.*`）。

  因为 Claude Code 之类的工具在 `cd` 进子目录后，会打印相对那个子目录的路径。只有一个匹配就直接打开；多个匹配时弹出选择列表，离工作目录近的排前面；都找不到时打开 Quick Open 并填好文件名。
- 远端会话的路径链接不在本地打开。

## 已知限制

- 守护进程的 client-shell 端点拒绝在 `surface_active=false` 的连接上执行任何方法（`surface_inactive`），所以元数据连接只读，变更走 JSON API socket（远端走 ssh 上的 `herdr remote-api-bridge`）。
- VS Code 1.132（Electron 42，Linux）里 WebGPU 探测失败，用 WebGL2（ANGLE/OpenGL ES，AMD）；无双源混合，子像素抗锯齿关闭；日志里常见 `Failed to poll device during resize: Timeout`。
- 输入法候选框跟随光标：herdr-web 用的 GPUI 浏览器后端原本把输入法用的隐藏 textarea 固定在左上角（`update_ime_position` 为空），现由 `spike/vendor/gpui-pre-web` 的补丁把它移到光标格上；端到端测试有一项专门检查。
- 图形初始化失败时（WebGPU 和 WebGL2 都起不来，例如无 GPU 且 WebGL2 被拉黑），herdr-web 发出 `error`（`kind: "graphics"`，带具体原因），面板停止连接、不再重连，并弹出错误提示（可点“Reload Panel”重试）；成功时发 `ready`。
- 只吞掉了字母组合键；`Ctrl+数字`、`Ctrl+Tab`、`Ctrl+PageUp/Down`、`Ctrl+=/-` 等仍会同时到达终端和 VS Code。`herdr.editorKeys` 的命令是扩展用 `executeCommand` 执行的，改绑后需同步该设置。
- 远端机器有单元测试（假 ssh / 假 herdr），也有经真实 sshd 的端到端测试，但对端都是本机（环回和 Tailscale 地址），还没连过另一台真实机器。私有 ControlPath 会覆盖用户 ssh 配置里的 ControlPath。
- Windows 命名管道、macOS 快捷键均未测试。
- 一个面板持续刷屏时，其他面板的按键回显从约 4 ms 变成约 20 ms（多等一帧）。独立浏览器、两个浏览器进程分别连接也一样，刷屏的 pane 没人看时则不受影响，所以出在 herdr 服务端的画面调度，客户端无法规避。
- 编辑器字体用 Sarasa 的超级 TTC（830 MB，480 个字体）时，VS Code 自身多占约 2.7 GB 内存（隔离实例实测：同样的 Sarasa Mono SC 用单独的 TTF 安装时基线 844 MB，用超级 TTC 时 3541 MB），与本扩展无关；换成单独的 TTF 安装即可。
