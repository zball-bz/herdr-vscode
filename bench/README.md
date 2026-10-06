# VS Code 终端 vs Ghostty（Web）性能基准

对比对象：VS Code 1.132 内置的 xterm.js（`@xterm/xterm` 6.1.0-beta.291 + WebGL addon，与 VS Code 打包版本一致）、
`@gespenst/core` 0.1.2（Ghostty 官方 `ghostty-vt.wasm` + 混合渲染器，可放到 Worker）、
`ghostty-web` 0.4.0（Coder 出品，Ghostty WASM + Canvas 2D）。

## 文件

| 文件 | 测什么 | 在哪跑 |
|---|---|---|
| `ttybench.sh` | 吞吐（cat 语料 + DA1 同步屏障，测到"终端解析完"为止）和 DA1 往返延迟 | **在被测终端里**跑 |
| `ttyanim.py` | 整屏重绘能力：每帧整屏输出 + DA1 等回复，统计帧/秒 | **在被测终端里**跑 |
| `headless-parse.mjs` | 纯解析+状态吞吐（Node，无渲染、无 IPC） | `npm run parse` |
| `render.html` / `render.mjs` | Chrome（真实 GPU）里的渲染成本：主线程时间、渲染进程/GPU 进程 CPU、帧间隔 | `npm run render` |
| `pty-validate.mjs` | 用真实 pty + 无头模拟器跑 `ttybench.sh`，验证方法本身 | `npm run pty -- xterm` |

## 在 VS Code 里对比（推荐流程）

1. 统一条件：同一字体/字号、同一网格（脚本会打印 `grid=列x行`，调整面板大小直到一致）、
   `terminal.integrated.gpuAcceleration: "on"`、scrollback 一致（VS Code 默认 1000）。
2. 分别在这几个终端里运行（标签随意，结果追加到 `~/.cache/ttybench/results.tsv`）：
   ```sh
   bench/ttybench.sh vscode          # VS Code 内置终端
   bench/ttybench.sh ghostty-webview # "Ghostty Terminal: New Terminal"（tobilg.ghostty-terminal）
   bench/ttybench.sh konsole         # 外部原生终端作参照
   bench/ttyanim.py vscode           # 同上，各跑一遍
   column -t ~/.cache/ttybench/results.tsv
   ```
3. 跑 `ttyanim.py` 时同时看 CPU：**Help → Open Process Explorer**。xterm.js 的解析+渲染算在
   `window`，pty 转发算在 `ptyHost`（它还用 `@xterm/headless` 把输出再解析一遍，用于会话恢复）；
   webview 终端的 node-pty 在 `extensionHost`，解析+渲染在 webview 里。
4. 帧级分析：**Help → Toggle Developer Tools → Performance**，录 5 秒 `ttyanim.py`，看主线程
   Scripting / Rendering / Painting 和掉帧。webview 终端用 **Developer: Open Webview Developer Tools** 单独录。
5. 按键到像素的延迟只能从外部测：Typometer（X11）或高速摄像。DA1 往返只覆盖"输出→终端→回复"这一半。

## 本机结果（Ryzen AI MAX+ 395 / Radeon 8060S，Chrome 151 headless + Vulkan，2026-10-06）

纯解析吞吐（MB/s，34 MB 语料，120x40，越大越好）：

| 语料 | xterm.js | Ghostty WASM |
|---|---|---|
| 纯 ASCII | 107 | 731 |
| 每词 24 位色 SGR | 100 | 112 |
| 光标跳转 TUI | 67 | 125 |
| CJK + emoji | 108 | 236 |

渲染成本（DPR 1，同一工作负载下的 CPU 毫秒，越小越好；全部都能 60fps 的场景比 CPU 占用）：

| 负载 | xterm.js WebGL | Gespenst 主线程 | Gespenst Worker（主线程 / 总计） | ghostty-web Canvas2D |
|---|---|---|---|---|
| TUI 整屏重绘 600 帧 | 542（总 830） | 3490（总 4100） | 204 / 5240 | 4937（总 5220） |
| 滚动日志 600 帧 | 559（总 1030） | 1619（总 2240） | 110 / 2200 | 4117（总 4430） |
| 每格换字+前景色 300 帧 | 1195，58 fps | 7033，43 fps | 183 / 5860，60 fps* | — |
| 每格独立前景×背景色 300 帧 | 28321，**7 fps** | 7242，42 fps | 210 / 6150，60 fps* | 6702，45 fps |

\* Worker 模式的 fps 是主线程帧率，Worker 内实际绘制帧率未测（其 CPU 约 18–20 ms/帧，推断会合并帧）。

注意：合成负载、单台高性能机器、Chrome 而非 VS Code 的 Electron；Gespenst/ghostty-web 都很年轻，数字会变。
`ghostty-web` 0.4.0 在 `write('')` 时会抛 `RangeError`（harness 里已绕过）。
