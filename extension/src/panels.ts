// Editor panels for herdr panes. VS Code owns the layout: each panel shows one
// herdr tab that holds a single pane, so herdr's own splits are not used.
import * as vscode from 'vscode';
import { schemeTheme } from './colors/scheme';
import { resolveFonts } from './fonts';
import { normalizeKey } from './keys';
import type { Log } from './log';
import { LOCAL, type Machine, type Machines } from './machines';
import type { AgentStatus } from './model';
import { PanePanel, VIEW_TYPE, type PanelHost, type PanelState } from './panel';
import type { ViewCommand, ViewConfig, WebviewOptions } from './protocol';
import { activeScheme } from './settings';
import type { Target } from './transport';

interface TabCreated {
  tab: { tab_id: string };
  root_pane: { pane_id: string };
}
interface PaneMoved {
  move_result: { pane: { pane_id: string; tab_id: string; workspace_id: string } };
}

export class Panels implements PanelHost, vscode.WebviewPanelSerializer<PanelState>, vscode.Disposable {
  private readonly panels = new Set<PanePanel>();
  private readonly focused = new Set<PanePanel>();
  /** Tabs each panel has seen in a snapshot: only those can be declared gone. */
  private readonly seen = new WeakSet<PanePanel>();
  /** Panels whose pane is moving to another tab: theirs going is no reason to close. */
  private readonly moving = new WeakSet<PanePanel>();
  private lastFocused: PanePanel | undefined;
  private config: Promise<Omit<ViewConfig, 'tabId'>> | undefined;
  readonly extensionUri: vscode.Uri;

  constructor(
    context: vscode.ExtensionContext,
    readonly log: Log,
    private readonly machines: Machines,
  ) {
    this.extensionUri = context.extensionUri;
    context.subscriptions.push(
      machines.onDidChangeModel((machine) => this.refresh(machine)),
      machines.onDidChangeMachines(() => this.refresh()),
    );
  }

  target(machine?: string): Target {
    const found = this.machines.get(machine);
    if (!found) throw new Error(`herdr machine ${machine ?? LOCAL} is not configured`);
    return found.target();
  }

  /** The machine a panel shows a pane of. */
  machineOf(panel: PanePanel): Machine | undefined {
    return this.machines.get(panel.state.machine);
  }

  get retainContextWhenHidden(): boolean {
    return vscode.workspace.getConfiguration('herdr').get<boolean>('retainContextWhenHidden') ?? true;
  }

  // --- PanelHost ----------------------------------------------------------------

  viewConfig(): Promise<Omit<ViewConfig, 'tabId'>> {
    this.config ??= this.loadConfig();
    return this.config;
  }

  private async loadConfig(): Promise<Omit<ViewConfig, 'tabId'>> {
    const terminal = vscode.workspace.getConfiguration('terminal.integrated');
    const editor = vscode.workspace.getConfiguration('editor');
    const fonts = resolveFonts({
      fontFamily: terminal.get<string>('fontFamily') || editor.get<string>('fontFamily') || 'monospace',
      fontSize: terminal.get<number>('fontSize') || editor.get<number>('fontSize') || 14,
      lineHeight: terminal.get<number>('lineHeight') || 1,
      fallbacks: vscode.workspace.getConfiguration('herdr').get<string[]>('fontFallbacks') ?? [],
    });
    this.log.info(
      `fonts: ${JSON.stringify(fonts.family)} + fallbacks ${JSON.stringify(fonts.fallbacks)}, ` +
        `${fonts.fontSize}px / cell ${fonts.cellHeight}px, drawn with the browser's fonts`,
    );
    const scheme = activeScheme();
    if (scheme) this.log.info(`colors: scheme ${JSON.stringify(scheme.name)}`);
    return {
      theme: scheme && schemeTheme(scheme),
      fonts: [],
      family: fonts.family,
      fallbacks: fonts.fallbacks,
      fontSize: fonts.fontSize,
      cellHeight: fonts.cellHeight,
      copyOnSelect: terminal.get<boolean>('copyOnSelection') ?? false,
    };
  }

  webviewOptions(): WebviewOptions {
    return {
      keys: [...this.editorKeys().keys()],
      linkHover: vscode.workspace.getConfiguration('terminal.integrated').get<boolean>('showLinkHover') ?? true,
    };
  }

  /** Canonical key → command, from `herdr.editorKeys`; null or empty entries are dropped. */
  editorKeys(): Map<string, string> {
    const map = new Map<string, string>();
    const setting = vscode.workspace.getConfiguration('herdr').get<Record<string, string | null>>('editorKeys') ?? {};
    for (const [key, command] of Object.entries(setting)) {
      const canonical = normalizeKey(key);
      if (!canonical) this.log.warn(`herdr.editorKeys: cannot parse key ${JSON.stringify(key)}`);
      else if (command) map.set(canonical, command);
    }
    return map;
  }

  /** Per panel, so a late blur from one panel cannot clear the focus of another. */
  focusChanged(panel: PanePanel, focused: boolean): void {
    const before = this.focused.size > 0;
    if (focused) this.lastFocused = panel;
    if (focused) this.focused.add(panel);
    else this.focused.delete(panel);
    if (before === this.focused.size > 0) return;
    this.log.info(`herdr.paneFocused = ${this.focused.size > 0} (${panel.name} ${focused ? 'focused' : 'blurred'})`);
    void vscode.commands.executeCommand('setContext', 'herdr.paneFocused', this.focused.size > 0);
  }

  tabClosed(panel: PanePanel): void {
    panel.panel.dispose();
  }

  status(_panel: PanePanel, text: string): void {
    vscode.window.setStatusBarMessage(`$(terminal) herdr: ${text}`, 5000);
  }

  // --- panels -------------------------------------------------------------------

  /** The panel commands such as Copy act on: the active editor if it is one, else the last focused. */
  current(): PanePanel | undefined {
    const panels = [...this.panels];
    return panels.find((p) => p.panel.active) ?? (this.lastFocused && this.panels.has(this.lastFocused) ? this.lastFocused : undefined);
  }

  /** Tab and pane ids repeat across machines: a panel is found by both. */
  private on(machine: string, panel: PanePanel): boolean {
    return (panel.state.machine ?? LOCAL) === machine;
  }

  byTab(machine: string, tabId: string): PanePanel | undefined {
    return [...this.panels].find((p) => this.on(machine, p) && p.state.tabId === tabId);
  }

  byPane(machine: string, paneId: string): PanePanel | undefined {
    return [...this.panels].find((p) => this.on(machine, p) && p.state.paneId === paneId);
  }

  private machine(id: string): Machine {
    const machine = this.machines.get(id);
    if (!machine) throw new Error(`herdr machine ${id} is not configured`);
    return machine;
  }

  /** Opens a pane in a panel, or reveals the panel already showing its tab. */
  async open(machineId: string, paneId: string, column: vscode.ViewColumn = vscode.ViewColumn.Active, preserveFocus = false): Promise<PanePanel> {
    const machine = this.machine(machineId);
    const info = machine.model.pane(paneId);
    if (!info) throw new Error(`herdr pane ${paneId} not found on ${machine.name}`);
    let tabId = info.pane.tab_id;
    if (info.tabPanes > 1) {
      // Panels show whole tabs: give the pane a tab of its own first.
      const moved = (await machine.request('pane.move', {
        pane_id: paneId,
        destination: { type: 'new_tab', workspace_id: info.pane.workspace_id },
        focus: false,
      })) as PaneMoved;
      tabId = moved.move_result.pane.tab_id;
      this.log.info(`moved pane ${paneId} out of ${info.pane.tab_id} into its own tab ${tabId}`);
    } else {
      // Two views of one tab would fight over its size: reveal instead.
      const existing = this.byTab(machineId, tabId);
      if (existing) {
        existing.panel.reveal(column === vscode.ViewColumn.Active ? undefined : column, preserveFocus);
        return existing;
      }
    }
    return this.create(this.state(machineId, tabId, paneId), info.title, column, preserveFocus);
  }

  /**
   * `pane.move` into a new workspace of its own. herdr gives the pane a new id
   * and tab there; a panel showing it follows instead of closing with the old tab.
   */
  async moveToNewWorkspace(machineId: string, paneId: string): Promise<string> {
    const machine = this.machine(machineId);
    const panel = this.byPane(machineId, paneId);
    if (panel) this.moving.add(panel);
    try {
      const moved = (await machine.request('pane.move', { pane_id: paneId, destination: { type: 'new_workspace' }, focus: false })) as PaneMoved;
      const pane = moved.move_result.pane;
      this.log.info(`moved pane ${paneId} into new workspace ${pane.workspace_id} as ${pane.pane_id} (tab ${pane.tab_id})`);
      if (panel) {
        panel.state = { ...panel.state, tabId: pane.tab_id, paneId: pane.pane_id };
        // Its new tab may not be in a snapshot yet: not gone until it has been seen.
        this.seen.delete(panel);
        panel.load();
      }
      return pane.pane_id;
    } finally {
      if (panel) {
        this.moving.delete(panel);
        this.refreshPanel(panel);
      }
    }
  }

  private state(machine: string, tabId: string, paneId: string): PanelState {
    return machine === LOCAL ? { tabId, paneId } : { tabId, paneId, machine };
  }

  /** `tab.create` in a workspace (the active panel's, else herdr's focused one), then opens it. */
  async newTerminal(machineId: string, workspaceId?: string, column: vscode.ViewColumn = vscode.ViewColumn.Active): Promise<PanePanel> {
    const machine = this.machine(machineId);
    const model = machine.model;
    const current = this.current();
    const workspace =
      workspaceId ??
      (current && this.on(machineId, current) ? model.pane(current.state.paneId)?.pane.workspace_id : undefined) ??
      model.workspaces().find((w) => w.focused)?.workspace_id ??
      model.workspaces()[0]?.workspace_id;
    // A remote machine has no use for this window's folder as a working directory.
    const cwd = machine.local ? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null) : null;
    const created = (
      workspace
        ? await machine.request('tab.create', { workspace_id: workspace, focus: false })
        : await machine.request('workspace.create', { cwd, focus: false })
    ) as TabCreated;
    return this.create(this.state(machineId, created.tab.tab_id, created.root_pane.pane_id), 'Terminal', column, false);
  }

  private create(state: PanelState, title: string, column: vscode.ViewColumn, preserveFocus: boolean): PanePanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      { viewColumn: column, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: this.retainContextWhenHidden,
        localResourceRoots: ['dist', 'media'].map((dir) => vscode.Uri.joinPath(this.extensionUri, dir)),
      },
    );
    return this.attach(panel, state);
  }

  /** Restores a panel after a window reload from the state its webview saved. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PanelState | undefined): Promise<void> {
    if (!state?.tabId) {
      panel.dispose();
      return;
    }
    this.log.info(`reattaching panel to tab ${state.tabId} (pane ${state.paneId}${state.machine ? ` on ${state.machine}` : ''})`);
    this.attach(panel, state);
  }

  private attach(webviewPanel: vscode.WebviewPanel, state: PanelState): PanePanel {
    const panel = new PanePanel(webviewPanel, state, this);
    this.panels.add(panel);
    webviewPanel.onDidDispose(() => {
      // Closing a panel only detaches: the pane keeps running in herdr.
      this.panels.delete(panel);
      this.focusChanged(panel, false);
      if (this.lastFocused === panel) this.lastFocused = undefined;
      panel.dispose();
      this.log.info(`${panel.name}: closed (the pane keeps running)`);
    });
    this.refreshPanel(panel);
    return panel;
  }

  /** Titles and icons follow the session; panels whose tab or machine is gone close. */
  private refresh(machine?: Machine): void {
    for (const panel of [...this.panels]) if (!machine || this.on(machine.id, panel)) this.refreshPanel(panel);
  }

  private refreshPanel(panel: PanePanel): void {
    const machine = this.machineOf(panel);
    if (!machine) {
      this.log.info(`${panel.name}: its machine was removed; closing the panel`);
      panel.panel.dispose();
      return;
    }
    const model = machine.model;
    if (!model.ready) return;
    if (!model.tab(panel.state.tabId)) {
      if (this.seen.has(panel) && !this.moving.has(panel)) {
        this.log.info(`${panel.name}: tab gone from the session; closing the panel`);
        panel.panel.dispose();
      }
      return;
    }
    this.seen.add(panel);
    const info = model.pane(panel.state.paneId) ?? model.paneOfTab(panel.state.tabId);
    if (!info) return;
    if (info.pane.pane_id !== panel.state.paneId) panel.state = { ...panel.state, paneId: info.pane.pane_id };
    const title = machine.local ? info.title : `${info.title} · ${machine.name}`;
    if (panel.panel.title !== title) panel.panel.title = title;
    panel.panel.iconPath = statusIcon(this.extensionUri, info.status);
  }

  command(name: ViewCommand): void {
    this.current()?.command(name);
  }

  async paste(): Promise<void> {
    await this.current()?.paste();
  }

  reconnectAll(): void {
    for (const panel of this.panels) panel.reconnect();
  }

  /** This machine's socket settings changed: its panels connect again. */
  targetChanged(machine: string = LOCAL): void {
    for (const panel of this.panels) if (this.on(machine, panel)) panel.targetChanged();
  }

  optionsChanged(): void {
    for (const panel of this.panels) panel.optionsChanged();
  }

  /** Fonts or appearance changed: reload every panel with a fresh config. */
  reloadAll(): void {
    this.config = undefined;
    for (const panel of this.panels) panel.load();
  }

  dispose(): void {
    for (const panel of this.panels) panel.dispose();
  }
}

export function statusIcon(extensionUri: vscode.Uri, status: AgentStatus): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media', 'status', `${status}.svg`);
}
