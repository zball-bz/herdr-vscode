// The "Herdr" activity-bar tree: machines → workspaces → panes, without the
// machine level while this machine is the only one. Herdr tabs are not shown:
// each pane normally lives alone in its own tab, which an editor panel shows.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Machine, Machines } from './machines';
import type { AgentStatus, PaneInfo } from './model';
import type { Panels } from './panels';

export type Node =
  | { kind: 'machine'; machine: string }
  | { kind: 'workspace'; machine: string; id: string }
  | { kind: 'pane'; machine: string; id: string };

const STATUS_ICON: Record<AgentStatus, vscode.ThemeIcon> = {
  working: new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue')),
  blocked: new vscode.ThemeIcon('bell-dot', new vscode.ThemeColor('list.warningForeground')),
  done: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
  idle: new vscode.ThemeIcon('circle-outline'),
  unknown: new vscode.ThemeIcon('terminal'),
};

export class SessionTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly machines: Machines,
    private readonly panels: Panels,
  ) {
    this.view = vscode.window.createTreeView('herdr.sessions', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      this.changed,
      machines.onDidChangeModel(() => this.refresh()),
      machines.onDidChangeMachines(() => this.refresh()),
    );
    this.refresh();
  }

  refresh(): void {
    const list = this.machines.list();
    const blocked = list.reduce((sum, machine) => sum + machine.model.blockedAgents(), 0);
    this.view.badge = blocked ? { value: blocked, tooltip: `${blocked} blocked agent${blocked === 1 ? '' : 's'}` } : undefined;
    if (!list.length) this.view.message = 'No herdr machines. Add a remote machine, or turn herdr.localMachine on.';
    else if (this.machines.several) this.view.message = undefined;
    else {
      // This machine alone: its state is the view's.
      const model = list[0].model;
      if (!model.ready) this.view.message = `Not connected: ${model.problem ?? 'connecting…'}`;
      else if (model.problem) this.view.message = `Disconnected (${model.problem}); showing the last known state.`;
      else if (!model.workspaces().length) this.view.message = 'No herdr workspaces. Use + to start a terminal.';
      else this.view.message = undefined;
    }
    this.changed.fire(undefined);
  }

  private workspaces(machine: Machine): Node[] {
    return machine.model.workspaces().map((w) => ({ kind: 'workspace', machine: machine.id, id: w.workspace_id }));
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      if (!this.machines.several) {
        const only = this.machines.list()[0];
        return only ? this.workspaces(only) : [];
      }
      return this.machines.list().map((machine) => ({ kind: 'machine', machine: machine.id }));
    }
    const machine = this.machines.get(node.machine);
    if (!machine) return [];
    if (node.kind === 'machine') return this.workspaces(machine);
    if (node.kind === 'workspace') return machine.model.panes(node.id).map((p) => ({ kind: 'pane', machine: machine.id, id: p.pane.pane_id }));
    return [];
  }

  getParent(node: Node): Node | undefined {
    if (node.kind === 'machine') return undefined;
    if (node.kind === 'workspace') return this.machines.several ? { kind: 'machine', machine: node.machine } : undefined;
    const workspace = this.machines.get(node.machine)?.model.pane(node.id)?.pane.workspace_id;
    return workspace ? { kind: 'workspace', machine: node.machine, id: workspace } : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const machine = this.machines.get(node.machine);
    if (node.kind === 'machine') return machineItem(node.machine, machine);
    const model = machine?.model;
    if (node.kind === 'workspace') {
      const workspace = model?.workspace(node.id);
      const item = new vscode.TreeItem(workspace?.label ?? node.id, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `${node.machine}/workspace:${node.id}`;
      item.contextValue = 'herdrWorkspace';
      const blocked = workspace?.agent_status === 'blocked';
      item.iconPath = new vscode.ThemeIcon(blocked ? 'bell-dot' : 'folder', blocked ? new vscode.ThemeColor('list.warningForeground') : undefined);
      const panes = model?.panes(node.id).length ?? 0;
      item.description = `${panes} pane${panes === 1 ? '' : 's'}`;
      item.tooltip = `${workspace?.label ?? node.id} (${node.id})${workspace?.new_workspace_cwd ? `\n${workspace.new_workspace_cwd}` : ''}`;
      return item;
    }
    const info = model?.pane(node.id);
    const item = new vscode.TreeItem(info?.title ?? node.id, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.machine}/pane:${node.id}`;
    item.contextValue = 'herdrPane';
    if (!info) return item;
    item.iconPath = STATUS_ICON[info.status];
    item.description = describe(info, !!this.panels.byPane(node.machine, node.id));
    item.tooltip = tooltip(info);
    item.command = { command: 'herdr.openPane', title: 'Open', arguments: [node] };
    return item;
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

function machineItem(id: string, machine: Machine | undefined): vscode.TreeItem {
  const item = new vscode.TreeItem(machine?.name ?? id, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `machine:${id}`;
  if (!machine) return item;
  const model = machine.model;
  item.contextValue = machine.local ? 'herdrMachineLocal' : 'herdrMachine';
  const state = !model.ready ? `not connected: ${model.problem ?? 'connecting…'}` : model.problem ? `disconnected: ${model.problem}` : undefined;
  item.iconPath = new vscode.ThemeIcon(
    machine.local ? 'device-desktop' : 'remote',
    state ? new vscode.ThemeColor('list.errorForeground') : undefined,
  );
  item.description = state ?? machine.where();
  const lines = [`**${machine.name}** — ${machine.where()}`];
  if (state) lines.push(state);
  else lines.push(`${model.workspaces().length} workspace(s), ${model.blockedAgents()} blocked agent(s)`);
  const tooltip = new vscode.MarkdownString(lines.join('\n\n'));
  tooltip.isTrusted = false;
  item.tooltip = tooltip;
  return item;
}

function describe(info: PaneInfo, open: boolean): string {
  const cwd = info.pane.foreground_cwd || info.pane.cwd;
  const parts = [];
  if (info.agent) parts.push(info.status);
  if (cwd && path.basename(cwd) !== info.title) parts.push(path.basename(cwd));
  if (open) parts.push('open');
  return parts.join(' · ');
}

function tooltip(info: PaneInfo): vscode.MarkdownString {
  const lines = [`**${info.title}** \`${info.pane.pane_id}\``];
  if (info.agent) lines.push(`Agent: ${info.agent.display_agent ?? info.agent.agent ?? info.agent.name ?? '?'} — ${info.status}`);
  if (info.agent?.terminal_title_stripped) lines.push(`Title: ${info.agent.terminal_title_stripped}`);
  const cwd = info.pane.foreground_cwd || info.pane.cwd;
  if (cwd) lines.push(`cwd: \`${cwd}\``);
  if (info.tabPanes > 1) lines.push(`Shares herdr tab ${info.pane.tab_id} with ${info.tabPanes - 1} other pane(s); opening moves it to its own tab.`);
  const text = new vscode.MarkdownString(lines.join('\n\n'));
  text.isTrusted = false;
  return text;
}
