// One editor panel = one herdr tab (normally holding one pane) = one daemon
// connection. herdr-web in the webview speaks the client protocol and keeps its
// connection on `tabId`; this side only relays bytes and handles its events.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { openPathLink, openWebLink } from './links';
import type { Log } from './log';
import type { FromWebview, HostEvent, ToWebview, ViewCommand, ViewConfig, ViewEvent, WebviewOptions } from './protocol';
import { Connection, describeTarget, type Target } from './transport';

export const VIEW_TYPE = 'herdr.pane';
const GRAPHICS_RELOAD_INTERVAL_MS = 30_000;

/** What the webview persists for the serializer to reattach after a reload. */
export interface PanelState {
  tabId: string;
  paneId: string;
  /** The machine's id (`machines.ts`); absent for this machine. */
  machine?: string;
}

export interface PanelHost {
  readonly log: Log;
  readonly extensionUri: vscode.Uri;
  readonly retainContextWhenHidden: boolean;
  /** The daemon endpoint of a machine (this one when `machine` is absent). */
  target(machine?: string): Target;
  /** View config without the tab: fonts, sizes, copyOnSelect. */
  viewConfig(): Promise<Omit<ViewConfig, 'tabId'>>;
  editorKeys(): Map<string, string>;
  webviewOptions(): WebviewOptions;
  focusChanged(panel: PanePanel, focused: boolean): void;
  tabClosed(panel: PanePanel): void;
  status(panel: PanePanel, text: string): void;
}

export class PanePanel implements vscode.Disposable {
  private started = false;
  /** Set by `load` until the new page says `ready`: messages meanwhile are the old page's. */
  private replacing = false;
  /** Set when the view reported it cannot run; nothing reconnects until a reload. */
  private failed: string | undefined;
  private pending: Uint8Array[] = [];
  private flushScheduled = false;
  private readonly connection: Connection;
  private readonly disposables: vscode.Disposable[] = [];
  /** performance.now() of the last load, for the reattach measurement. */
  loadedAt = 0;
  /** When a lost GPU context last reloaded the view, to stop a reload loop. */
  private graphicsReloadedAt = -Infinity;
  firstPaintMs: number | undefined;

  constructor(
    readonly panel: vscode.WebviewPanel,
    public state: PanelState,
    private readonly host: PanelHost,
  ) {
    this.connection = new Connection(() => host.target(this.state.machine), {
      open: (target) => {
        host.log.info(`${this.name}: connected to ${describeTarget(target)}`);
        this.postHost({ type: 'open' });
      },
      data: (chunk) => this.queue(chunk),
      closed: (reason) => {
        host.log.warn(`${this.name}: disconnected: ${reason}`);
        // A page being replaced (`load`) would only answer with a stale status.
        if (this.started) this.postHost({ type: 'closed', reason });
      },
    });
    const roots = ['dist', 'media'].map((dir) => vscode.Uri.joinPath(host.extensionUri, dir));
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.iconPath = vscode.Uri.joinPath(host.extensionUri, 'media', 'status', 'unknown.svg');
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: FromWebview) => this.receive(message)),
      panel.onDidChangeViewState(() => this.viewStateChanged()),
    );
    this.load();
  }

  get name(): string {
    const machine = this.state.machine && this.state.machine !== 'local' ? ` on ${this.state.machine}` : '';
    return `panel ${this.state.tabId}${machine}`;
  }

  /** (Re)loads the webview: a new herdr-web instance with current fonts and theme. */
  load(): void {
    this.started = false;
    this.replacing = true;
    this.connection.stop();
    this.failed = undefined;
    this.loadedAt = performance.now();
    this.firstPaintMs = undefined;
    this.panel.webview.html = this.html();
  }

  reconnect(): void {
    if (this.failed) this.load();
    else if (this.started) this.connection.start();
    else this.load();
  }

  targetChanged(): void {
    if (this.started && !this.failed) this.connection.start();
  }

  optionsChanged(): void {
    this.post({ type: 'options', options: this.host.webviewOptions() });
  }

  command(name: ViewCommand): void {
    this.postHost({ type: 'command', name });
  }

  async paste(): Promise<void> {
    const text = await vscode.env.clipboard.readText();
    if (text) this.postHost({ type: 'paste', text });
  }

  dispose(): void {
    this.connection.stop();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private viewStateChanged(): void {
    if (this.host.retainContextWhenHidden) {
      this.postHost({ type: 'visibility', visible: this.panel.visible });
    } else if (!this.panel.visible) {
      // The webview is gone until shown again, when it loads and says `started`.
      this.started = false;
      this.connection.stop();
      this.host.focusChanged(this, false);
    } else if (!this.started) {
      this.loadedAt = performance.now();
      this.firstPaintMs = undefined;
    }
  }

  private async sendInit(): Promise<void> {
    const config = await this.host.viewConfig();
    this.post({ type: 'init', config: { ...config, tabId: this.state.tabId }, options: this.host.webviewOptions() });
  }

  private receive(message: FromWebview): void {
    const log = this.host.log;
    switch (message?.type) {
      case 'ready':
        this.replacing = false;
        this.sendInit().catch((error) => log.error(`${this.name}: init failed: ${error instanceof Error ? error.stack : error}`));
        break;
      case 'started':
        this.started = true;
        if (!this.failed) this.connection.start();
        if (!this.panel.visible && this.host.retainContextWhenHidden) this.postHost({ type: 'visibility', visible: false });
        break;
      case 'painted':
        if (this.firstPaintMs === undefined) {
          this.firstPaintMs = performance.now() - this.loadedAt;
          const steps = Object.entries(message.timings ?? {})
            .map(([step, ms]) => `${step} ${ms}`)
            .join(', ');
          log.info(`${this.name}: first paint ${this.firstPaintMs.toFixed(0)} ms after load${steps ? ` (webview ms: ${steps})` : ''}`);
        }
        break;
      case 'send':
        if (message.data instanceof Uint8Array) this.connection.write(message.data);
        break;
      case 'event':
        if (this.replacing) break;
        this.viewEvent(message.event).catch((error) => log.error(`${this.name}: event ${message.event?.type}: ${error}`));
        break;
      case 'focus':
        this.host.focusChanged(this, message.focused === true);
        break;
      case 'key': {
        const command = this.host.editorKeys().get(message.key);
        if (command) {
          Promise.resolve(vscode.commands.executeCommand(command)).catch((error) => log.error(`${message.key} → ${command}: ${error}`));
        }
        break;
      }
      case 'themeChanged':
        log.info(`${this.name}: theme changed, reloading`);
        this.load();
        break;
      case 'graphicsLost':
        // Drivers reset and GPU processes restart; a fresh view gets a new
        // context. A second loss soon after means it keeps failing: say so.
        if (performance.now() - this.graphicsReloadedAt > GRAPHICS_RELOAD_INTERVAL_MS) {
          log.warn(`${this.name}: GPU context lost, reloading the view`);
          this.graphicsReloadedAt = performance.now();
          this.load();
        } else {
          this.viewEvent({ type: 'error', kind: 'graphics', text: 'the GPU context was lost again right after a reload' }).catch(() => {});
        }
        break;
      case 'log':
        log.webview(message.level, `${this.state.tabId}: ${String(message.text)}`);
        break;
    }
  }

  private async viewEvent(event: ViewEvent): Promise<void> {
    const log = this.host.log;
    switch (event?.type) {
      case 'status':
        log.info(`${this.name}: status: ${event.text}`);
        this.host.status(this, event.text);
        break;
      case 'copy':
        if (typeof event.text === 'string') {
          await vscode.env.clipboard.writeText(event.text);
          log.info(`${this.name}: copied ${event.text.length} characters`);
        }
        break;
      case 'requestPaste':
        await this.paste();
        break;
      case 'ready':
        log.info(`${this.name}: graphics started`);
        break;
      case 'error': {
        // Retrying cannot help (the daemon would drop a connection that never
        // says hello): stop, and say why instead of showing a blank panel.
        this.failed = event.text;
        this.connection.stop();
        log.error(`${this.name}: ${event.kind} error: ${event.text}`);
        this.host.status(this, `herdr view unavailable: ${event.kind}`);
        const reload = 'Reload Panel';
        const choice = await vscode.window.showErrorMessage(`Herdr cannot draw this pane: ${event.text}`, reload);
        if (choice === reload) this.load();
        break;
      }
      case 'tabClosed':
        log.info(`${this.name}: the tab is gone; closing the panel`);
        this.host.tabClosed(this);
        break;
      case 'openLink': {
        if (typeof event.target !== 'string' || !event.target) return;
        const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : null;
        const open = event.open ?? 'follow';
        let result: string;
        if (event.kind === 'web') result = await openWebLink(event.target, open);
        else if (event.kind === 'path') {
          result =
            this.host.target(this.state.machine).kind === 'ssh'
              ? `path links of a remote session are not opened locally: ${event.target}`
              : await openPathLink(event.target, cwd, open, this.panel.viewColumn);
        } else result = `unknown link kind ${event.kind}`;
        log.info(`openLink ${open} ${event.kind} ${event.target} (pane ${event.paneId}, cwd ${cwd}): ${result}`);
        break;
      }
      default:
        log.warn(`${this.name}: unknown herdr-web event ${JSON.stringify(event)}`);
    }
  }

  /** Coalesces daemon chunks that arrive in one turn into one message. */
  private queue(chunk: Uint8Array): void {
    // Copy: socket chunks can be views into a shared pool, and the webview
    // message would carry the whole underlying buffer.
    this.pending.push(new Uint8Array(chunk));
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    if (!this.pending.length) return;
    const chunks = this.pending.splice(0);
    let data = chunks[0];
    if (chunks.length > 1) {
      data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.byteLength;
      }
    }
    this.post({ type: 'bytes', data });
  }

  /** Host events keep their order relative to daemon bytes. */
  private postHost(event: HostEvent): void {
    this.flush();
    this.post({ type: 'host', event });
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const uri = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.host.extensionUri, ...parts)).toString();
    const source = webview.cspSource;
    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      `style-src ${source} 'unsafe-inline'`,
      `connect-src ${source} blob: data:`,
      `font-src ${source} blob: data:`,
      `img-src ${source} blob: data:`,
    ].join('; ');
    const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden;
  background: var(--vscode-terminal-background, var(--vscode-editor-background)); }
body > textarea { pointer-events: none; }
#herdr-linkbar { position: fixed; z-index: 10; display: none; align-items: center; gap: 2px; padding: 2px;
  background: var(--vscode-editorHoverWidget-background); color: var(--vscode-editorHoverWidget-foreground);
  border: 1px solid var(--vscode-editorHoverWidget-border, transparent); border-radius: 4px;
  box-shadow: 0 2px 8px var(--vscode-widget-shadow, transparent);
  font: var(--vscode-font-size)/1.4 var(--vscode-font-family); user-select: none; }
#herdr-linkbar.shown { display: flex; }
#herdr-linkbar button { all: unset; padding: 1px 6px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
#herdr-linkbar button:hover, #herdr-linkbar button:focus-visible { background: var(--vscode-toolbar-hoverBackground); }
#herdr-linkbar .hint { padding: 1px 6px; opacity: 0.7; white-space: nowrap; }
#herdr-message { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-descriptionForeground); }
</style>
</head>
<body data-herdr-js="${uri('media', 'herdr-web', 'herdr_web.js')}" data-herdr-wasm="${uri('media', 'herdr-web', 'herdr_web_bg.wasm')}"
  data-tab-id="${attr(this.state.tabId)}" data-pane-id="${attr(this.state.paneId)}" data-machine="${attr(this.state.machine ?? '')}">
<div id="herdr-message">Loading herdr…</div>
<script type="module" nonce="${nonce}" src="${uri('dist', 'webview.js')}"></script>
</body>
</html>`;
  }
}
