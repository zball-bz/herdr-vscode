// The session as herdr describes it: workspaces, tabs, panes and agents, from a
// metadata-only client connection (hello with surface_active=false) decoded by
// herdr-core's Node build. It drives the tree, panel titles and status icons.
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Log } from './log';
import { Connection, describeTarget, type Target } from './transport';

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export interface Workspace {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  agent_status: AgentStatus;
  new_workspace_cwd?: string | null;
}

export interface Tab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  custom_label: boolean;
  agent_status: AgentStatus;
}

export interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  label: string | null;
  cwd: string | null;
  foreground_cwd: string | null;
  focused: boolean;
}

export interface Agent {
  pane_id: string;
  name: string | null;
  display_agent: string | null;
  agent: string | null;
  title: string | null;
  terminal_title_stripped: string | null;
  agent_status: AgentStatus;
}

export interface Snapshot {
  revision: number;
  focused_workspace_id: string | null;
  focused_tab_id: string | null;
  focused_pane_id: string | null;
  workspaces: Workspace[];
  tabs: Tab[];
  panes: Pane[];
  agents: Agent[];
}

/** A pane with what the UI shows for it. */
export interface PaneInfo {
  pane: Pane;
  tab: Tab | undefined;
  agent: Agent | undefined;
  status: AgentStatus;
  title: string;
  /** Panes sharing its herdr tab (1 when it lives alone). */
  tabPanes: number;
}

/** herdr-core's Node build (wasm-bindgen nodejs target), loaded from media/herdr-core. */
interface Core {
  hello(cols: number, rows: number, cellWidth: number, cellHeight: number, surfaceActive: boolean): Uint8Array;
  feed(chunk: Uint8Array): string;
  free(): void;
}
type CoreClass = new () => Core;

export function paneTitle(pane: Pane, agent: Agent | undefined): string {
  return (
    pane.label ||
    agent?.name ||
    agent?.display_agent ||
    agent?.agent ||
    path.basename(pane.foreground_cwd || pane.cwd || '') ||
    pane.pane_id
  );
}

export class SessionModel implements vscode.Disposable {
  private snapshot: Snapshot | undefined;
  private core: Core | undefined;
  private readonly CoreClass: CoreClass;
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly connection: Connection;
  private changeTimer: NodeJS.Timeout | undefined;
  /** Why the metadata connection is down, or undefined while connected. */
  problem: string | undefined = 'connecting…';
  readonly onDidChange = this.changed.event;

  /** `prefix` names the machine in log lines ("session" for this one). */
  constructor(
    extensionPath: string,
    resolveTarget: () => Target,
    private readonly log: Log,
    private readonly prefix = 'session',
  ) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.CoreClass = (require(path.join(extensionPath, 'media', 'herdr-core', 'herdr_core.js')) as { Core: CoreClass }).Core;
    this.connection = new Connection(resolveTarget, {
      open: (target) => {
        this.core?.free();
        this.core = new this.CoreClass();
        // Metadata only: no surface, so this connection never sizes a tab.
        this.connection.write(this.core.hello(80, 24, 8, 16, false));
        this.log.info(`${this.prefix}: connected to ${describeTarget(target)}`);
      },
      data: (chunk) => this.feed(chunk),
      closed: (reason) => {
        this.problem = reason;
        this.log.warn(`${this.prefix}: ${reason}`);
        this.fire();
      },
    });
  }

  start(): void {
    this.connection.start();
  }

  dispose(): void {
    this.connection.stop();
    this.core?.free();
    this.changed.dispose();
  }

  private feed(chunk: Uint8Array): void {
    if (!this.core) return;
    let events: { type: string; json?: string }[];
    try {
      events = JSON.parse(this.core.feed(chunk));
    } catch (error) {
      this.log.error(`${this.prefix}: ${error instanceof Error ? error.message : error}; reconnecting`);
      this.connection.start();
      return;
    }
    for (const event of events) {
      if (event.type !== 'snapshot' || !event.json) continue;
      this.snapshot = JSON.parse(event.json) as Snapshot;
      this.problem = undefined;
      this.fire();
    }
  }

  /** Snapshots can arrive in bursts (agent status, cwd changes): coalesce UI refreshes. */
  private fire(): void {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.changed.fire();
    }, 50);
  }

  get ready(): boolean {
    return !!this.snapshot;
  }

  get focusedPaneId(): string | undefined {
    return this.snapshot?.focused_pane_id ?? undefined;
  }

  workspaces(): Workspace[] {
    return [...(this.snapshot?.workspaces ?? [])].sort((a, b) => a.number - b.number);
  }

  workspace(id: string): Workspace | undefined {
    return this.snapshot?.workspaces.find((w) => w.workspace_id === id);
  }

  tab(id: string): Tab | undefined {
    return this.snapshot?.tabs.find((t) => t.tab_id === id);
  }

  /** The panes of a workspace, in tab order. */
  panes(workspaceId: string): PaneInfo[] {
    const snapshot = this.snapshot;
    if (!snapshot) return [];
    const tabNumber = (id: string) => snapshot.tabs.find((t) => t.tab_id === id)?.number ?? 0;
    return snapshot.panes
      .filter((p) => p.workspace_id === workspaceId)
      .sort((a, b) => tabNumber(a.tab_id) - tabNumber(b.tab_id) || a.pane_id.localeCompare(b.pane_id, undefined, { numeric: true }))
      .map((p) => this.info(p));
  }

  pane(id: string): PaneInfo | undefined {
    const pane = this.snapshot?.panes.find((p) => p.pane_id === id);
    return pane && this.info(pane);
  }

  /** The pane a single-pane tab holds. */
  paneOfTab(tabId: string): PaneInfo | undefined {
    const pane = this.snapshot?.panes.find((p) => p.tab_id === tabId);
    return pane && this.info(pane);
  }

  blockedAgents(): number {
    return this.snapshot?.agents.filter((a) => a.agent_status === 'blocked').length ?? 0;
  }

  private info(pane: Pane): PaneInfo {
    const snapshot = this.snapshot!;
    const agent = snapshot.agents.find((a) => a.pane_id === pane.pane_id);
    return {
      pane,
      tab: snapshot.tabs.find((t) => t.tab_id === pane.tab_id),
      agent,
      status: agent?.agent_status ?? 'unknown',
      title: paneTitle(pane, agent),
      tabPanes: snapshot.panes.filter((p) => p.tab_id === pane.tab_id).length,
    };
  }
}
