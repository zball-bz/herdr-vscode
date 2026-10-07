// A herdr workspace's directory as a VS Code folder: this machine's as a file
// (in a remote window the extension runs on that host, and VS Code maps the
// file URI there), a remote machine's through Remote - SSH.
import * as vscode from 'vscode';
import type { Machine } from './machines';
import type { SessionModel, Workspace } from './model';

export const REMOTE_SSH = 'ms-vscode-remote.remote-ssh';

/**
 * Remote - SSH's authority for an ssh target: a Host alias or user@host as
 * typed; with a port (or an IPv6 address), its hex-encoded JSON host form.
 */
export function sshRemoteAuthority(target: string): string {
  if (!target.startsWith('ssh://')) return `ssh-remote+${target}`;
  const authority = target.slice('ssh://'.length).replace(/\/.*$/, '');
  const at = authority.lastIndexOf('@');
  const user = at >= 0 ? authority.slice(0, at) : '';
  const address = authority.slice(at + 1);
  const [, host = address, port] = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(address) ?? [];
  const hostName = host.replace(/^\[(.*)\]$/, '$1');
  if (!port && !hostName.includes(':')) return `ssh-remote+${user ? `${user}@` : ''}${hostName}`;
  const spec = { hostName, ...(user ? { user } : {}), ...(port ? { port: Number(port) } : {}) };
  return `ssh-remote+${Buffer.from(JSON.stringify(spec)).toString('hex')}`;
}

/** Where herdr starts the workspace's new panes, else where its focused (or first) pane is. */
export function workspaceDirectory(model: Pick<SessionModel, 'panes'>, workspace: Workspace): string | undefined {
  if (workspace.new_workspace_cwd) return workspace.new_workspace_cwd;
  const panes = model.panes(workspace.workspace_id);
  const pane = (panes.find((info) => info.pane.focused) ?? panes[0])?.pane;
  return pane?.foreground_cwd || pane?.cwd || undefined;
}

export function folderUri(machine: Machine, directory: string): vscode.Uri {
  const target = machine.target();
  return target.kind === 'local'
    ? vscode.Uri.file(directory)
    : vscode.Uri.from({ scheme: 'vscode-remote', authority: sshRemoteAuthority(target.target), path: directory });
}
