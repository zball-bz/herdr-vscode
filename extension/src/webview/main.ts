// Webview side: loads herdr-web (WASM), feeds it the daemon bytes the extension
// relays, and reports focus, keys and herdr-web events back. Same role as
// spike/herdr-web/index.html, with postMessage in place of a WebSocket.
import { eventKey } from '../keys';
import type { FromWebview, HostEvent, Theme, ToWebview, ViewConfig, ViewEvent, WebviewOptions } from '../protocol';
import { LinkBar } from './linkbar';
import { readTheme } from './vscodeTheme';

interface HerdrWeb {
  default(options: { module_or_path: string }): Promise<{ memory: WebAssembly.Memory }>;
  run(config: ViewConfig & { theme: Theme }, host: Host): void;
  deliver(bytes: Uint8Array): void;
  host_event(json: string): void;
}

interface Host {
  send(bytes: Uint8Array): void;
  event(json: string): void;
}

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void; setState(state: unknown): void };

const vscode = acquireVsCodeApi();
const post = (message: FromWebview) => vscode.postMessage(message);
/** Load milestones in ms since the webview started loading, for the `painted` report. */
const timings: Record<string, number> = { script: Math.round(performance.now()) };
const mark = (name: string) => (timings[name] = Math.round(performance.now()));

forwardConsole();

const { herdrJs, herdrWasm, tabId, paneId, machine } = document.body.dataset;
// What the extension's WebviewPanelSerializer gets back after a window reload.
vscode.setState({ tabId, paneId, machine: machine || undefined });
const loaded: Promise<HerdrWeb> = (async () => {
  const module = (await import(herdrJs!)) as HerdrWeb;
  const { memory } = await module.default({ module_or_path: herdrWasm! });
  mark('wasm');
  // For diagnostics: the WASM heap, which holds the fonts and glyph atlas.
  Object.assign(window, { __herdrWasmBytes: () => memory.buffer.byteLength });
  return module;
})();
loaded.catch((error) => {
  showMessage(`herdr-web failed to load: ${error}`);
  console.error('herdr-web failed to load', error);
});

let web: HerdrWeb | undefined;
let keys = new Set<string>();
const linkBar = new LinkBar((link, action) =>
  post({ type: 'event', event: action === 'copy' ? { type: 'copy', text: link.target } : { type: 'openLink', open: action, ...link } }),
);
let focused = false;
const backlog: ToWebview[] = [];

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message?.type) {
    case 'init':
      mark('init');
      start(message.config, message.options).catch((error) => {
        showMessage(`herdr-web failed to start: ${error}`);
        console.error('herdr-web failed to start', error);
      });
      break;
    case 'options':
      applyOptions(message.options);
      break;
    default:
      if (web) dispatch(web, message);
      else backlog.push(message);
  }
});

// The WASM compiles meanwhile; the extension answers with fonts and keys.
post({ type: 'ready' });

function dispatch(module: HerdrWeb, message: ToWebview): void {
  if (message.type === 'bytes') module.deliver(message.data);
  else if (message.type === 'host') module.host_event(JSON.stringify(message.event));
}

function applyOptions(options: WebviewOptions): void {
  keys = new Set(options.keys);
  linkBar.enabled = options.linkHover;
  if (!options.linkHover) linkBar.hide();
}

async function start(config: ViewConfig, options: WebviewOptions): Promise<void> {
  applyOptions(options);
  const module = await loaded;
  const theme = config.theme ?? readTheme();
  // The page shows the terminal's background before the first paint.
  if (config.theme) document.documentElement.style.background = document.body.style.background = `#${theme.background?.toString(16).padStart(6, '0')}`;
  const host: Host = {
    send: (bytes) => post({ type: 'send', data: bytes }),
    event: (json) => {
      try {
        const event = JSON.parse(json) as ViewEvent;
        // The toolbar is the webview's own; the extension sees what it opens.
        if (event.type === 'linkHover') linkBar.hover(event);
        else post({ type: 'event', event });
      } catch {
        console.warn(`herdr-web sent a malformed event: ${json}`);
      }
    },
  };
  document.getElementById('herdr-message')?.remove();
  module.run({ ...config, theme }, host);
  mark('run');
  web = module;
  // For tests and debugging: inject events as herdr-web or the editor would.
  Object.assign(window, {
    __herdr: { host, hostEvent: (event: HostEvent) => module.host_event(JSON.stringify(event)), theme },
  });
  for (const message of backlog.splice(0)) dispatch(module, message);
  post({ type: 'started' });
  if (document.hasFocus()) reportFocus(true);
  if (!config.theme) watchTheme(JSON.stringify(theme));
  reportFirstPaint();
}

/** herdr-web counts its paints in `__herdrPaints`; tell the extension about the first one. */
function reportFirstPaint(): void {
  const check = () => {
    if (((window as { __herdrPaints?: number }).__herdrPaints ?? 0) > 0) {
      mark('painted');
      post({ type: 'painted', timings });
    } else requestAnimationFrame(check);
  };
  requestAnimationFrame(check);
}

// --- focus ----------------------------------------------------------------------

function reportFocus(value: boolean): void {
  if (focused === value) return;
  focused = value;
  post({ type: 'focus', focused: value });
  web?.host_event(JSON.stringify({ type: 'focus', focused: value }));
}

/** GPUI reads keys and IME input from its hidden textarea; keep it focused. */
function focusInput(): void {
  const input = document.querySelector<HTMLTextAreaElement>('body > textarea');
  if (input && document.activeElement !== input) input.focus({ preventScroll: true });
}

window.addEventListener('focus', () => {
  reportFocus(true);
  focusInput();
});
window.addEventListener('blur', () => reportFocus(false));
// Dispatched by the patched GPUI web backend when its GPU context is gone.
window.addEventListener('gpui-graphics-lost', () => post({ type: 'graphicsLost' }));
// Focus/blur events on this nested frame are not always delivered (VS Code moves
// focus between its own iframe layers), so also re-check on input and poll, as
// VS Code's webview host itself does every 250 ms.
const checkFocus = () => reportFocus(document.hasFocus());
for (const type of ['focusin', 'pointerdown', 'keydown']) window.addEventListener(type, checkFocus, true);
setInterval(checkFocus, 250);

// --- keys and clipboard ---------------------------------------------------------

// Capture phase on window runs before GPUI's listener on its textarea. A key in
// herdr.editorKeys reaches neither the terminal nor VS Code's own forwarding
// (which listens on window in the bubble phase); the extension runs its command.
window.addEventListener(
  'keydown',
  (event) => {
    if (!keys.size || event.isComposing) return;
    const key = eventKey(event);
    if (!key || !keys.has(key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    post({ type: 'key', key });
  },
  true,
);

// A native paste (VS Code's Edit > Paste, Shift+Insert) goes to the terminal as
// a bracketed paste; GPUI's own handler needs an input handler herdr-web lacks.
window.addEventListener(
  'paste',
  (event) => {
    const text = event.clipboardData?.getData('text/plain');
    if (!text || !web) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    web.host_event(JSON.stringify({ type: 'paste', text }));
  },
  true,
);

// --- theme ----------------------------------------------------------------------

/** herdr-web cannot change its theme after `run`; the extension reloads the view instead. */
function watchTheme(current: string): void {
  let timer: number | undefined;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (JSON.stringify(readTheme()) === current) return;
      observer.disconnect();
      post({ type: 'themeChanged' });
    }, 150);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
}

// --- diagnostics ----------------------------------------------------------------

function showMessage(text: string): void {
  let element = document.getElementById('herdr-message');
  if (!element) {
    element = document.createElement('div');
    element.id = 'herdr-message';
    document.body.append(element);
  }
  element.textContent = text;
}

/** GPUI and herdr-web log to the console; mirror it into the "Herdr" output channel. */
function forwardConsole(): void {
  let budget = 2000;
  const send = (level: 'log' | 'info' | 'warn' | 'error', text: string) => {
    if (budget-- > 0) post({ type: 'log', level, text: text.slice(0, 4000) });
  };
  const format = (value: unknown) =>
    value instanceof Error ? `${value.message}\n${value.stack ?? ''}` : typeof value === 'string' ? value : safeJson(value);
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      send(level, args.map(format).join(' '));
    };
  }
  window.addEventListener('error', (event) => send('error', `${event.message} (${event.filename}:${event.lineno})`));
  window.addEventListener('unhandledrejection', (event) => send('error', `unhandled rejection: ${format(event.reason)}`));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
