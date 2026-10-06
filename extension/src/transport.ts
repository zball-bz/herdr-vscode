// Byte transports to the herdr daemon's client protocol endpoint. The extension
// never parses the protocol: herdr-web in the webview does, and these only move
// opaque bytes.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

export type Target = { kind: 'local'; path: string } | { kind: 'ssh'; target: string; session: string };

export function describeTarget(target: Target): string {
  return target.kind === 'local' ? target.path : `ssh ${target.target} (session ${target.session})`;
}

export interface LinkHandlers {
  /** The byte stream is ready; herdr-web may send its hello. */
  open(): void;
  data(chunk: Uint8Array): void;
  /** Called once, whether or not `open` happened. */
  close(reason: string): void;
}

export interface Link {
  write(bytes: Uint8Array): void;
  close(): void;
}

export function openLink(target: Target, handlers: LinkHandlers): Link {
  return target.kind === 'local' ? openLocal(target.path, handlers) : openSsh(target.target, target.session, handlers);
}

function once(close: (reason: string) => void): (reason: string) => void {
  let done = false;
  return (reason) => {
    if (!done) {
      done = true;
      close(reason);
    }
  };
}

/** A Unix socket; on Windows herdr maps the same path into the named-pipe namespace. */
function openLocal(path: string, handlers: LinkHandlers): Link {
  const close = once(handlers.close);
  const socket = net.connect(process.platform === 'win32' ? `\\\\.\\pipe\\${path}` : path);
  let error: string | undefined;
  socket.on('connect', () => handlers.open());
  socket.on('data', (chunk) => handlers.data(chunk));
  socket.on('error', (err: NodeJS.ErrnoException) => {
    error = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' ? `no herdr daemon at ${path} (${err.code})` : err.message;
  });
  socket.on('close', () => close(error ?? 'the daemon closed the connection'));
  return {
    write: (bytes) => {
      if (!socket.destroyed) socket.write(bytes);
    },
    close: () => socket.destroy(),
  };
}

// --- SSH: herdr-gpui's bridge (crates/herdr-client/src/ssh.rs) -----------------

const READY = 'herdr-remote-output-ready:1';
const BANNER_LIMIT = 16384;
const BANNER_TIMEOUT_MS = 15000;

/** Same rules as herdr-gpui's `validate_target`: no options, no control characters, no password in the URL. */
export function validSshTarget(target: string): boolean {
  const authority = target.startsWith('ssh://') ? target.slice(6) : target;
  const at = authority.lastIndexOf('@');
  return (
    target.length > 0 &&
    !target.startsWith('-') &&
    target.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/.test(target) &&
    !(at >= 0 && authority.slice(0, at).includes(':'))
  );
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// PATH first (minus mise shims), then upstream's known install roots.
export const CANDIDATES = `candidate=$(command -v herdr 2>/dev/null || :)
case "$candidate" in /*/mise/shims/herdr) candidate=;; /*) ;; *) candidate=;; esac
for path in "$candidate" "$HOME/.local/bin/herdr" /opt/homebrew/bin/herdr /usr/local/bin/herdr /home/linuxbrew/.linuxbrew/bin/herdr "$HOME/.nix-profile/bin/herdr" "/etc/profiles/per-user/$USER/bin/herdr" /nix/var/nix/profiles/default/bin/herdr /run/current-system/sw/bin/herdr; do`;

/** The remote script: print each candidate's client status, then wait for accept/skip. */
export function bridgeCommand(session: string): string {
  const script = `${CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        status=$("$path" status client --json </dev/null) || continue
        printf '%s\\n' "$status"
        printf '\\n%s\\n' '${READY}'
        IFS= read -r choice || exit 1
        case "$choice" in
            accept) exec "$path" --session ${shellQuote(session)} remote-client-bridge;;
            accept-idle) exec "$path" --session ${shellQuote(session)} remote-client-bridge --idle-timeout-v1;;
        esac
    fi
done
exit 127`;
  return `/bin/sh -c ${shellQuote(script)}`;
}

/** A private directory for the multiplexing sockets (short: Unix socket paths are limited). */
function controlDirectory(): string {
  const dir = path.join(os.tmpdir(), `herdr-ssh-${os.userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * herdr-gpui's noninteractive policy, except that every panel, the metadata
 * connection and API calls share one TCP connection per target: the first ssh
 * becomes a ControlMaster that OpenSSH moves to the background (stdio on
 * /dev/null) and keeps 60 s after the last session, so closing any one panel
 * (killing its ssh, a mux client) never ends the others. The private
 * ControlPath replaces one from the user's ssh config.
 */
export function sshOptions(): string[] {
  return [
    '-T',
    '-C',
    ...['-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0', '-o', 'StrictHostKeyChecking=yes'],
    ...['-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1'],
    ...['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'],
    ...['-o', 'ForwardX11=no', '-o', 'ClearAllForwardings=yes'],
    ...['-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(controlDirectory(), '%C')}`, '-o', 'ControlPersist=60'],
  ];
}

export function sshArgs(target: string, session: string): string[] {
  return [...sshOptions(), '--', target, bridgeCommand(session)];
}

/** Whether one `status client --json` object can serve as the bridge (endpoint generation 1). */
export function compatibleStatus(status: unknown): boolean {
  const value = status as { endpoint_protocol_generation?: unknown; endpoint_capabilities?: unknown };
  if (value?.endpoint_protocol_generation !== 1 || !Array.isArray(value.endpoint_capabilities)) return false;
  const capabilities = value.endpoint_capabilities;
  return ['surface_interest', 'presentation_effects_fence', 'health_check'].every((c) => capabilities.includes(c));
}

const READY_LINE = Buffer.from(`${READY}\n`);

/** Offset of the ready line when it starts a line, else -1. */
function readyLine(buffer: Buffer): number {
  for (let at = buffer.indexOf(READY_LINE); at >= 0; at = buffer.indexOf(READY_LINE, at + 1)) {
    if (at === 0 || buffer[at - 1] === 0x0a) return at;
  }
  return -1;
}

function statusObjects(banner: string): unknown[] {
  const parsed: unknown[] = [];
  const tryParse = (text: string) => {
    try {
      parsed.push(JSON.parse(text));
    } catch {
      /* not a JSON status */
    }
  };
  for (const line of banner.split('\n')) if (line.trim().startsWith('{')) tryParse(line);
  if (!parsed.length) tryParse(banner.trim());
  return parsed;
}

/**
 * `ssh <target> <bridge>`: reads each candidate's status until the ready line and
 * answers `accept` for a compatible one (never `accept-idle`: herdr-web sends no
 * health checks, so an idle-timeout bridge would hang up on a quiet session).
 */
function openSsh(target: string, session: string, handlers: LinkHandlers): Link {
  const close = once(handlers.close);
  if (!validSshTarget(target)) {
    queueMicrotask(() => close(`invalid ssh target ${JSON.stringify(target)}`));
    return { write: () => {}, close: () => {} };
  }
  const child = spawn('ssh', sshArgs(target, session), { stdio: ['pipe', 'pipe', 'pipe'] });
  let streaming = false;
  let banner = Buffer.alloc(0);
  let total = 0;
  let stderr = '';
  let failure: string | undefined;
  const timer = setTimeout(() => {
    failure = 'timed out waiting for the remote herdr bridge';
    child.kill();
  }, BANNER_TIMEOUT_MS);

  child.stdout.on('data', (chunk: Buffer) => {
    if (streaming) return handlers.data(chunk);
    total += chunk.length;
    if (total > BANNER_LIMIT) {
      failure = 'the remote herdr bridge printed too much before its ready line';
      return child.kill();
    }
    banner = Buffer.concat([banner, chunk]);
    // Each candidate prints its status block, then the ready line, then waits.
    for (let at = readyLine(banner); at >= 0; at = readyLine(banner)) {
      const status = banner.subarray(0, at).toString('utf8');
      const rest = Buffer.from(banner.subarray(at + READY_LINE.length));
      if (statusObjects(status).some(compatibleStatus)) {
        streaming = true;
        clearTimeout(timer);
        child.stdin.write('accept\n');
        handlers.open();
        if (rest.length) handlers.data(rest);
        return;
      }
      child.stdin.write('skip\n');
      banner = rest;
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    // A short tail for the close reason, without control characters.
    stderr = (stderr + chunk.toString('utf8')).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(-512);
  });
  child.on('error', (err) => {
    failure = `ssh: ${err.message}`;
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    const detail = stderr.trim().split('\n').pop();
    const reason =
      failure ??
      (code === 127 && !streaming
        ? `no compatible herdr found on ${target}`
        : code === 255
          ? `ssh to ${target} failed${detail ? `: ${detail}` : ''}`
          : `remote bridge exited (${code ?? 'signal'})${detail ? `: ${detail}` : ''}`);
    close(reason);
  });
  child.stdin.on('error', () => {
    /* reported through 'close' */
  });
  return {
    write: (bytes) => {
      if (streaming && child.stdin.writable) child.stdin.write(bytes);
    },
    close: () => child.kill(),
  };
}

// --- Reconnecting connection ---------------------------------------------------

export interface ConnectionSink {
  open(target: Target): void;
  data(chunk: Uint8Array): void;
  /** The stream ended or a connect attempt failed (deduplicated while retrying). */
  closed(reason: string): void;
}

/**
 * One logical connection: reconnects with backoff (0.5 s doubling to 5 s) after
 * the daemon goes away, and ignores late events of links it replaced.
 */
export class Connection {
  private link: Link | undefined;
  private generation = 0;
  private timer: NodeJS.Timeout | undefined;
  private delay = 500;
  private wanted = false;
  private isOpen = false;
  private lastReason: string | undefined;

  constructor(
    private readonly resolveTarget: () => Target,
    private readonly sink: ConnectionSink,
  ) {}

  get connected(): boolean {
    return this.isOpen;
  }

  /** (Re)connects now, dropping the current link. */
  start(): void {
    this.drop('reconnecting');
    this.wanted = true;
    this.delay = 500;
    this.lastReason = undefined;
    this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.drop('stopped');
  }

  write(bytes: Uint8Array): void {
    if (this.isOpen) this.link?.write(bytes);
  }

  private drop(reason: string): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation++;
    const wasOpen = this.isOpen;
    this.isOpen = false;
    this.link?.close();
    this.link = undefined;
    if (wasOpen) this.sink.closed(reason);
  }

  private connect(): void {
    const generation = ++this.generation;
    let target: Target;
    try {
      target = this.resolveTarget();
    } catch (error) {
      // A configuration error: retrying cannot help until the settings change.
      this.sink.closed(error instanceof Error ? error.message : String(error));
      return;
    }
    this.link = openLink(target, {
      open: () => {
        if (generation !== this.generation) return;
        this.isOpen = true;
        this.sink.open(target);
      },
      data: (chunk) => {
        if (generation !== this.generation) return;
        // Only a session that delivers data resets the backoff: a daemon that
        // accepts and then drops the connection must not cause a tight loop.
        this.delay = 500;
        this.lastReason = undefined;
        this.sink.data(chunk);
      },
      close: (reason) => {
        if (generation !== this.generation) return;
        const wasOpen = this.isOpen;
        this.isOpen = false;
        this.link = undefined;
        if (wasOpen || reason !== this.lastReason) this.sink.closed(reason);
        this.lastReason = reason;
        if (this.wanted) {
          this.timer = setTimeout(() => this.connect(), this.delay);
          this.delay = Math.min(this.delay * 2, 5000);
        }
      },
    });
  }
}

// --- Probe: can this machine reach herdr on a target? ------------------------------

export interface Probe {
  ok: boolean;
  /** What was found, or why it failed. */
  detail: string;
  /** How to fix a failure, when the cause is known. */
  hint?: string;
}

/** The remote script: every candidate's client status, one per line. */
export function probeCommand(): string {
  const script = `found=
${CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then
        "$path" status client --json </dev/null && found=1
        printf '\\n'
    fi
done
[ -n "$found" ] || exit 127`;
  return `/bin/sh -c ${shellQuote(script)}`;
}

/** A hint for ssh's own failures (exit 255), from its stderr. */
export function sshHint(target: string, stderr: string): string | undefined {
  if (/host key verification failed|no .* host key is known|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return `run \`ssh ${target}\` once in a terminal to check and accept its host key`;
  }
  if (/permission denied|too many authentication failures/i.test(stderr)) {
    return 'log in with a key: add it to the agent (ssh-add) or ~/.ssh/config, and to authorized_keys there (ssh-copy-id); passwords cannot be typed here';
  }
  if (/could not resolve hostname|name or service not known/i.test(stderr)) return 'check the host name, or add a Host entry to ~/.ssh/config';
  if (/connection refused/i.test(stderr)) return 'nothing listens for SSH there: is sshd running on that port?';
  if (/timed out|no route to host|network is unreachable/i.test(stderr)) return 'the machine is unreachable from here: check the network (Tailscale up?) and the address';
  return undefined;
}

/** Logs in once and lists the herdr builds there, as the bridge would find them. */
export function probeSsh(target: string, timeoutMs = 20000): Promise<Probe> {
  if (!validSshTarget(target)) return Promise.resolve({ ok: false, detail: `not an ssh target: ${JSON.stringify(target)}` });
  return new Promise((resolve) => {
    const child = spawn('ssh', [...sshOptions(), '--', target, probeCommand()], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, detail: `no answer from ${target} in ${timeoutMs / 1000} s`, hint: 'check the network and the address' });
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (out = (out + chunk.toString('utf8')).slice(-BANNER_LIMIT)));
    child.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString('utf8')).slice(-2048)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: `ssh: ${error.message}`, hint: 'install the OpenSSH client' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const reason = err.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().split('\n').pop() ?? '';
      if (code === 255) return resolve({ ok: false, detail: `ssh to ${target} failed${reason ? `: ${reason}` : ''}`, hint: sshHint(target, err) });
      const statuses = statusObjects(out) as { version?: string; binary?: string }[];
      const compatible = statuses.find(compatibleStatus);
      if (compatible) return resolve({ ok: true, detail: `herdr ${compatible.version ?? '?'} at ${compatible.binary ?? '?'}` });
      if (statuses.length) {
        const versions = statuses.map((status) => status.version ?? '?').join(', ');
        return resolve({ ok: false, detail: `herdr ${versions} on ${target} speaks another client protocol`, hint: 'update herdr there (herdr update)' });
      }
      resolve({
        ok: false,
        detail: `no herdr found on ${target}`,
        hint: 'install herdr there, on PATH or in ~/.local/bin; it starts its own server when this machine connects',
      });
    });
  });
}
