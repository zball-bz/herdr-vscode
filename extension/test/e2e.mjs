// End-to-end test in a real, isolated VS Code against an isolated herdr session.
//
//   HERDR_E2E_DIR=/some/scratch npm run test:e2e
//
// Starts `herdr --session vscspike server` (never the default session), launches
// VS Code with a throwaway --user-data-dir/--extensions-dir/--shared-data-dir
// and the extension under development, drives it over the Chrome DevTools
// protocol (Playwright), and stops/deletes the session at the end. Screenshots,
// logs and results.json go to HERDR_E2E_DIR (default: $TMPDIR/herdr-e2e).
// HERDR_E2E_HOLD=1 sets everything up, opens the tree and keeps running.
// VS Code runs on a private Xvfb display by default, so no window appears on the
// user's desktop and their activity cannot steal its focus (software rendering);
// HERDR_E2E_DISPLAY=desktop uses the current Wayland/X display instead (real GPU).
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import http from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const EXT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DIR = process.env.HERDR_E2E_DIR ?? join(tmpdir(), 'herdr-e2e');
const CODE = process.env.VSCODE_BIN ?? '/usr/share/code/code';
const SESSION = 'vscspike';
const SOCKET = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'herdr', 'sessions', SESSION, 'herdr-client.sock');
const WS = join(DIR, 'workspace');
const USER_DATA = join(DIR, 'user-data');
const SETTINGS = join(USER_DATA, 'User', 'settings.json');
const EXT_LOG = join(DIR, 'extension.log');
const OPENED = join(DIR, 'xdg-open.log');
const results = [];
const consoleLines = [];
let code;
let server;
let browser;
let page;
let xvfb;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (text) => console.log(`[e2e] ${text}`);
function record(name, ok, evidence) {
  results.push({ name, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${evidence ? `\n     ${String(evidence).replace(/\n/g, '\n     ')}` : ''}`);
}
async function until(predicate, timeout = 10000, step = 100) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await predicate().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) return undefined;
    await sleep(step);
  }
}

/** The test's environment, without the VS Code/Electron variables of whatever launched it. */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(VSCODE_|ELECTRON_)/.test(key) || key === 'HERDR_CLIENT_SOCKET_PATH' || key === 'HERDR_SOCKET_PATH') continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

const herdr = (...args) =>
  execFileSync('herdr', ['--session', SESSION, ...args], { env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const herdrJson = (...args) => JSON.parse(herdr(...args)).result;
const paneText = (pane, lines = 30) => herdr('pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines));
const lastLine = (pane) => paneText(pane, 3).trim().split('\n').pop();
const paneIds = () => herdrJson('pane', 'list').panes.map((p) => p.pane_id);
const extLog = () => (existsSync(EXT_LOG) ? readFileSync(EXT_LOG, 'utf8') : '');
const logLines = (pattern) => extLog().split('\n').filter((line) => pattern.test(line));

function writeSettings(extra = {}) {
  const settings = {
    'workbench.startupEditor': 'none',
    'workbench.tips.enabled': false,
    'window.restoreWindows': 'all',
    'window.titleBarStyle': 'custom',
    'window.dialogStyle': 'custom',
    'security.workspace.trust.enabled': false,
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'chat.disableAIFeatures': true,
    'git.enabled': false,
    'workbench.editor.enablePreview': false,
    // HERDR_E2E_FONT mirrors a setup without a terminal font: the editor font
    // (e.g. a face inside a large .ttc such as Sarasa) is what the panels use.
    // HERDR_E2E_RETAIN=0 tears hidden panels down (the setting defaults to keeping them).
    ...(process.env.HERDR_E2E_RETAIN ? { 'herdr.retainContextWhenHidden': process.env.HERDR_E2E_RETAIN !== '0' } : {}),
    ...(process.env.HERDR_E2E_FONT
      ? { 'editor.fontFamily': process.env.HERDR_E2E_FONT, 'editor.fontSize': 16 }
      : { 'terminal.integrated.fontFamily': 'JetBrains Mono', 'terminal.integrated.fontSize': 14 }),
    ...extra,
  };
  writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
}

async function setup() {
  rmSync(DIR, { recursive: true, force: true });
  for (const dir of [DIR, WS, join(WS, 'subdir'), join(USER_DATA, 'User'), join(DIR, 'extensions'), join(DIR, 'bin')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(WS, 'sample.txt'), ['line one', 'line two', 'line three: target', 'line four'].join('\n') + '\n');
  writeFileSync(join(WS, 'subdir', 'inner.txt'), 'inner\n');
  // Printed relative to a subdirectory of the pane's cwd (as Claude Code does
  // after a `cd`), and one name found in two places.
  for (const file of ['subdir/src/store.ts', 'subdir/src/dup.ts', 'nested/deeper/src/dup.ts']) {
    mkdirSync(join(WS, file, '..'), { recursive: true });
    writeFileSync(join(WS, file), `// ${file}\n`);
  }
  // VS Code opens web links through xdg-open: record them instead of starting a browser.
  writeFileSync(join(DIR, 'bin', 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(OPENED)}\n`);
  chmodSync(join(DIR, 'bin', 'xdg-open'), 0o755);
  writeSettings();
  // Context-key probes: each opens the Command Palette only while its `when` holds.
  writeFileSync(
    join(USER_DATA, 'User', 'keybindings.json'),
    JSON.stringify(
      [
        { key: 'ctrl+alt+shift+j', command: 'workbench.action.showCommands', when: 'herdr.paneFocused' },
        { key: 'ctrl+alt+shift+k', command: 'workbench.action.showCommands', when: "activeWebviewPanelId == 'herdr.pane'" },
      ],
      null,
      2,
    ),
  );

  // A previous run's session, if any (only ever the isolated test session).
  for (const verb of ['stop', 'delete']) {
    try {
      execFileSync('herdr', ['session', verb, SESSION], { env: cleanEnv(), stdio: 'ignore' });
    } catch {}
  }
  const out = openSync(join(DIR, 'herdr-server.log'), 'a');
  server = spawn('herdr', ['--session', SESSION, 'server'], { env: cleanEnv(), cwd: WS, stdio: ['ignore', out, out], detached: true });
  if (!(await until(async () => existsSync(SOCKET), 10000))) throw new Error(`herdr server did not create ${SOCKET}`);
  // Workspace 1: alpha and beta share one herdr tab (a split), so opening one moves it out.
  const alpha = herdrJson('workspace', 'create', '--cwd', WS).root_pane.pane_id;
  const beta = herdrJson('pane', 'split', alpha, '--direction', 'right', '--no-focus').pane.pane_id;
  herdr('pane', 'rename', alpha, 'alpha');
  herdr('pane', 'rename', beta, 'beta');
  herdr('workspace', 'create', '--cwd', join(WS, 'subdir'), '--label', 'other', '--no-focus');
  // A blocked agent on alpha: the tree icon and the activity-bar badge.
  herdr('pane', 'report-agent', alpha, '--source', 'vscode-e2e', '--agent', 'claude', '--state', 'blocked');
  log(`herdr session ${SESSION}: alpha ${alpha}, beta ${beta}, socket ${SOCKET}`);
  return { alpha, beta };
}

/** A private X display (Xvfb), or the user's own one with HERDR_E2E_DISPLAY=desktop. */
async function display() {
  if (process.env.HERDR_E2E_DISPLAY === 'desktop') return { args: [], env: {} };
  let number = 90;
  while (existsSync(`/tmp/.X11-unix/X${number}`)) number++;
  xvfb = spawn('Xvfb', [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore', detached: true });
  if (!(await until(async () => existsSync(`/tmp/.X11-unix/X${number}`), 10000))) throw new Error('Xvfb did not start');
  log(`Xvfb :${number}`);
  // No GPU on Xvfb: let WebGL2 fall back to SwiftShader instead of being blocklisted.
  // HERDR_E2E_GPU=1 renders on the real GPU through ANGLE's Vulkan backend instead.
  const gl = process.env.HERDR_E2E_GPU ? ['--use-angle=vulkan'] : ['--enable-unsafe-swiftshader'];
  // HERDR_E2E_SCALE=1.75 runs at a fractional display scale, as on a HiDPI desktop.
  const scale = process.env.HERDR_E2E_SCALE ? [`--force-device-scale-factor=${process.env.HERDR_E2E_SCALE}`] : [];
  return {
    args: ['--ozone-platform=x11', '--ignore-gpu-blocklist', ...gl, ...scale],
    env: { DISPLAY: `:${number}`, WAYLAND_DISPLAY: '', XDG_SESSION_TYPE: 'x11', GDK_BACKEND: 'x11' },
  };
}

async function launchCode() {
  const port = 9300 + Math.floor(Math.random() * 600);
  const screen = await display();
  const out = openSync(join(DIR, 'vscode.log'), 'a');
  code = spawn(
    CODE,
    [
      `--extensionDevelopmentPath=${EXT}`,
      `--user-data-dir=${USER_DATA}`,
      `--extensions-dir=${join(DIR, 'extensions')}`,
      // Keeps VS Code's cross-profile storage (~/.vscode-shared: recently opened, trust) out of the user's home.
      `--shared-data-dir=${join(DIR, 'shared-data')}`,
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-telemetry',
      `--remote-debugging-port=${port}`,
      ...screen.args,
      '--new-window',
      WS,
    ],
    {
      env: cleanEnv({
        ...screen.env,
        HERDR_CLIENT_SOCKET_PATH: SOCKET,
        HERDR_VSCODE_LOG_FILE: EXT_LOG,
        PATH: `${join(DIR, 'bin')}:${process.env.PATH}`,
      }),
      stdio: ['ignore', out, out],
      detached: true,
    },
  );
  writeFileSync(join(DIR, 'cdp-port'), String(port));
  const up = await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 30000, 250);
  if (!up) throw new Error('VS Code did not open its DevTools port');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = await until(async () => browser.contexts()[0]?.pages().find((p) => p.url().includes('workbench')), 30000);
  if (!page) throw new Error('no workbench page');
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  await workbenchReady();
}

/** Waits for the workbench and emulates page focus: the window opens on the user's live
 * desktop, where the compositor may keep focus elsewhere. */
async function workbenchReady() {
  await page.waitForSelector('.monaco-workbench', { timeout: 30000 });
  await page.waitForSelector('.statusbar', { timeout: 30000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await sleep(1500);
}

async function runCommand(title) {
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget:not([style*="display: none"]) input', { timeout: 5000 });
  await page.keyboard.type(title);
  await sleep(500);
  await page.keyboard.press('Enter');
  await sleep(400);
}

const quickInputVisible = () =>
  page.evaluate(() => {
    const widget = document.querySelector('.quick-input-widget');
    return !!widget && getComputedStyle(widget).display !== 'none';
  });

/**
 * Playwright emulates focus only for the main frame; webviews are out-of-process
 * iframes, which would follow the real window focus of the user's desktop.
 */
const emulated = new WeakSet();
async function emulateFocus(frame) {
  for (let f = frame; f && !emulated.has(f); f = f.parentFrame()) {
    emulated.add(f);
    try {
      const session = await page.context().newCDPSession(f);
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {
      /* not an out-of-process frame: its process root gets it */
    }
  }
}

/** herdr webview frames by pane id (frames whose herdr-web has started). */
async function herdrFrames() {
  const frames = {};
  for (const frame of page.frames()) {
    if (!frame.url().startsWith('vscode-webview:')) continue;
    await emulateFocus(frame);
    const info = await frame
      .evaluate(() =>
        typeof window.__herdr === 'object'
          ? { paneId: document.body.dataset.paneId, tabId: document.body.dataset.tabId, machine: document.body.dataset.machine || undefined, paints: window.__herdrPaints ?? 0 }
          : undefined,
      )
      .catch(() => undefined);
    // Pane ids repeat across machines: a remote machine's panels are keyed `pane@machine`.
    if (info) frames[info.machine ? `${info.paneId}@${info.machine}` : info.paneId] = { frame, ...info };
  }
  return frames;
}
const paintedFrame = (paneId, timeout = 30000) =>
  until(
    async () => {
      const entry = (await herdrFrames())[paneId];
      return entry && entry.paints > 0 && (await entry.frame.evaluate(() => window.__herdrPaintedRevision > 0)) ? entry.frame : undefined;
    },
    timeout,
    150,
  );

async function focusFrame(frame) {
  const box = await (await frame.frameElement()).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const focused = await until(() => frame.evaluate(() => document.hasFocus() && document.activeElement?.tagName === 'TEXTAREA'), 2000, 50);
  // VS Code polls webview focus every 250 ms before it activates the editor group,
  // and herdr.paneFocused takes a round trip through the extension host.
  await sleep(400);
  return focused;
}

const treeRows = () =>
  page.evaluate(() => [...document.querySelectorAll('.part.sidebar .monaco-list-row')].map((row) => row.getAttribute('aria-label') ?? row.textContent ?? ''));
const treeRow = (label) => page.locator('.part.sidebar .monaco-list-row', { hasText: label }).first();
const editorTab = (label) => page.locator('.tabs-container .tab', { has: page.locator('.label-name', { hasText: new RegExp(`^${label}$`) }) }).first();
const tabLabels = () => page.evaluate(() => [...document.querySelectorAll('.tabs-container .tab .label-name')].map((e) => e.textContent?.trim()));
const panelVisible = () => page.evaluate(() => !!document.querySelector('.part.panel')?.offsetHeight);
const sidebarVisible = () => page.evaluate(() => !!document.querySelector('.part.sidebar')?.offsetWidth);
const emit = (frame, event) => frame.evaluate((json) => window.__herdr.host.event(json), JSON.stringify(event));

/** Herdr: Close Pane on the active panel; returns the confirmation dialog's text. */
async function closePaneFromPalette() {
  await runCommand('Herdr: Close Pane');
  const dialog = page.locator('.monaco-dialog-box');
  const text = await dialog.innerText({ timeout: 5000 }).catch(() => 'no dialog');
  await dialog.locator('.monaco-button', { hasText: 'Close Pane' }).click({ timeout: 3000 }).catch(() => {});
  return text.replace(/\s+/g, ' ').trim();
}

async function main() {
  const { alpha, beta } = await setup();
  await launchCode();
  const shot = async (name) => {
    await page.screenshot({ path: join(DIR, `${name}.png`) });
    return join(DIR, `${name}.png`);
  };

  // 1. The tree: workspaces → panes, status icons, blocked badge.
  await runCommand('Herdr: Focus on Workspaces View');
  const rows = await until(async () => {
    const r = await treeRows();
    return r.some((t) => t.includes('alpha')) && r.some((t) => t.includes('beta')) && r.some((t) => t.includes('other')) ? r : undefined;
  }, 15000);
  record('tree shows the isolated session: workspaces → panes', !!rows, (rows ?? (await treeRows())).join(' | '));
  const badge = await until(
    () => page.evaluate(() => document.querySelector('.activitybar .badge[aria-label^="Herdr"] .badge-content')?.textContent?.trim()),
    5000,
  );
  record('activity-bar badge counts blocked agents', badge === '1', `badge: ${badge}; ${await shot('shot-1-tree')}`);

  // 2. Open alpha (shares its herdr tab with beta → moved to a tab of its own), beta to the side.
  const t0 = Date.now();
  await (await treeRow('alpha')).click();
  const frameA = await paintedFrame(alpha);
  const moved = logLines(/moved pane .* into its own tab/).pop();
  record('open alpha from the tree: pane.move into its own tab, panel paints', !!frameA && !!moved, `${Date.now() - t0} ms; ${moved}`);
  const rowB = await treeRow('beta');
  await rowB.hover();
  await rowB.locator('.action-label[aria-label="Open Pane to the Side"]').click();
  const frameB = await paintedFrame(beta);
  const groups = await page.evaluate(() => document.querySelectorAll('.editor-group-container').length);
  record('open beta to the side: second panel in a second editor group', !!frameB && groups >= 2, `editor groups: ${groups}; ${await shot('shot-2-side-by-side')}`);
  if (!frameA || !frameB) throw new Error('panels did not start');
  const backend = /Browser graphics initialized successfully with (\S+)/.exec(extLog());
  record('graphics backend reported', !!backend, backend?.[0]);

  // 3. Each panel types into its own pane over its own connection.
  await focusFrame(frameA);
  await page.keyboard.type('echo from-alpha');
  await page.keyboard.press('Enter');
  await focusFrame(frameB);
  await page.keyboard.type('echo from-beta');
  await page.keyboard.press('Enter');
  const separate = await until(async () => {
    const a = paneText(alpha);
    const b = paneText(beta);
    return a.includes('\nfrom-alpha') && b.includes('\nfrom-beta') && !a.includes('from-beta') && !b.includes('from-alpha');
  }, 5000);
  record('typing in each panel reaches its own pane (herdr pane read)', !!separate, `alpha: ${paneText(alpha, 3).trim().split('\n').slice(-2).join(' / ')}\nbeta: ${paneText(beta, 3).trim().split('\n').slice(-2).join(' / ')}`);
  const connections = logLines(/panel w\d+:t\d+: connected to/).length;
  record('one daemon connection per panel, plus the metadata connection', connections >= 2, `${connections} panel connections, ${logLines(/session: connected/).length} session connection(s)`);
  await shot('shot-3-typed');

  // 4. Keys: Ctrl+P stays in the shell; VS Code shortcuts do not fire on consumed keys.
  await focusFrame(frameA);
  await page.keyboard.type('echo history-entry');
  await page.keyboard.press('Enter');
  await sleep(300);
  await page.keyboard.press('Control+p');
  await sleep(600);
  const quickOpen = await quickInputVisible();
  const recalled = await until(async () => /echo history-entry\s*$/.test(lastLine(alpha)), 3000);
  record('ctrl+p inside a panel stays in the shell (history recall, no Quick Open)', !quickOpen && !!recalled, `quick open: ${quickOpen}; prompt: ${JSON.stringify(lastLine(alpha))}`);
  if (quickOpen) await page.keyboard.press('Escape');
  await page.keyboard.press('Control+c');
  const panelBefore = await panelVisible();
  const sidebarBefore = await sidebarVisible();
  await page.keyboard.press('Control+j');
  await page.keyboard.press('Control+b');
  await sleep(500);
  record(
    'ctrl+j / ctrl+b inside a panel reach the shell, not VS Code',
    (await panelVisible()) === panelBefore && (await sidebarVisible()) === sidebarBefore,
    `panel ${panelBefore}→${await panelVisible()}, sidebar ${sidebarBefore}→${await sidebarVisible()}`,
  );
  await page.keyboard.press('Control+c');

  // 5. When-clause candidates: herdr.paneFocused vs activeWebviewPanelId == 'herdr.pane'.
  const probe = async (chord) => {
    await page.keyboard.press(chord);
    await sleep(600);
    const opened = await quickInputVisible();
    if (opened) await page.keyboard.press('Escape');
    await sleep(300);
    return opened;
  };
  await focusFrame(frameA);
  const paneFocusedInPanel = await probe('Control+Alt+Shift+J');
  await focusFrame(frameA);
  const activeIdInPanel = await probe('Control+Alt+Shift+K');
  await runCommand('Herdr: Focus on Workspaces View');
  const paneFocusedInTree = await probe('Control+Alt+Shift+J');
  await runCommand('Herdr: Focus on Workspaces View');
  const activeIdInTree = await probe('Control+Alt+Shift+K');
  record('herdr.paneFocused: true in a panel, false with focus in the tree', paneFocusedInPanel && !paneFocusedInTree, `panel ${paneFocusedInPanel}, tree ${paneFocusedInTree}`);
  record(
    "activeWebviewPanelId == 'herdr.pane' (informational)",
    true,
    `in the panel ${activeIdInPanel}; tree focused while a herdr panel is the active editor ${activeIdInTree}${activeIdInTree ? ' → would swallow keys typed outside the panel' : ''}`,
  );
  await runCommand('Herdr: Focus on Workspaces View');
  const sidebarFromTree = await sidebarVisible();
  await page.keyboard.press('Control+b');
  await sleep(500);
  const toggled = (await sidebarVisible()) !== sidebarFromTree;
  if (toggled) {
    await page.keyboard.press('Control+b');
    await sleep(400);
  }
  record('ctrl+b with focus in the tree still toggles the sidebar (no swallowing outside panels)', toggled, `sidebar ${sidebarFromTree}, toggled ${toggled}`);

  // 6. Clipboard: a synthetic copy event, then Ctrl+Shift+V (requestPaste → paste).
  const clip = `herdr-clip-${Date.now() % 100000}`;
  await frameB.evaluate((text) => window.__herdr.host.event(JSON.stringify({ type: 'copy', text })), clip);
  await until(async () => extLog().includes(`copied ${clip.length} characters`), 3000);
  await focusFrame(frameB);
  await page.keyboard.type('echo pasted:');
  await page.keyboard.press('Control+Shift+V');
  await sleep(400);
  await page.keyboard.press('Enter');
  const pasted = await until(async () => paneText(beta).includes(`\npasted:${clip}`), 4000);
  record('copy event → clipboard; ctrl+shift+v → requestPaste → paste into the shell', !!pasted, lastLine(beta));

  // 6b. A real selection: drag across "hello-select", Ctrl+Shift+C (herdr-web emits
  // `copy`), then paste it back.
  await focusFrame(frameB);
  await page.keyboard.type('clear && echo hello-select');
  await page.keyboard.press('Enter');
  await until(async () => paneText(beta).includes('\nhello-select'), 3000);
  await sleep(800);
  const row = herdr('pane', 'read', beta, '--source', 'visible').split('\n').findIndex((line) => line.trim() === 'hello-select');
  const boxB = await (await frameB.frameElement()).boundingBox();
  const cellWidth = await frameB.evaluate(() => window.__herdrCellWidth);
  const cellHeight = Number(/cell (\d+)px/.exec(extLog())?.[1] ?? 22);
  const y = boxB.y + row * cellHeight + cellHeight / 2;
  await page.mouse.move(boxB.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(boxB.x + cellWidth * 6, y, { steps: 5 });
  await page.mouse.move(boxB.x + cellWidth * 12 - 2, y, { steps: 5 });
  await page.mouse.up();
  await sleep(300);
  await page.keyboard.press('Control+Shift+C');
  const copied = await until(async () => logLines(/copied 12 characters/).length > 0, 3000);
  await page.keyboard.type('echo sel:');
  await page.keyboard.press('Control+Shift+V');
  await sleep(400);
  await page.keyboard.press('Enter');
  const pastedSelection = await until(async () => paneText(beta).includes('\nsel:hello-select'), 4000);
  record('mouse selection + ctrl+shift+c → copy event → clipboard → paste', !!copied && !!pastedSelection, `row ${row}, cell ${cellWidth.toFixed(1)}×${cellHeight}; ${lastLine(beta)}`);

  // 6b'. The platform IME panel anchors on the caret: herdr-web composes in a
  // hidden textarea, which must sit on the cursor cell while composing.
  await focusFrame(frameB);
  await page.keyboard.type('clear');
  await page.keyboard.press('Enter');
  await sleep(500);
  await page.keyboard.type('echo ab');
  await sleep(500);
  // The caret ends the last non-empty row (a long cwd in the prompt wraps it).
  const rowsShown = herdr('pane', 'read', beta, '--source', 'visible').split('\n').map((line) => line.trimEnd());
  let caretRow = rowsShown.length - 1;
  while (caretRow > 0 && !rowsShown[caretRow]) caretRow--;
  const caretCol = rowsShown[caretRow].length;
  const ime = await page.context().newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
  await sleep(500);
  const anchor = await frameB.evaluate(() => {
    const area = document.querySelector('textarea')?.getBoundingClientRect();
    return area && { x: area.x, y: area.y, h: area.height, w: window.__herdrCellWidth, ch: window.__herdrCellHeight };
  });
  await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await page.keyboard.press('Control+U');
  const imeOk =
    !!anchor && Math.abs(anchor.x - caretCol * anchor.w) <= anchor.w / 2 && Math.abs(anchor.y - caretRow * anchor.ch) <= anchor.ch / 2 && anchor.h === anchor.ch;
  record('IME panel anchors on the caret cell', imeOk, `caret row ${caretRow} col ${caretCol}; textarea ${JSON.stringify(anchor)}`);

  // 6c. Ctrl+F is the shell's forward-char; Ctrl+Shift+F opens the view's find bar (not VS Code Search).
  await focusFrame(frameA);
  await page.keyboard.type('echo abc');
  await page.keyboard.press('Control+a');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+f');
  await page.keyboard.type('X');
  await page.keyboard.press('Enter');
  const forward = await until(async () => paneText(alpha).split('\n').some((line) => line.trim() === 'aXbc'), 4000);
  record('ctrl+f reaches the shell (forward-char)', !!forward, paneText(alpha, 3).trim().split('\n').slice(-2).join(' / '));
  await page.keyboard.press('Control+Shift+F');
  await sleep(700);
  const search = await page.evaluate(() => !!document.querySelector('.search-view')?.offsetParent);
  record("ctrl+shift+f opens the view's find bar, not VS Code Search", !search, `Search view visible: ${search}; ${await shot('shot-3b-find')}`);
  await runCommand('Herdr: Close Find');
  await page.keyboard.press('F1');
  await sleep(300);
  await page.keyboard.type('Herdr: Find');
  await sleep(600);
  const findRow = await page.evaluate(() =>
    [...document.querySelectorAll('.quick-input-list .monaco-list-row')].map((r) => r.textContent ?? '').find((t) => /Herdr: Find(?! Next| Previous)/.test(t)),
  );
  await page.keyboard.press('Escape');
  record('Command Palette shows Ctrl+Shift+F for "Herdr: Find"', /Ctrl\+Shift\+F/i.test(findRow ?? ''), findRow);

  // 7. Links, as herdr-web emits them. From beta (the right group), a file opens
  // in the main editor group, where it covers alpha.
  const mainGroupTab = () => page.evaluate(() => document.querySelector('.editor-group-container .tab.active')?.textContent?.trim() ?? '');
  await focusFrame(frameB);
  await emit(frameB, { type: 'openLink', kind: 'path', target: 'sample.txt:3:5', paneId: beta, cwd: WS });
  const opened = await until(async () => {
    const position = await page.evaluate(() => document.querySelector('[id="status.editor.selection"]')?.textContent?.trim() ?? '');
    const tab = await mainGroupTab();
    return tab.includes('sample.txt') && /Ln 3, Col 5/.test(position) ? `${tab} @ ${position}` : '';
  }, 5000);
  record('openLink path:line:col opens the file there, in the main editor group', !!opened, opened || logLines(/openLink/).pop());
  await emit(frameB, { type: 'openLink', kind: 'web', target: 'https://code.visualstudio.com/herdr-e2e', cwd: null });
  const external = await until(async () => existsSync(OPENED) && readFileSync(OPENED, 'utf8').includes('herdr-e2e'), 5000);
  record('openLink web → openExternal (xdg-open stub)', !!external, existsSync(OPENED) ? readFileSync(OPENED, 'utf8').trim() : 'not called');

  // 7b. A path printed relative to a subdirectory is found by searching under the cwd.
  await emit(frameB, { type: 'openLink', kind: 'path', target: 'src/store.ts', paneId: beta, cwd: WS });
  const searched = await until(async () => (await mainGroupTab()).includes('store.ts'), 5000);
  record('openLink path relative to a subdirectory: found under the cwd and opened', !!searched, logLines(/openLink .*src\/store\.ts/).pop());
  await emit(frameB, { type: 'openLink', kind: 'path', target: 'src/dup.ts', paneId: beta, cwd: WS });
  const choices = await until(
    () =>
      page.evaluate(() => {
        const widget = document.querySelector('.quick-input-widget');
        if (!widget || getComputedStyle(widget).display === 'none') return undefined;
        if (!/files match/.test(widget.querySelector('input')?.getAttribute('placeholder') ?? '')) return undefined;
        return [...widget.querySelectorAll('.quick-input-list .monaco-list-row')].map((row) => row.textContent?.trim()).filter(Boolean);
      }),
    5000,
  );
  await page.keyboard.press('Escape');
  record('an ambiguous path offers its matches, nearest first', choices?.length === 2 && /subdir/.test(choices[0]), JSON.stringify(choices));

  // 7c. The hover toolbar over links in beta (visible in its own group).
  const pageServer = http.createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>herdr-e2e-page</title>e2e'));
  await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/e2e`;
  await focusFrame(frameB);
  await page.keyboard.type(`clear && echo ${pageUrl} && echo subdir/inner.txt`);
  await page.keyboard.press('Enter');
  await until(async () => paneText(beta).includes('\nsubdir/inner.txt'), 3000);
  await sleep(600);
  const shownRows = herdr('pane', 'read', beta, '--source', 'visible').split('\n');
  const linkCell = await frameB.evaluate(() => ({ width: window.__herdrCellWidth, height: window.__herdrCellHeight }));
  const hoverRow = async (text) => {
    const at = shownRows.findIndex((line) => line.trim() === text);
    // Read again each time: a group opened beside beta narrows it.
    const boxLinks = await (await frameB.frameElement()).boundingBox();
    await page.mouse.move(boxLinks.x + 1, boxLinks.y + 1);
    await page.mouse.move(boxLinks.x + linkCell.width * 3.5, boxLinks.y + (at + 0.5) * linkCell.height, { steps: 3 });
    return frameB.locator('#herdr-linkbar.shown').waitFor({ timeout: 4000 }).then(() => true, () => false);
  };
  const toolbarClick = (label) => frameB.locator('#herdr-linkbar.shown button', { hasText: label }).click({ timeout: 3000 });
  const webBar = await hoverRow(pageUrl);
  const webButtons = await frameB.locator('#herdr-linkbar button').allTextContents();
  await shot('shot-7c-link-toolbar');
  if (webBar) await toolbarClick('Open in Browser');
  const system = await until(async () => existsSync(OPENED) && readFileSync(OPENED, 'utf8').includes(pageUrl), 5000);
  record('hovering a web link shows the toolbar; "Open in Browser" → system browser', webBar && !!system, `buttons ${JSON.stringify(webButtons)}; ${logLines(/openLink external/).pop()}`);
  let side;
  if (await hoverRow('subdir/inner.txt')) {
    const groupsBefore = await page.evaluate(() => document.querySelectorAll('.editor-group-container').length);
    await toolbarClick('Open to the Side');
    side = await until(
      () =>
        page.evaluate(
          (count) =>
            document.querySelectorAll('.editor-group-container').length > count &&
            [...document.querySelectorAll('.tabs-container .tab.active')].some((tab) => tab.textContent?.includes('inner.txt')),
          groupsBefore,
        ),
      5000,
    );
    // Focus is in the opened editor, outside every herdr panel.
    if (side) await page.keyboard.press('Control+W');
  }
  const groupsAfter = await until(() => page.evaluate(() => document.querySelectorAll('.editor-group-container').length === 2 && 2), 3000);
  record('a path\'s "Open to the Side" opens it in a new group', !!side && groupsAfter === 2, `opened beside: ${!!side}; groups after closing it: ${groupsAfter}; ${logLines(/openLink side/).pop()}`);
  let integrated;
  if (await hoverRow(pageUrl)) {
    await toolbarClick('Open in VS Code');
    integrated = await until(() => page.evaluate(() => [...document.querySelectorAll('.tabs-container .tab')].map((tab) => tab.getAttribute('aria-label') ?? tab.textContent ?? '').find((label) => /herdr-e2e-page|127\.0\.0\.1/.test(label))), 8000);
    await shot('shot-7c-integrated-browser');
    // The tab's own close button: a palette title could match another command.
    if (integrated) {
      const tab = page.locator('.tabs-container .tab[aria-label*="127.0.0.1"]').first();
      await tab.hover();
      await tab.locator('.codicon-close').first().click({ timeout: 3000 }).catch(() => {});
    }
  }
  // Its side group stays, locked for browsers, as VS Code keeps it.
  record('"Open in VS Code" opens the integrated browser beside the panel', !!integrated, `${integrated}; ${logLines(/openLink vscode/).pop()}`);
  pageServer.close();

  // 8. Hide and show a panel: alpha is now behind sample.txt in its group. Kept
  // alive by default (herdr.retainContextWhenHidden); its surface is switched off.
  await sleep(800);
  const keptWhileHidden = !!(await herdrFrames())[alpha];
  const surfaceOff = logLines(/client_shell\.surface\.set|visibility/).length;
  const t1 = Date.now();
  await editorTab('alpha').click();
  const reshown = await paintedFrame(alpha, 15000);
  const reattachMs = Date.now() - t1;
  record(
    'retainContextWhenHidden (default): a hidden panel stays loaded and shows again at once',
    keptWhileHidden && !!reshown && reattachMs < 2000,
    `loaded while hidden: ${keptWhileHidden}; tab click → painted in ${reattachMs} ms; surface log lines ${surfaceOff}`,
  );

  // 8b. A lost GPU context (driver reset, GPU process restart) reloads the view.
  const firstPaints = logLines(/w\d+:t\d+: first paint/).length;
  await reshown.evaluate(() => window.dispatchEvent(new Event('gpui-graphics-lost')));
  const reloaded = await until(async () => logLines(/first paint/).length > firstPaints && (await paintedFrame(alpha, 1000)), 15000, 200);
  record(
    'a lost GPU context reloads the panel, which paints again',
    !!reloaded && logLines(/GPU context lost, reloading/).length === 1,
    logLines(/GPU context lost|first paint/).slice(-2).join('\n'),
  );

  // 9. Rename beta → gamma from the Command Palette (beta's panel active).
  await focusFrame(frameB);
  await runCommand('Herdr: Rename Pane');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('gamma');
  await page.keyboard.press('Enter');
  await runCommand('Herdr: Focus on Workspaces View');
  const renamed = await until(async () => (await tabLabels()).includes('gamma') && (await treeRows()).some((r) => r.includes('gamma')), 5000);
  record('Rename Pane updates the panel title and the tree', !!renamed, `tabs: ${(await tabLabels()).join(', ')}; tree: ${(await treeRows()).map((r) => r.split(',')[0]).join(' | ')}`);

  // 10. New Terminal (tab.create) and Close Pane (terminate) from the palette.
  const before = new Set(paneIds());
  await runCommand('Herdr: New Terminal');
  const fresh = await until(async () => paneIds().find((id) => !before.has(id)), 8000);
  const frameN = fresh && (await paintedFrame(fresh));
  if (frameN) {
    await focusFrame(frameN);
    await page.keyboard.type('echo from-new');
    await page.keyboard.press('Enter');
  }
  const newWorks = fresh && (await until(async () => paneText(fresh).includes('\nfrom-new'), 4000));
  record('New Terminal: tab.create + panel, input reaches the new pane', !!newWorks, `new pane ${fresh}`);
  if (fresh) {
    await focusFrame(frameN);
    const dialog = await closePaneFromPalette();
    const gone = await until(async () => !paneIds().includes(fresh) && !(await herdrFrames())[fresh], 8000);
    record('Close Pane (confirmed) terminates the pane and closes its panel', !!gone, `dialog: "${dialog}"; panes now: ${paneIds().join(', ')}`);
  }

  // 11. retainContextWhenHidden=true for comparison: a new panel, hidden and shown.
  writeSettings({ 'herdr.retainContextWhenHidden': true });
  await sleep(1500);
  const before2 = new Set(paneIds());
  await runCommand('Herdr: New Terminal');
  const kept = await until(async () => paneIds().find((id) => !before2.has(id)), 8000);
  const frameK = kept && (await paintedFrame(kept));
  if (frameK) {
    const title = await page.evaluate(() => document.querySelector('.editor-group-container.active .tab.active .label-name')?.textContent?.trim());
    // Hide it behind a file opened into its own group (links open elsewhere).
    await runCommand('Go to File');
    await page.keyboard.type('inner.txt');
    await sleep(600);
    await page.keyboard.press('Enter');
    await sleep(1000);
    const survived = !!(await herdrFrames())[kept];
    // Hidden, the view asked for no surfaces (client_shell.surface.set active=false);
    // shown again, a fresh surface revision arrives.
    const revisionBefore = await frameK.evaluate(() => window.__herdrRevision);
    const t2 = Date.now();
    await page.locator('.editor-group-container.active .tab', { has: page.locator('.label-name', { hasText: new RegExp(`^${title}$`) }) }).first().click();
    const resumed = await until(() => frameK.evaluate((r) => window.__herdrRevision > r && window.__herdrPaintedRevision === window.__herdrRevision, revisionBefore), 5000, 10);
    record(
      'retainContextWhenHidden=true: the webview survives hiding; showing it resumes surfaces',
      survived && !!resumed,
      `"${title}" kept while hidden: ${survived}; tab click → new surface painted in ${Date.now() - t2} ms`,
    );
    await focusFrame(frameK);
    const dialog = await closePaneFromPalette();
    const gone = await until(async () => !paneIds().includes(kept), 5000);
    if (!gone) record('closing the retained panel\'s pane', false, `dialog: "${dialog}"`);
  }
  writeSettings();
  await sleep(1000);

  // 12. Reload the window: panels reattach to their tabs through the serializer.
  await editorTab('alpha').click();
  await editorTab('gamma').click();
  await sleep(500);
  const tabsBefore = Object.values(await herdrFrames()).map((f) => `${f.paneId}@${f.tabId}`).sort();
  await runCommand('Developer: Reload Window');
  await sleep(3000);
  await workbenchReady();
  const reattached = await until(
    async () => {
      const frames = await herdrFrames();
      return [alpha, beta].every((id) => frames[id]?.paints > 0) ? frames : undefined;
    },
    30000,
    300,
  );
  const tabsAfter = reattached ? Object.values(reattached).map((f) => `${f.paneId}@${f.tabId}`).sort() : [];
  record(
    'after Reload Window both panels reattach to their tabs',
    !!reattached && JSON.stringify(tabsAfter) === JSON.stringify(tabsBefore),
    `before ${tabsBefore.join(', ')}; after ${tabsAfter.join(', ')}; ${logLines(/reattaching panel/).length} reattached; ${await shot('shot-4-after-reload')}`,
  );
  if (reattached) {
    const focusedAfterReload = await focusFrame(reattached[beta].frame);
    if (!focusedAfterReload) log('could not focus the reattached panel');
    await page.keyboard.type('echo after-reload');
    await page.keyboard.press('Enter');
    const typed = await until(async () => paneText(beta).includes('\nafter-reload') && !paneText(alpha).includes('after-reload'), 4000);
    record('input after the reload still reaches the right pane', !!typed, lastLine(beta));
  }
  await shot('shot-5-final');

  // 13. A theme change reloads the panels with the new terminal colors.
  const darkBackground = await reattached?.[alpha]?.frame.evaluate(() => window.__herdr.theme.background);
  writeSettings({ 'workbench.colorTheme': 'Default Light Modern' });
  const light = await until(
    async () => {
      const frame = (await herdrFrames())[alpha];
      const background = await frame?.frame.evaluate(() => window.__herdr?.theme?.background);
      return frame && background !== undefined && background !== darkBackground && frame.paints > 0 ? background : undefined;
    },
    20000,
    300,
  );
  record('theme change reloads panels with the new colors', light !== undefined, `background 0x${darkBackground?.toString(16)} → 0x${light?.toString(16)}; ${await shot('shot-6-light')}`);

  // 14. Settings: import a scheme, optimize it, save it, use it for the panels
  // and for VS Code's own terminal.
  await page.locator('.part.sidebar [aria-label="Settings"]').first().click();
  const settingsFrame = await until(async () => {
    for (const frame of page.frames()) {
      if (await frame.evaluate(() => typeof window.__herdrSettings === 'object').catch(() => false)) return frame;
    }
    return undefined;
  }, 10000);
  record('the gear in the Workspaces view opens Herdr Settings', !!settingsFrame, settingsFrame ? 'webview found' : 'no settings webview');
  if (settingsFrame) {
    // A light scheme whose yellow and cyan are too pale to read on white.
    const fixture = ['[General]', 'Description=fixture', '[Background]', 'Color=255,255,255', '[Foreground]', 'Color=30,30,30']
      .concat(
        ['0,0,0', '205,49,49', '0,188,0', '240,230,140', '4,81,165', '188,5,188', '160,230,230', '85,85,85'].flatMap((color, i) => [`[Color${i}]`, `Color=${color}`, `[Color${i}Intense]`, `Color=${color}`]),
      )
      .join('\n');
    await settingsFrame.evaluate((text) => window.__herdrSettings.importText(text, 'e2e_light.colorscheme'), fixture);
    const imported = await until(() => settingsFrame.evaluate(() => window.__herdrSettings.state().selected === 'e2e_light'), 5000);
    await settingsFrame.locator('#optimize').click();
    const proposed = await settingsFrame.evaluate(() => window.__herdrSettings.state().proposal?.changes.filter((change) => change.deltaE > 0).map((change) => change.label));
    await shot('shot-7-settings-optimize');
    await settingsFrame.locator('#apply-proposal').click();
    await settingsFrame.locator('#save').click();
    const savedYellow = await until(async () => {
      const stored = JSON.parse(readFileSync(SETTINGS, 'utf8'))['herdr.colorSchemes']?.find((scheme) => scheme.name === 'e2e_light');
      return stored && stored.palette[3] !== '#f0e68c' ? stored.palette[3] : undefined;
    }, 5000);
    record(
      'settings: import, optimize (only colors that fall short), save',
      !!imported && !!savedYellow && proposed?.includes('Yellow') && !proposed.includes('Foreground'),
      `changed ${JSON.stringify(proposed)}; yellow #f0e68c → ${savedYellow}`,
    );
    await settingsFrame.locator('#use').click();
    const themed = await until(
      async () => {
        const frame = (await herdrFrames())[alpha];
        const theme = await frame?.frame.evaluate(() => window.__herdr?.theme).catch(() => undefined);
        return theme && savedYellow && theme.palette[3] === parseInt(savedYellow.slice(1), 16) && frame.paints > 0 ? theme : undefined;
      },
      20000,
      300,
    );
    record('"Use for herdr panels" reloads the panels with the scheme', !!themed, `yellow 0x${themed?.palette[3]?.toString(16)}; ${await shot('shot-8-scheme-in-use')}`);
    await settingsFrame.locator('button', { hasText: "Use for VS Code's terminal" }).click();
    const customized = await until(async () => JSON.parse(readFileSync(SETTINGS, 'utf8'))['workbench.colorCustomizations']?.['terminal.ansiYellow'], 5000);
    record("\"Use for VS Code's terminal\" writes workbench.colorCustomizations", customized === savedYellow, `terminal.ansiYellow ${customized}`);
    // For the record: the page at full width, its color editor and its preview.
    await page.locator('.tabs-container .tab', { hasText: 'Herdr Settings' }).first().click();
    await settingsFrame.locator('.swatch[data-slot="3"]').click();
    await runCommand('View: Toggle Maximize Editor Group');
    await sleep(800);
    await shot('shot-9-settings-wide');
    await settingsFrame.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(300);
    await shot('shot-10-settings-preview');
  }

  // 15. Remote machines over real SSH (loopback and Tailscale), from the tree.
  await page.keyboard.press('Escape');
  await runCommand('Herdr: Focus on Workspaces View');
  const { run: remote } = await import('./remote.mjs');
  await remote({ page, DIR, sleep, until, log, record, shot, treeRow, herdrFrames, focusFrame, logLines, SETTINGS });
}

const trace = (step) => appendFileSync(join(DIR, 'cleanup.trace'), `${new Date().toISOString()} ${step}\n`);

async function cleanup() {
  trace('cleanup start');
  try {
    // Browser.close quits Electron, but its reply never arrives: do not wait for it.
    const session = await browser?.newBrowserCDPSession();
    await Promise.race([session?.send('Browser.close').catch(() => {}), sleep(3000)]);
  } catch {}
  if (code?.pid) {
    await until(async () => code.exitCode !== null, 5000);
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-code.pid, signal);
      } catch {}
      await sleep(1000);
    }
  }
  trace('VS Code gone');
  for (const verb of ['stop', 'delete']) {
    try {
      execFileSync('herdr', ['session', verb, SESSION], { env: cleanEnv(), stdio: 'ignore' });
    } catch {}
    await sleep(500);
  }
  if (server?.pid) {
    try {
      process.kill(-server.pid, 'SIGKILL');
    } catch {}
  }
  if (xvfb?.pid) {
    try {
      process.kill(-xvfb.pid, 'SIGTERM');
    } catch {}
  }
  trace('session stopped and deleted');
}

if (process.env.HERDR_E2E_PERF) {
  try {
    const { alpha, beta } = await setup();
    await launchCode();
    const { run } = await import('./perf.mjs');
    await run({ page, codePid: code.pid, alpha, beta, DIR, sleep, until, log, runCommand, treeRows, treeRow, editorTab, herdrFrames, paintedFrame, focusFrame, logLines });
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
  process.exit();
}

if (process.env.HERDR_E2E_HOLD) {
  await setup();
  await launchCode();
  await runCommand('Herdr: Focus on Workspaces View');
  console.log(`[e2e] holding; CDP port in ${join(DIR, 'cdp-port')}`);
  await new Promise(() => {});
}

try {
  await main();
} catch (error) {
  record('test run', false, error?.stack ?? String(error));
  try {
    await page?.screenshot({ path: join(DIR, 'shot-failure.png') });
  } catch {}
} finally {
  writeFileSync(join(DIR, 'console.log'), consoleLines.join('\n'));
  writeFileSync(join(DIR, 'results.json'), JSON.stringify(results, null, 2));
  await cleanup();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed; logs and screenshots in ${DIR}`);
  process.exit(failed.length ? 1 : 0);
}
