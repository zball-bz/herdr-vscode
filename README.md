# herdr-vscode

把 [herdr](https://github.com/herdrdev/herdr)（终端复用器）的 pane 直接放进 VS Code 编辑器窗口的扩展。

画面用的是 [herdr-gpui](https://github.com/penso/herdr-gpui) 的终端绘制器：编译成 WASM，通过 GPUI 的浏览器后端（WebGL2/WebGPU）在 webview 里渲染。webview 直接使用 herdr 的客户端协议，所以中间不再多一层终端模拟。

- **侧边栏**：按机器 → 工作区 → pane 展示 agent 状态，可以在 Workspaces 视图里添加经 SSH 访问的远端机器。
- **面板**：每个 pane 一个编辑器面板，布局交给 VS Code 管理。
- **交互**：输入法、选区、查找、Ctrl+点击打开链接和文件（带悬停工具栏），图形滚动条，Kitty 图形协议的图片。
- **字体与配色**：使用 VS Code 的终端字体（由浏览器渲染，不传字体文件）；配色方案可以导入、导出，并按可读性自动优化（APCA 测量，OKLCH 调整）。

## 安装

从 [Releases](../../releases) 下载 `herdr-pane-*.vsix`，然后：

```sh
code --install-extension herdr-pane-0.0.4.vsix
```

运行程序的机器上要装 herdr。远端机器还需要 sshd 和免密钥登录，详见 [extension/README.md](extension/README.md#远端机器)。

## 目录

| 目录 | 内容 |
| --- | --- |
| `extension/` | VS Code 扩展（TypeScript）：树、面板、连接（本机 socket / SSH 桥）、设置页与配色、链接 |
| `spike/herdr-web/` | webview 里运行的 WASM：GPUI 浏览器后端 + `herdr-pane-view` + 协议核心 |
| `spike/herdr-core/` | 不依赖 IO 的 herdr 客户端协议核心（扩展宿主用它的 Node 版） |
| `spike/vendor/gpui-pre-web/` | 打过补丁的 GPUI 浏览器后端，补丁见 `PATCHES.md`：浏览器字体及其按亮度、LCD 的光栅化，输入法位置，GPU 上下文丢失通知 |
| `spike/vendor/gpui-pre-wgpu/` | 打过补丁的 GPUI wgpu 渲染器，补丁见 `PATCHES.md`：网页里不重复做文字的 gamma 校正，WebGL2 上分两遍画次像素（LCD）文字 |
| `herdr-gpui/` | [penso/herdr-gpui](https://github.com/penso/herdr-gpui)（连同提交历史导入），把终端组件拆成了原生和浏览器共用的 `herdr-pane-view` crate |
| `bench/` | 终端吞吐、渲染和延迟的测量脚本及结果 |

各阶段的设计、测量和取舍记录在 [spike/README.md](spike/README.md)，扩展的用法和设置在 [extension/README.md](extension/README.md)。

## 构建

需要 Rust（含 `wasm32-unknown-unknown` target）、`wasm-bindgen-cli` 0.2.129（与 Cargo.lock 一致）、Node.js。

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129

(cd spike/herdr-core && cargo build --release --target wasm32-unknown-unknown \
  && wasm-bindgen --target nodejs --out-dir pkg target/wasm32-unknown-unknown/release/herdr_core.wasm)
(cd spike/herdr-web && cargo build --release --target wasm32-unknown-unknown \
  && wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/herdr_web.wasm)

cd extension && npm ci && npm run package   # → herdr-pane-<version>.vsix
```

测试：`npm run test:unit`，以及 `HERDR_E2E_DIR=/tmp/herdr-e2e npm run test:e2e`（在隔离的 Xvfb 和 herdr 会话里驱动真实 VS Code，见 extension/README.md）。

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。第三方部分（herdr-gpui、Zed 的 gpui_web 快照）见 [NOTICE](NOTICE)。
