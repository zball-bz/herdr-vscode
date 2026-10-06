// The settings page: an editor tab that manages herdr's terminal color schemes
// (import, export, edit, readability optimization) and picks the one herdr
// panels use. Schemes live in the `herdr.colorSchemes` setting, so they sync
// with Settings Sync and stay editable in settings.json; `herdr.colorScheme`
// names the one in use ('' follows the VS Code theme).
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { FORMATS, parseSchemes, type SchemeFormat, vscodeColors, writeScheme } from './colors/formats';
import { konsoleSchemes } from './colors/konsole';
import { type ColorScheme, validScheme } from './colors/scheme';
import type { Log } from './log';
import type { SettingsFromWebview, SettingsToWebview } from './protocol';

const config = () => vscode.workspace.getConfiguration('herdr');

export function storedSchemes(): ColorScheme[] {
  const raw = config().get<unknown[]>('colorSchemes') ?? [];
  return (Array.isArray(raw) ? raw : []).map(validScheme).filter((scheme): scheme is ColorScheme => !!scheme);
}

/** The scheme herdr panels use, if one is set and stored. */
export function activeScheme(): ColorScheme | undefined {
  const name = config().get<string>('colorScheme') ?? '';
  return name ? storedSchemes().find((scheme) => scheme.name === name) : undefined;
}

const writeSchemes = (schemes: ColorScheme[]) => config().update('colorSchemes', schemes, vscode.ConfigurationTarget.Global);

/** `name`, or `name (2)`, `name (3)`… when taken. */
function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`)) return `${name} (${n})`;
}

/** The `workbench.colorCustomizations` keys a scheme sets, to remove them again. */
const VS_CODE_KEYS = Object.keys(
  vscodeColors({
    name: '',
    background: '#000000',
    foreground: '#000000',
    cursor: '#000000',
    selection: '#000000',
    palette: Array(16).fill('#000000'),
  }),
);

export class SettingsPanel implements vscode.Disposable {
  private static current: SettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(extensionUri: vscode.Uri, log: Log): void {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('herdr.settings', 'Herdr Settings', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
    });
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'herdr.svg');
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, log);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly log: Log,
  ) {
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((message: SettingsFromWebview) =>
        this.receive(message).catch((error) => {
          log.error(`settings: ${message?.type}: ${error instanceof Error ? error.stack : error}`);
          this.post({ type: 'notice', text: String(error instanceof Error ? error.message : error), error: true });
        }),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('herdr.colorSchemes') || event.affectsConfiguration('herdr.colorScheme')) void this.postState();
      }),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  dispose(): void {
    SettingsPanel.current = undefined;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private post(message: SettingsToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private async postState(): Promise<void> {
    const konsole = (await konsoleSchemes()).map(({ name, current }) => ({ name, current }));
    this.post({ type: 'state', schemes: storedSchemes(), active: config().get<string>('colorScheme') ?? '', konsole });
  }

  /** Adds imported schemes under free names and shows the first. */
  private async add(found: ColorScheme[], from: string): Promise<void> {
    if (!found.length) {
      this.post({ type: 'notice', text: `No complete color scheme in ${from}.`, error: true });
      return;
    }
    const schemes = storedSchemes();
    const taken = new Set(schemes.map((scheme) => scheme.name));
    const added = found.map((scheme) => {
      const name = unique(scheme.name, taken);
      taken.add(name);
      return { ...scheme, name };
    });
    await writeSchemes([...schemes, ...added]);
    this.log.info(`settings: imported ${added.map((scheme) => scheme.name).join(', ')} from ${from}`);
    await this.postState();
    this.post({ type: 'select', name: added[0].name });
    this.post({ type: 'notice', text: `Imported ${added.map((scheme) => `“${scheme.name}”`).join(', ')}.` });
  }

  private async receive(message: SettingsFromWebview): Promise<void> {
    switch (message?.type) {
      case 'ready':
        await this.postState();
        break;
      case 'save': {
        const scheme = validScheme(message.scheme);
        if (!scheme) throw new Error('the scheme needs a name and valid colors');
        const schemes = storedSchemes();
        const replaced = message.previousName ?? scheme.name;
        if (schemes.some((other) => other.name === scheme.name && other.name !== replaced)) throw new Error(`a scheme named “${scheme.name}” exists`);
        const at = schemes.findIndex((other) => other.name === replaced);
        if (at >= 0) schemes[at] = scheme;
        else schemes.push(scheme);
        await writeSchemes(schemes);
        if (message.previousName && message.previousName !== scheme.name && config().get<string>('colorScheme') === message.previousName) {
          await config().update('colorScheme', scheme.name, vscode.ConfigurationTarget.Global);
        }
        this.post({ type: 'select', name: scheme.name });
        break;
      }
      case 'delete': {
        const answer = await vscode.window.showWarningMessage(`Delete the color scheme “${message.name}”?`, { modal: true }, 'Delete');
        if (answer !== 'Delete') return;
        await writeSchemes(storedSchemes().filter((scheme) => scheme.name !== message.name));
        if (config().get<string>('colorScheme') === message.name) await config().update('colorScheme', '', vscode.ConfigurationTarget.Global);
        break;
      }
      case 'activate':
        await config().update('colorScheme', message.name, vscode.ConfigurationTarget.Global);
        this.post({ type: 'notice', text: message.name ? `Herdr panels now use “${message.name}”.` : 'Herdr panels follow the VS Code theme.' });
        break;
      case 'importFile': {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Import',
          title: 'Import terminal color schemes',
          filters: { 'Color schemes': ['colorscheme', 'itermcolors', 'json', 'toml', 'conf', 'Xresources', 'ghostty', '*'] },
        });
        for (const file of files ?? []) await this.add(parseSchemes(await fs.readFile(file.fsPath, 'utf8'), file.fsPath), path.basename(file.fsPath));
        break;
      }
      case 'importText':
        await this.add(parseSchemes(String(message.text), String(message.fileName)), String(message.fileName));
        break;
      case 'importKonsole': {
        const scheme = (await konsoleSchemes()).find((candidate) => candidate.name === message.name);
        if (!scheme) throw new Error(`no Konsole scheme “${message.name}”`);
        await this.add(parseSchemes(await fs.readFile(scheme.file, 'utf8'), scheme.file), scheme.file);
        break;
      }
      case 'export': {
        const scheme = storedSchemes().find((candidate) => candidate.name === message.name);
        const format = FORMATS[message.format];
        if (!scheme || !format) throw new Error('nothing to export');
        const target = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(path.join(os.homedir(), `${scheme.name.replace(/[\\/:*?"<>|]/g, '_')}.${format.extension}`)),
          title: `Export “${scheme.name}” as ${format.label}`,
        });
        if (!target) return;
        await fs.writeFile(target.fsPath, writeScheme(scheme, message.format));
        this.post({ type: 'notice', text: `Exported “${scheme.name}” to ${target.fsPath}.` });
        break;
      }
      case 'applyToVsCode': {
        const scheme = storedSchemes().find((candidate) => candidate.name === message.name);
        if (!scheme) throw new Error(`no scheme “${message.name}”`);
        const workbench = vscode.workspace.getConfiguration('workbench');
        const current = (workbench.inspect<Record<string, unknown>>('colorCustomizations')?.globalValue ?? {}) as Record<string, unknown>;
        await workbench.update('colorCustomizations', { ...current, ...vscodeColors(scheme) }, vscode.ConfigurationTarget.Global);
        this.post({ type: 'notice', text: `VS Code's terminal now uses “${scheme.name}” (workbench.colorCustomizations).` });
        break;
      }
      case 'resetVsCode': {
        const workbench = vscode.workspace.getConfiguration('workbench');
        const current = { ...((workbench.inspect<Record<string, unknown>>('colorCustomizations')?.globalValue ?? {}) as Record<string, unknown>) };
        for (const key of VS_CODE_KEYS) delete current[key];
        await workbench.update('colorCustomizations', Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
        this.post({ type: 'notice', text: "VS Code's terminal follows the color theme again." });
        break;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:herdr.herdr-pane');
        break;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'settings.js'));
    const csp = [`default-src 'none'`, `script-src 'nonce-${nonce}'`, `style-src 'unsafe-inline'`].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Herdr Settings</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app"></div>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

const STYLE = `
:root { color-scheme: light dark; }
body { margin: 0; padding: 16px 20px 32px; overflow-x: hidden; font: var(--vscode-font-size)/1.45 var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
h1 { font-size: 1.6em; font-weight: 600; margin: 0 0 2px; }
h2 { font-size: 1.1em; font-weight: 600; margin: 20px 0 8px; }
.sub { color: var(--vscode-descriptionForeground); margin: 0 0 16px; }
button { font: inherit; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; padding: 3px 10px; cursor: pointer; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button.primary:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
select, input[type=text] { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent)); border-radius: 2px; padding: 3px 6px; }
select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border); }
input[type=range] { width: 100%; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.columns { display: grid; grid-template-columns: minmax(200px, 280px) minmax(0, 1fr); gap: 24px; align-items: start; }
@media (max-width: 760px) { .columns { grid-template-columns: minmax(0, 1fr); } }
.list, .columns > div { min-width: 0; }
.list { border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; padding: 8px; }
.list ul { list-style: none; margin: 8px 0 0; padding: 0; }
.list li { padding: 6px 8px; border-radius: 3px; cursor: pointer; }
.list li:hover { background: var(--vscode-list-hoverBackground); }
.list li.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.list .name { display: flex; justify-content: space-between; gap: 6px; }
.badge { font-size: 0.85em; padding: 0 6px; border-radius: 8px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
.mini { display: flex; height: 10px; margin-top: 4px; border-radius: 2px; overflow: hidden; outline: 1px solid var(--vscode-widget-border, transparent); }
.mini span { flex: 1; }
.drop { margin-top: 8px; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.dragging .list { outline: 2px dashed var(--vscode-focusBorder); }
.grid { display: grid; grid-template-columns: auto repeat(8, minmax(0, 1fr)); gap: 4px; align-items: stretch; }
.grid > .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.9em; }
.grid .label { align-self: center; color: var(--vscode-descriptionForeground); }
.swatch { position: relative; min-width: 0; height: 48px; border-radius: 4px; border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.4)); cursor: pointer; padding: 0; display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; }
.swatch.unset { background: transparent; border-style: dashed; }
.swatch.unset .name { color: var(--vscode-descriptionForeground); }
.swatch.selected { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
.swatch .lc { font-size: 0.75em; padding: 1px 3px; background: rgba(0,0,0,.55); color: #fff; text-align: left; white-space: nowrap; overflow: hidden; }
.swatch .lc.fail { background: var(--vscode-inputValidation-errorBackground, #a1260d); }
.swatch .lock { position: absolute; top: 2px; right: 3px; font-size: 0.75em; }
.roles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; margin-bottom: 8px; }
.roles .swatch { height: 44px; }
.roles .swatch .name { position: absolute; top: 2px; left: 4px; right: 4px; font-size: 0.8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.slot { margin-top: 12px; padding: 10px 12px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 4px; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; align-items: center; }
.slot input[type=range] { flex: 1; min-width: 80px; max-width: 360px; }
.scroll { overflow-x: auto; max-width: 100%; }
.slot .value { font-family: var(--vscode-editor-font-family); }
.muted { color: var(--vscode-descriptionForeground); }
table { border-collapse: collapse; margin-top: 8px; font-size: 0.95em; }
td, th { padding: 2px 8px; text-align: left; }
th { color: var(--vscode-descriptionForeground); font-weight: normal; }
.chip { display: inline-block; width: 14px; height: 14px; border-radius: 2px; vertical-align: -2px; border: 1px solid rgba(128,128,128,.5); }
.pass { color: var(--vscode-testing-iconPassed, #3fb950); }
.fail { color: var(--vscode-testing-iconFailed, #f85149); }
pre.preview { margin: 8px 0 0; padding: 10px 12px; border-radius: 4px; font: var(--vscode-editor-font-size, 13px)/1.35 var(--vscode-editor-font-family); overflow-x: auto; }
.notice { position: fixed; bottom: 16px; right: 24px; max-width: 420px; padding: 8px 12px; border-radius: 4px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
.notice.error { border-color: var(--vscode-inputValidation-errorBorder); }
`;
