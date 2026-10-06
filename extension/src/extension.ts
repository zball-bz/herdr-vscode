import * as vscode from 'vscode';
import { Log } from './log';
import { defaultName, LOCAL, type Machine, machineId, Machines, parseMachines } from './machines';
import { VIEW_TYPE } from './panel';
import { Panels } from './panels';
import type { ViewCommand } from './protocol';
import { activeScheme, SettingsPanel } from './settings';
import { validSessionName } from './socket';
import { probeSsh, validSshTarget } from './transport';
import { SessionTree, type Node } from './tree';

const RELOAD_SETTINGS = [
  'terminal.integrated.fontFamily',
  'terminal.integrated.fontSize',
  'terminal.integrated.lineHeight',
  'terminal.integrated.copyOnSelection',
  'editor.fontFamily',
  'editor.fontSize',
  'herdr.fontFallbacks',
];
/** This machine's daemon endpoint. */
const LOCAL_TARGET_SETTINGS = ['herdr.session', 'herdr.socketPath'];
/** Which machines there are. */
const MACHINE_SETTINGS = ['herdr.machines', 'herdr.localMachine', 'herdr.remote', 'herdr.session'];

export function activate(context: vscode.ExtensionContext): void {
  const log = new Log();
  const machines = new Machines(context.extensionPath, log);
  // Before panels: a restored panel finds its machine, or closes as removed.
  machines.sync();
  const panels = new Panels(context, log, machines);
  let shownScheme = JSON.stringify(activeScheme() ?? null);
  const tree = new SessionTree(machines, panels);
  const status = vscode.window.createStatusBarItem('herdr.status', vscode.StatusBarAlignment.Left, 10);
  status.name = 'Herdr';
  status.command = 'herdr.sessions.focus';
  const updateStatus = () => {
    const list = machines.list();
    const blocked = list.reduce((sum, machine) => sum + machine.model.blockedAgents(), 0);
    const down = list.filter((machine) => machine.model.problem);
    status.text = list.length && down.length === list.length ? '$(debug-disconnect) herdr' : blocked ? `$(terminal) herdr $(bell-dot) ${blocked}` : '$(terminal) herdr';
    const lines = list.map((machine) => `${machine.name}: ${machine.model.problem ?? 'connected'}`);
    status.tooltip = `herdr${blocked ? ` — ${blocked} blocked agent(s)` : ''}\n${lines.join('\n')}`;
    status.show();
  };

  /** Runs a command, showing failures (herdr API errors included) instead of dropping them. */
  const register = <A extends unknown[]>(id: string, run: (...args: A) => unknown) =>
    vscode.commands.registerCommand(id, async (...args: A) => {
      try {
        await run(...args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`${id}: ${message}`);
        void vscode.window.showErrorMessage(`herdr: ${message}`);
      }
    });
  const viewCommand = (name: ViewCommand) => register(`herdr.${name}`, () => panels.command(name));

  const pickMachine = async (): Promise<Machine | undefined> => {
    const list = machines.list();
    if (list.length <= 1) return list[0];
    const picked = await vscode.window.showQuickPick(
      list.map((machine) => ({ label: machine.name, description: machine.where(), detail: machine.model.problem, machine })),
      { placeHolder: 'herdr machine' },
    );
    return picked?.machine;
  };
  /** The machine a command is about: the tree item's, else the active panel's, else a pick. */
  const machineOf = async (node?: Node): Promise<Machine | undefined> => {
    if (node) return machines.get(node.machine);
    const current = panels.current();
    return (current && panels.machineOf(current)) ?? (await pickMachine());
  };
  const pickPane = async (): Promise<{ machine: Machine; id: string } | undefined> => {
    const several = machines.several;
    const items = machines.list().flatMap((machine) =>
      machine.model.workspaces().flatMap((w) =>
        machine.model.panes(w.workspace_id).map((p) => ({
          label: p.title,
          description: `${several ? `${machine.name} · ` : ''}${w.label} · ${p.pane.pane_id}`,
          detail: p.pane.foreground_cwd ?? undefined,
          machine,
          id: p.pane.pane_id,
        })),
      ),
    );
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'herdr pane' });
    return picked && { machine: picked.machine, id: picked.id };
  };
  /** The pane a command is about: the tree item, else the active panel's, else a pick. */
  const paneOf = async (node?: Node): Promise<{ machine: Machine; id: string } | undefined> => {
    if (node?.kind === 'pane') {
      const machine = machines.get(node.machine);
      return machine && { machine, id: node.id };
    }
    const current = panels.current();
    const machine = current && panels.machineOf(current);
    if (current && machine) return { machine, id: current.state.paneId };
    return pickPane();
  };
  /** The workspace a command is about: the tree item's, else (without one) the active panel's. */
  const workspaceOf = (node?: Node): { machine: Machine; id: string } | undefined => {
    if (node) {
      const machine = machines.get(node.machine);
      const id = node.kind === 'workspace' ? node.id : node.kind === 'pane' ? machine?.model.pane(node.id)?.pane.workspace_id : undefined;
      return machine && id ? { machine, id } : undefined;
    }
    const current = panels.current();
    const machine = current && panels.machineOf(current);
    const id = current && machine?.model.pane(current.state.paneId)?.pane.workspace_id;
    return machine && id ? { machine, id } : undefined;
  };
  const newTerminal = async (node: Node | undefined, column?: vscode.ViewColumn) => {
    const workspace = workspaceOf(node);
    const machine = workspace?.machine ?? (await machineOf(node));
    if (machine) await panels.newTerminal(machine.id, workspace?.id, column);
  };

  /** Asks for an ssh target, session and name; checks the login; adds it to herdr.machines. */
  const addMachine = async () => {
    const target = (
      await vscode.window.showInputBox({
        title: 'Add Remote Machine (1/3): SSH target',
        prompt: 'user@host, a Host alias from ~/.ssh/config, or ssh://user@host:port. The login must not ask for a password (use a key or ssh-agent).',
        placeHolder: 'user@devbox',
        ignoreFocusOut: true,
        validateInput: (value) => (!value.trim() || validSshTarget(value.trim()) ? undefined : 'Not an SSH target: no options and no password'),
      })
    )?.trim();
    if (!target) return;
    const session = (
      await vscode.window.showInputBox({
        title: 'Add Remote Machine (2/3): herdr session',
        prompt: 'The herdr session there; it starts when this machine first connects',
        value: 'default',
        ignoreFocusOut: true,
        validateInput: (value) => (validSessionName(value.trim() || 'default') ? undefined : 'Letters, digits, dot, dash and underscore only'),
      })
    )?.trim();
    if (session === undefined) return;
    const name = (
      await vscode.window.showInputBox({ title: 'Add Remote Machine (3/3): name', prompt: 'Its name in the Workspaces view', value: defaultName(target), ignoreFocusOut: true })
    )?.trim();
    if (name === undefined) return;
    const config = vscode.workspace.getConfiguration('herdr');
    const raw = (config.inspect<unknown[]>('machines')?.globalValue ?? []) as unknown[];
    if (parseMachines(raw).some((machine) => machineId(machine.target, machine.session) === machineId(target, session || 'default'))) {
      void vscode.window.showInformationMessage(`herdr: ${target} (session ${session || 'default'}) is already in the list.`);
      return;
    }
    const probe = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `herdr: connecting to ${target}…` }, () =>
      probeSsh(target),
    );
    log.info(`add machine ${target}: ${probe.ok ? 'ok' : 'failed'}: ${probe.detail}${probe.hint ? ` (${probe.hint})` : ''}`);
    if (!probe.ok) {
      const anyway = 'Add Anyway';
      const sentence = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`);
      const choice = await vscode.window.showErrorMessage(sentence(probe.detail), { modal: true, detail: probe.hint && `To fix: ${sentence(probe.hint)}` }, anyway);
      if (choice !== anyway) return;
    }
    await config.update('machines', [...raw, { name: name || defaultName(target), target, session: session || 'default' }], vscode.ConfigurationTarget.Global);
  };

  const removeMachine = async (node?: Node) => {
    const machine = node && machines.get(node.machine);
    if (!machine || machine.local) return;
    const remove = 'Remove';
    const answer = await vscode.window.showWarningMessage(
      `Remove ${machine.name} (${machine.where()}) from herdr?`,
      { modal: true, detail: 'Its panels close; its panes keep running there.' },
      remove,
    );
    if (answer !== remove) return;
    const config = vscode.workspace.getConfiguration('herdr');
    const raw = (config.inspect<unknown[]>('machines')?.globalValue ?? []) as unknown[];
    const kept = raw.filter((entry) => {
      const [parsed] = parseMachines([entry]);
      return !parsed || machineId(parsed.target, parsed.session) !== machine.id;
    });
    await config.update('machines', kept.length ? kept : undefined, vscode.ConfigurationTarget.Global);
    const legacy = config.get<string>('remote')?.trim();
    if (legacy && machineId(legacy, config.get<string>('session') || 'default') === machine.id) {
      await config.update('remote', undefined, vscode.ConfigurationTarget.Global);
    }
  };

  context.subscriptions.push(
    log,
    machines,
    panels,
    tree,
    status,
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, panels),
    register('herdr.openPane', async (node?: Node) => {
      const pane = node?.kind === 'pane' ? await paneOf(node) : await pickPane();
      if (pane) await panels.open(pane.machine.id, pane.id);
    }),
    register('herdr.openPaneToSide', async (node?: Node) => {
      const pane = await paneOf(node);
      if (pane) await panels.open(pane.machine.id, pane.id, vscode.ViewColumn.Beside);
    }),
    register('herdr.newTerminal', (node?: Node) => newTerminal(node)),
    register('herdr.newTerminalToSide', (node?: Node) => newTerminal(node, vscode.ViewColumn.Beside)),
    register('herdr.renamePane', async (node?: Node) => {
      const pane = await paneOf(node);
      const info = pane?.machine.model.pane(pane.id);
      if (!pane || !info) return;
      const label = await vscode.window.showInputBox({ title: 'Rename herdr pane', value: info.pane.label ?? info.title, prompt: 'Empty clears the label' });
      if (label !== undefined) await pane.machine.request('pane.rename', { pane_id: info.pane.pane_id, label: label.trim() || null });
    }),
    register('herdr.closePane', async (node?: Node) => {
      const pane = await paneOf(node);
      const info = pane?.machine.model.pane(pane.id);
      if (!pane || !info) return;
      log.info(`close pane ${info.pane.pane_id} (${info.title}) on ${pane.machine.name}?`);
      const close = 'Close Pane';
      const answer = await vscode.window.showWarningMessage(`Close herdr pane "${info.title}"? Its process is terminated.`, { modal: true }, close);
      if (answer === close) await pane.machine.request('pane.close', { pane_id: info.pane.pane_id });
    }),
    register('herdr.newWorkspace', async (node?: Node) => {
      const machine = await machineOf(node);
      if (!machine) return;
      const label = await vscode.window.showInputBox({ title: `New herdr workspace on ${machine.name}`, prompt: 'Label (optional)' });
      if (label === undefined) return;
      await machine.request('workspace.create', {
        label: label.trim() || null,
        // A remote machine has no use for this window's folder.
        cwd: machine.local ? (vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null) : null,
        focus: false,
      });
    }),
    register('herdr.renameWorkspace', async (node?: Node) => {
      const target = workspaceOf(node);
      const workspace = target?.machine.model.workspace(target.id);
      if (!target || !workspace) return;
      const label = await vscode.window.showInputBox({ title: 'Rename herdr workspace', value: workspace.label });
      if (label?.trim()) await target.machine.request('workspace.rename', { workspace_id: workspace.workspace_id, label: label.trim() });
    }),
    register('herdr.closeWorkspace', async (node?: Node) => {
      const target = workspaceOf(node);
      const workspace = target?.machine.model.workspace(target.id);
      if (!target || !workspace) return;
      const close = 'Close Workspace';
      const answer = await vscode.window.showWarningMessage(
        `Close herdr workspace "${workspace.label}"? All its panes are terminated.`,
        { modal: true },
        close,
      );
      if (answer === close) await target.machine.request('workspace.close', { workspace_id: workspace.workspace_id });
    }),
    register('herdr.focus', async () => {
      const current = panels.current();
      if (current) return current.panel.reveal(undefined, false);
      const local = machines.get(LOCAL);
      if (local?.model.focusedPaneId) await panels.open(LOCAL, local.model.focusedPaneId);
      else await vscode.commands.executeCommand('herdr.sessions.focus');
    }),
    register('herdr.reconnect', () => {
      for (const machine of machines.list()) machine.model.start();
      panels.reconnectAll();
    }),
    register('herdr.reconnectMachine', (node?: Node) => {
      const machine = node && machines.get(node.machine);
      if (!machine) return;
      machine.model.start();
      panels.targetChanged(machine.id);
    }),
    register('herdr.addMachine', addMachine),
    register('herdr.removeMachine', removeMachine),
    register('herdr.reload', () => panels.reloadAll()),
    register('herdr.openSettings', () => SettingsPanel.show(context.extensionUri, log)),
    register('herdr.paste', () => panels.paste()),
    viewCommand('copy'),
    viewCommand('find'),
    viewCommand('scrollToBottom'),
    viewCommand('findNext'),
    viewCommand('findPrevious'),
    viewCommand('closeFind'),
    viewCommand('clearSelection'),
    // Bound to keys the pane already handled (see scripts/keybindings.mjs).
    vscode.commands.registerCommand('herdr.noop', () => undefined),
    machines.onDidChangeModel(updateStatus),
    machines.onDidChangeMachines(updateStatus),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Panels draw the scheme in use: reload when it, not any scheme, changed.
      const scheme = JSON.stringify(activeScheme() ?? null);
      const schemeChanged = scheme !== shownScheme;
      shownScheme = scheme;
      if (schemeChanged || RELOAD_SETTINGS.some((setting) => event.affectsConfiguration(setting))) panels.reloadAll();
      if (MACHINE_SETTINGS.some((setting) => event.affectsConfiguration(setting))) machines.sync();
      if (LOCAL_TARGET_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
        machines.get(LOCAL)?.model.start();
        panels.targetChanged(LOCAL);
      }
      if (event.affectsConfiguration('herdr.editorKeys') || event.affectsConfiguration('terminal.integrated.showLinkHover')) {
        panels.optionsChanged();
      }
    }),
  );
  updateStatus();
}

export function deactivate(): void {}
