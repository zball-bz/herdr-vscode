// The herdr servers the extension shows: this machine's (herdr.session,
// herdr.socketPath) and remote machines reached over SSH (herdr.machines).
// Each has its own metadata connection; panels and commands name the machine
// they act on by its id, which stays stable when a machine is renamed.
import * as os from 'node:os';
import * as vscode from 'vscode';
import { request } from './api';
import type { Log } from './log';
import { SessionModel } from './model';
import { localSocketPath, validSessionName } from './socket';
import { type Target, validSshTarget } from './transport';

/** The id of this machine's herdr. */
export const LOCAL = 'local';

export interface RemoteConfig {
  name: string;
  target: string;
  session: string;
}

export function machineId(target: string, session: string): string {
  return `ssh:${target}#${session}`;
}

/** The host of `user@host`, `ssh://user@host:port` or a Host alias. */
export function defaultName(target: string): string {
  const authority = target.replace(/^ssh:\/\//, '');
  const host = authority
    .slice(authority.lastIndexOf('@') + 1)
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  return host || target;
}

/** The usable entries of `herdr.machines`, once per target and session. */
export function parseMachines(raw: unknown): RemoteConfig[] {
  const out: RemoteConfig[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const fields = item as Record<string, unknown>;
    const target = typeof fields.target === 'string' ? fields.target.trim() : '';
    const session = typeof fields.session === 'string' && fields.session.trim() ? fields.session.trim() : 'default';
    if (!validSshTarget(target) || !validSessionName(session)) continue;
    const id = machineId(target, session);
    if (seen.has(id)) continue;
    seen.add(id);
    const name = typeof fields.name === 'string' && fields.name.trim() ? fields.name.trim() : defaultName(target);
    out.push({ name, target, session });
  }
  return out;
}

/** This machine's herdr, from herdr.session and herdr.socketPath. */
function localTarget(): Target {
  const config = vscode.workspace.getConfiguration('herdr');
  const session = config.get<string>('session') || 'default';
  if (!validSessionName(session)) throw new Error(`invalid herdr.session ${JSON.stringify(session)}`);
  return { kind: 'local', path: localSocketPath(config.get<string>('socketPath') ?? '', session) };
}

export class Machine implements vscode.Disposable {
  readonly model: SessionModel;

  constructor(
    readonly id: string,
    public name: string,
    private readonly resolve: () => Target,
    extensionPath: string,
    log: Log,
  ) {
    this.model = new SessionModel(extensionPath, resolve, log, id === LOCAL ? 'session' : `machine ${name}`);
  }

  get local(): boolean {
    return this.id === LOCAL;
  }

  target(): Target {
    return this.resolve();
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    return request(this.resolve(), method, params);
  }

  /** Where it is, for the tree: the socket session, or the ssh target and session. */
  where(): string {
    try {
      const target = this.resolve();
      return target.kind === 'local' ? 'this machine' : `${target.target}${target.session === 'default' ? '' : ` · ${target.session}`}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  dispose(): void {
    this.model.dispose();
  }
}

export class Machines implements vscode.Disposable {
  private readonly machines = new Map<string, Machine>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly modelChanged = new vscode.EventEmitter<Machine>();
  private readonly subscriptions = new Map<string, vscode.Disposable>();
  /** Machines were added, removed or renamed. */
  readonly onDidChangeMachines = this.changed.event;
  /** A machine's session changed (snapshot, connection state). */
  readonly onDidChangeModel = this.modelChanged.event;

  constructor(
    private readonly extensionPath: string,
    private readonly log: Log,
  ) {}

  /** Brings the machines in line with the settings; the ones that stay keep their connection. */
  sync(): void {
    const config = vscode.workspace.getConfiguration('herdr');
    const wanted = new Map<string, { name: string; resolve: () => Target }>();
    if (config.get<boolean>('localMachine') ?? true) wanted.set(LOCAL, { name: os.hostname(), resolve: localTarget });
    const remotes = parseMachines(config.get('machines'));
    // herdr.remote, from before herdr.machines: one more remote machine.
    const legacy = config.get<string>('remote')?.trim();
    if (legacy) remotes.push(...parseMachines([{ target: legacy, session: config.get<string>('session') || 'default' }]));
    for (const remote of remotes) {
      const target: Target = { kind: 'ssh', target: remote.target, session: remote.session };
      wanted.set(machineId(remote.target, remote.session), { name: remote.name, resolve: () => target });
    }
    let changed = false;
    for (const [id, machine] of this.machines) {
      if (wanted.has(id)) continue;
      this.log.info(`machine ${machine.name}: removed`);
      this.subscriptions.get(id)?.dispose();
      this.subscriptions.delete(id);
      machine.dispose();
      this.machines.delete(id);
      changed = true;
    }
    for (const [id, { name, resolve }] of wanted) {
      const existing = this.machines.get(id);
      if (existing) {
        if (existing.name !== name) {
          existing.name = name;
          changed = true;
        }
        continue;
      }
      const machine = new Machine(id, name, resolve, this.extensionPath, this.log);
      this.machines.set(id, machine);
      this.subscriptions.set(
        id,
        machine.model.onDidChange(() => this.modelChanged.fire(machine)),
      );
      machine.model.start();
      changed = true;
    }
    if (changed) this.changed.fire();
  }

  /** This machine first, then remote machines in settings order. */
  list(): Machine[] {
    return [...this.machines.values()];
  }

  get(id: string | undefined): Machine | undefined {
    return this.machines.get(id ?? LOCAL);
  }

  /** Whether the tree needs a machine level: anything but this machine alone. */
  get several(): boolean {
    const list = this.list();
    return list.length !== 1 || !list[0].local;
  }

  dispose(): void {
    for (const subscription of this.subscriptions.values()) subscription.dispose();
    for (const machine of this.machines.values()) machine.dispose();
    this.machines.clear();
    this.changed.dispose();
    this.modelChanged.dispose();
  }
}
