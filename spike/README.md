# herdr 客户端 WASM 核心 spike

`herdr-core/` 是一个不做 IO 的 gen1 端点客户端核心（Rust → wasm32），复用 herdr-gpui 的 `herdr-protocol`（Apache-2.0，固定 rev）。
宿主负责 socket；核心负责分帧、握手校验、快照、surface（full / patch / delta / reuse）和单元格导出。

```sh
# 构建（需要 rustup target add wasm32-unknown-unknown 和 wasm-bindgen-cli 0.2.129）
cd herdr-core && cargo build --release --target wasm32-unknown-unknown \
  && wasm-bindgen --target nodejs --out-dir pkg target/wasm32-unknown-unknown/release/herdr_core.wasm

# 在隔离会话上跑（不要连 default 会话：客户端会向服务端声明自己的 surface 尺寸，可能影响 pane 布局）
herdr --session wasmspike server &
herdr --session wasmspike workspace create --cwd /tmp
node run.mjs ~/.config/herdr/sessions/wasmspike/herdr-client.sock
herdr session stop wasmspike && herdr session delete wasmspike
```

导出格式：每个单元格 4 个 u32 `[symbol, fg, bg, flags]`。symbol 是码点，或 `0x80000000 | id`（多码点字素，见
`take_new_symbols()`）；颜色沿用 herdr 的打包（高字节 0 = 命名色、1 = 256 色索引、2 = RGB）；flags 低 16 位是
ratatui 修饰位，bit16 = skip，bit17 = 超链接。

## 结果（2026-10-06，herdr 0.9.1，本机 unix socket，120x40）

| 项目 | 结果 |
|---|---|
| WASM 体积 | 664 KB，gzip 185 KB（未跑 wasm-opt） |
| 握手到首个完整 surface | 8 ms（热启动）；新会话首次约 240 ms |
| `seq 1 200000`（约 1.3 MB 输出） | 只收到 5–6 条更新、10–17 KB：服务端同步的是屏幕状态 |
| 整屏重绘压力（pane 里跑 ttyanim.py） | 服务端约 57 次更新/秒，平均 47.6 KB/条，约 2.6 MB/s |
| 按键 → patch（含 shell 回显） | p50 0.29 ms，p95 0.69 ms |
| WASM 解码 + 应用（Node） | 217 MB/s；最重的整屏 patch 约 190 µs/条 |
| 导出单元格（只导出脏行） | 22–40 µs/次 |

herdr 0.9.1 没有声明 `surface_scroll` 能力，所以滚动文本是按整行 patch 发送的。

## gpui-web-hello：GPUI 能否跑在浏览器里

herdr-gpui 用的 `gpui-pre` 0.3.6 自带浏览器后端 `gpui-pre-web`（Zed 的 `gpui_web` 快照）。

- 默认特性 `multithreaded` 需要 nightly（`wasm_thread`），而且依赖 SharedArrayBuffer，VS Code webview 没有这个。
  直接依赖 `gpui-pre-web` 并设置 `default-features = false`，再用 `WebPlatform::new(false)` 走单线程即可，稳定版 Rust 能编过（release 构建约 50 s）。
- 体积：8.9 MB，gzip 后 2.9 MB（`opt-level = "s"`，未跑 wasm-opt）。
- Chrome 151 实测：选中 WebGPU，`init()` 42 ms，打包的 JetBrains Mono 文字和背景色都正常绘制（`shot.png`）。

```sh
cd gpui-web-hello && cargo build --release --target wasm32-unknown-unknown \
  && wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/gpui_web_hello.wasm \
  && node shot.mjs
```

## 第 1 步：把 herdr-gpui 的终端组件拆成 `herdr-pane-view`（2026-10-06）

代码在 `../herdr-gpui`，分支 `pane-view-split`，**未提交**。基于上游 `22e2394`。

- 新 crate `crates/herdr-pane-view`：`terminal_painter`（绘制、字形缓存、图片、选区/搜索高亮）、`terminal`（几何、
  按键映射、选区、链接检测、分屏、无障碍）、`theme`/`contrast`、`WebUrl`、自己的 `Error`。只依赖 GPUI 和 herdr-protocol，
  **原生和 wasm32 都能编译**。
- 下沉到 herdr-protocol：`TextPoint`/`TextRange`、`SurfaceImage(s)`/`valid_asset`/图片上限；herdr-client 原路径重新导出。
- WASM 适配只有两处：`Instant` 改用 `web-time`；`Url::to_file_path` 在 wasm 上改为百分号解码。
- herdr-gpui 的 `Error` 用 `View(#[from] herdr_pane_view::Error)` 包装，不复制变体；3 个依赖窗口夹具的测试挪回 herdr-gpui。
- 验证：`cargo fmt --check`、`scripts/check-file-size.sh`、`cargo clippy --workspace --all-targets --all-features -D warnings`
  通过；测试总数前后都是 97；pane-view 94 个、protocol、client 测试全过。herdr-gpui 有 21 个 `herdr_settings`/`updater`
  测试失败，在上游原始提交上同样失败（本机环境问题）。本机链接需要 `LIBRARY_PATH` 指向 `libxkbcommon-x11.so` 符号链接。

## herdr-web：浏览器里用 herdr-gpui 的绘制器画真实 herdr 会话

`herdr-web/`：GPUI 浏览器后端（单线程、WebGPU）+ `herdr-pane-view` + `herdr-core`，编进同一个 WASM；`serve.mjs` 把
`/ws` 桥接到 herdr 客户端 socket（在 VS Code 里换成扩展宿主 + postMessage）；字体在运行时由宿主提供。

| 项目 | 结果（Chrome 151，WebGPU，本机） |
|---|---|
| WASM 体积（不含字体） | 12.9 MB，gzip 3.95 MB |
| 打开到首帧 | 199 ms（WASM 初始化 48 ms） |
| 按键 → 画面 | p50 7.7 ms，p95 24 ms |
| 整屏重绘压力 | 约 50 次绘制/秒，主线程 2.0 ms/次，渲染进程 + GPU 进程约 25% 个核 |
| 正确性 | 颜色、粗/斜/下划线/删除线/反色、24 位色、emoji、组合字符、制表符和方块（几何绘制）、CJK 双宽均正确 |

已知问题：
- GPUI 浏览器后端加载 Droid Sans Fallback 会 panic（`RefCell already borrowed`）；Noto Sans CJK SC 正常。
- 文字/输入法输入通道还没接（herdr-gpui 的 `TerminalInputHandler` 尚未拆出），所以非 ASCII 只能靠输入法路径以外的方式进来。
- WebGPU 画布格式与设备首选格式不同，Chrome 提示有一次额外拷贝。

```sh
cd herdr-web && cargo build --release --target wasm32-unknown-unknown \
  && wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/herdr_web.wasm
herdr --session webspike server & herdr --session webspike workspace create --cwd /tmp
node smoke.mjs ~/.config/herdr/sessions/webspike/herdr-client.sock   # 截图在 shot-*.png
herdr session stop webspike && herdr session delete webspike
```

## 图片（Kitty 图形协议 / TGP）

整条链路都支持：herdr 服务端用 libghostty-vt 解析 Kitty 图形，surface 里带图形场景（资源按 key 只发一次 + 摆放位置），
herdr-gpui 的绘制器（`terminal_painter/images.rs`）负责解码 PNG/RGB/RGBA、缓存、缩放并按 z 序叠放。

herdr-web 原来没显示图片，是因为没保存图片字节、也没把 `PlacedImages` 传给 `paint_frame`。现在 `herdr-core` 移植了
herdr-client 的 `ImageStore`（`src/images.rs`），herdr-web 把图片交给绘制器。`herdr-web/kitty_demo.py` 输出一张 PNG（分块直传，
16x8 格）和一张原始 RGBA 渐变（24x6 格），`images.mjs` 截图验证（`shot-images.png`）：两张都正确，PNG 透明背景正常。

未验证：Unicode 占位符（`U=1`）、动画帧、文件/共享内存传输（`t=f/t/s`）。浏览器里解码走 GPUI 后台执行器，单线程下仍在主线程，
大图可能卡一帧。codex 0.160 的 Kitty/Sixel 支持在 `tui/src/pets/image_protocol.rs`，按终端名识别；pane 里 `TERM_PROGRAM=herdr`，
它是否会启用图片需要实测。

## 共享 pane 组件 `PaneView`（2026-10-06）

`herdr-gpui/crates/herdr-pane-view/src/pane_view*`：一个 GPUI 元素，原生窗口和浏览器画布都能用。

- 绘制（含弹窗、图片、选区与查找高亮、链接下划线、输入法预编辑）。
- 键盘：特殊键与组合键 → 语义按键（按键全上报时补发松开）；文字与输入法经平台输入处理器；
  Cmd/Ctrl+Shift+C 复制、Ctrl+C 在有选区时复制、Cmd/Ctrl+Shift+V 请求粘贴、Ctrl+Shift+F 查找。
  `commit_text_on_key_down`（浏览器宿主打开）：普通字符直接在 keydown 提交——GPUI 浏览器后端走输入处理器的文字会晚一帧
  （实测按键到画面 24 ms 对 8 ms），输入法组合不受影响。
- 鼠标：开启鼠标上报的应用拥有手势（Shift 例外），Cmd/Ctrl+点击打开链接，否则拖选（双击选词、三击选行）；滚轮交给服务端滚动回滚。
- 查找：服务端 `pane.copy_search` 全回滚搜索，命中后 `pane.scroll` 居中；查找/复制模式/选区模型与 herdr-gpui 共用。
- 不持有连接：对外只发 `PaneViewEvent`（Input / Resize / FocusPane / OpenLink / Copy / PasteRequested / Request），宿主喂
  surface、应答和命令。

同时下沉到 herdr-protocol：回滚 API 的请求/结果类型、`RequestFailure`、`decode_scrollback_response`；`find`、`copy_mode`、
回滚几何搬进 pane-view，herdr-gpui 改为导入。herdr-gpui 的窗口胶水仍是自己的（菜单、侧栏、分屏拖拽等），以后可逐步改用 `PaneView`。

验证：pane-view 116 个测试（含 7 个 PaneView 无头测试）；工作区 clippy（所有特性，`-D warnings`）、fmt、1000 行限制、wasm32 通过；
herdr-gpui 除已知 21 个环境相关失败外全部通过。

## herdr-web 宿主接口

`run(config, host)`、`deliver(bytes)`、`host_event(json)`；`host = { send(bytes), event(json) }`。

- 宿主 → WASM：`open`、`closed{reason}`、`paste{text}`、`focus{focused}`、`command{name}`
  （`find|findNext|findPrevious|closeFind|copy|clearSelection`）。
- WASM → 宿主：`status{text}`、`openLink{kind:"web"|"path", target, paneId, cwd}`、`copy{text}`、`requestPaste`。

`interact.mjs` 在真实 herdr 会话上验证 9 项交互（中文提交、输入法预编辑/提交、拖选复制、Ctrl+点击网址与文件路径、查找、
滚轮、鼠标上报），全部通过；`latency.mjs` 对比两条输入路径的延迟。

## 输入法候选框位置与字体（2026-10-06）

- **候选框位置**：GPUI 浏览器后端（`gpui-pre-web` 0.3.6）的 `update_ime_position` 是空实现，输入法用的隐藏 textarea 固定在
  `left:0; top:0`，系统候选框因此总在左上角。`vendor/gpui-pre-web` 里补上了实现（见其 `PATCHES.md`），herdr-web 通过
  `[patch.crates-io]` 使用；`PaneView` 在光标或预编辑变化时调用 `window.invalidate_character_coordinates()`。
  浏览器实测 textarea 落在光标格（第 36 列 × 7 px = 252 px，高 20 = 格高），VS Code 端到端测试也新增了这项检查。
- **字体**（已被下文的浏览器字体取代）：插件按 `fc-match` 给出的集合序号只抽取需要的字体，去掉 TrueType hinting 后缓存；Sarasa 超级 TTC（830 MB、480 个字体）
  里的 Sarasa Mono SC / Sarasa Term SC 每个字重 13–14 MB，四个字重共 55 MB。`HERDR_E2E_FONT='Sarasa Mono SC'` 跑端到端测试 28/28。

## 字形溢出、滚动条、浏览器字体与性能（2026-10-06）

- **溢出的字形**：Sarasa **Mono** SC 把东亚宽度有歧义的字符（`…` `—` `→` `①` 等，终端里占 1 格）画成全角，会盖住下一格。
  - **修复**：`terminal_painter/glyphs.rs` 的 `fitted_size` 把比所占格子宽的字形按比例缩小、在格内居中，同 xterm.js / VS Code 的 `rescaleOverlappingGlyphs`。GPUI 画字形没有变换，所以只能等比缩小，不能只压横向。
  - **字体建议**：终端用 Sarasa **Term** SC，这些字符本身就是半角设计，效果更好。
- **滚动条**：PaneView 的 `pane_view/scrollbar.rs` 移植了 herdr-gpui 的拖动逻辑。
  - **交互**：按在滑块上就从按住的位置拖动，按在轨道上则把滑块跳到指针下。拖动时同一时间只有一个 `pane.scroll` 请求在途，只发最新位置。
  - **外观**：悬停或拖动时滑块变宽变亮（`terminal_painter/scrollbar.rs`）。
  - **重连**：herdr-web 重连时会用失败回复丢弃旧连接的请求，拖动和查找不会卡在"请求在途"状态。
  - **测试**：浏览器测试 `herdr-web/scrollbar.mjs`。
- **浏览器字体**（参考 Gespenst 和 xterm.js 的做法）：在 vendored gpui-pre-web 里，没有字体字节的字体族交给浏览器按名字解析（`text_system/browser.rs`）。
  - **做法**：用 Canvas 按字素测宽并光栅化，字体度量取 `TextMetrics.fontBoundingBox*`。
  - **效果**：画面和加载字体字节时逐像素一致（`shot` 对比：Sarasa Term SC、粗体、斜体、中文粗体、emoji）。
  - **扩展端**：不再读取或传送字体文件，fontconfig 解析、TTC 抽取、去 hinting 的代码都删掉了。
  - **独立测试页**：`serve.mjs` 设 `FONT_FILES=` 为空即可。
- **GPU 上下文丢失**：GPUI 在网页里无法恢复，只打一行日志。补丁会派发一次 `gpui-graphics-lost` 事件，宿主据此重载页面。
- **性能测量**（`herdr-web/perf.mjs` 测独立 Chrome，`extension/test/perf.mjs` 测真实 VS Code，用 `HERDR_E2E_PERF=1`）：
  - **渲染本身不慢**：全屏每帧整屏变化时满 60 帧/s，每帧主线程约 2 ms；按键到回显 p50 约 4 ms；扩展宿主转发只占约 4% CPU。所以 Gespenst 式的 worker + OffscreenCanvas 对这里帮助不大：webview 的主线程只服务这一个视图，而解析在 herdr 服务端。
  - **体感慢的主因是切标签页**：原来隐藏的面板会被销毁，切回时要重建 webview 并重传 55 MB 字体（350–560 ms）。现在默认保活。（2026-10-07 重测：这一项原先靠打开文件把面板挤到后台，链接改为在终端旁边打开后它其实没被隐藏，约 40 ms 不算数。改为在同一组里依次打开 pane 后：保活 p50 51 ms、每个隐藏面板约 24 MB PSS；不保活 p50 298 ms、p95 595 ms。）改用浏览器字体后，每个保活面板的 WASM 堆加 JS 堆从 178 MB 降到 11 MB，扩展宿主也不再缓存字体（省下 130 MB）。
  - **服务端调度**：一个 pane 被查看且持续刷屏时，其他连接的回显要多等一帧（4 → 20 ms）。两个浏览器进程分别连接也一样，刷屏的 pane 没人看时则不受影响，所以出在 herdr 服务端的画面调度。
  - **Sarasa 超级 TTC**：编辑器字体用它（830 MB）时，VS Code 自身多占约 2.7 GB；同一字体用单独的 TTF 安装时没有这个问题。
- **链接悬停与路径查找**：`PaneView` 发出 `LinkHovered`，内容是指针下的链接和它在窗口里的像素范围，按住按键时会撤回；herdr-web 把它转成 `linkHover` 事件。悬停工具栏由宿主自己画：VS Code 插件在 webview 里用 DOM 画，样式取 VS Code 悬停框的主题色。GPUI 的事件只挂在 canvas 上，所以点工具栏不会传到终端。路径链接按 cwd → 工作区文件夹 → 后缀搜索的顺序查找，原因是 Claude Code 在 `cd` 进子目录后打印的路径是相对那个子目录的（真实日志里，打印出来的 `src/api/activity.ts` 实际在工作目录下的一个子项目里）。
- **文字渲染（2026-10-06）**：在 175% 缩放下与 VS Code 自己的终端（xterm.js WebGL）逐像素对比，herdr 的字发虚、偏粗，彩色字和深色主题下尤其明显。原因有三处，都已修正：
  - **格子不在设备像素上**：格宽是字体的 advance（7 px），175% 下是 12.25 个设备像素，每一列的字形落在不同的亚像素相位上，竖笔画时清时糊。现在格宽和行高都取整到设备像素（`terminal_painter::snap_to_device`，原生客户端同样受益），和 xterm.js、Konsole 的做法一样；字形是否超宽仍按字体自己的 advance 判断。
  - **灰度校正做了两遍**：Canvas 光栅化时 Chrome（Skia）已经按填充色的亮度调整过覆盖率，原来却一律用白色画蒙版，GPUI 的着色器再按 gamma 1.8、对比度 1 校正一遍。结果是中间色调和浅色字的边缘覆盖率高出约 30%。现在 `glyph_dilation_for_color` 返回颜色的亮度档（Skia 的 8 档），字形按档缓存并用该档的灰色光栅化；vendored gpui-pre-wgpu 在 wasm 上关掉着色器的校正。加载了字节的字体（swash 的原始覆盖率）改在 CPU 上做原来的校正。
  - **没有次像素抗锯齿**：系统 fontconfig 是 `rgba=rgb`，VS Code 的终端和编辑器都是 LCD 抗锯齿。不透明 Canvas 上 Chrome 会按系统设置画 LCD 字形，按字的亮度选黑或白底读回每个通道的覆盖率；WebGL2 没有双源混合，所以 gpui-pre-wgpu 分两遍画次像素字形（先按覆盖率压暗、再按覆盖率加上字色，`shaders_component_alpha.wgsl`），结果与双源混合相同。系统不做 LCD 抗锯齿时（如 macOS）自动退回灰度。
  - **结果**（175%，Sarasa Term SC 14px，与 xterm 的墨量比）：白底黑字 41.3 / 40.9，深色主题正文 30.8 / 30.7、绿色 27.9 / 28.0，字形位置完全一致。浅色主题的彩色字仍比 xterm 浅，是因为 VS Code 的 `terminal.integrated.minimumContrastRatio` 会把颜色调暗，不是渲染差异。
  - **测量注意**：Playwright 的 `deviceScaleFactor` 模拟下 `devicePixelContentBoxSize` 不随缩放变化，canvas 会按 1.75 倍再被拉伸，不能用来比较分数缩放；要用真实 VS Code 加 `--force-device-scale-factor`（e2e 的 `HERDR_E2E_SCALE=1.75`）。
- **滚动条条带与配色方案（2026-10-06）**：
  - **滚动条**：`PaneView` 在右边缘画了一条 Konsole 风格的滚动条（`pane_view/strip.rs`），由箭头按钮、轨道和滑块组成，按住可连续滚动，Shift+点击跳转。
    - herdr 只在主屏幕为滚动条预留一列，并且一直留着，没有回滚内容时也不例外；备用屏幕会把这一列还给程序。
    - 面板向 herdr 多报一列，让这一列刚好落在条带下面。
  - **配色方案**：VS Code 插件新增设置页（齿轮按钮），可以导入、导出、编辑配色方案，并按可读性自动优化：APCA 测可读性，只改 OKLCH 里的亮度。
    - 一个真实的浅色 Konsole 方案（paletty 导出）在"标准"档已经全部达标；"高"档下彩色会调暗，ΔE 在 0.04–0.13 之间。
