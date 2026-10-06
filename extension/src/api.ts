// Session mutations (tab.create, pane.move, pane.rename, ...). The client
// protocol endpoint refuses them on a connection without an active surface
// ("surface_inactive"), and the extension's metadata connection has none, so
// they go through herdr's JSON API instead: one JSON request per line, one
// response line. Locally that is `herdr.sock`; for a remote session it is
// `herdr remote-api-bridge` over SSH, which forwards stdio to the remote API
// socket, so every method works the same way in both places.
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as net from 'node:net';
import * as path from 'node:path';
import { CANDIDATES, shellQuote, sshOptions, type Target } from './transport';

/** The JSON API socket next to a client socket: `<stem>-client.sock` → `<stem>.sock`. */
export function apiSocketPath(clientSocket: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.HERDR_SOCKET_PATH) return env.HERDR_SOCKET_PATH;
  const base = path.basename(clientSocket);
  const api = base.endsWith('-client.sock') ? `${base.slice(0, -'-client.sock'.length)}.sock` : 'herdr.sock';
  return path.join(path.dirname(clientSocket), api);
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type Params = Record<string, unknown>;
let sequence = 0;

/** Sends one request; resolves with the envelope's `result`, rejects with its `error`. */
export function request(target: Target, method: string, params: Params): Promise<unknown> {
  return target.kind === 'local' ? localRequest(apiSocketPath(target.path), method, params) : sshRequest(target, method, params);
}

function envelope(text: string): unknown {
  // The response is the last JSON line (the CLI may print other lines first).
  const line = text.trim().split('\n').reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new ApiError('no_response', `herdr returned no response${text.trim() ? `: ${text.trim().slice(0, 200)}` : ''}`);
  const value = JSON.parse(line) as { result?: unknown; error?: { code?: string; message?: string } };
  if (value.error) throw new ApiError(value.error.code ?? 'error', value.error.message ?? JSON.stringify(value.error));
  return value.result;
}

function localRequest(socketPath: string, method: string, params: Params): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `vscode-${++sequence}`;
    const socket = net.connect(process.platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath);
    let text = '';
    const timer = setTimeout(() => socket.destroy(new Error(`${method}: no answer from ${socketPath} in 10 s`)), 10000);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      if (text.includes('\n')) socket.end();
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(envelope(text));
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Sends one request over a bridge process's stdio and resolves with its response. */
export function stdioRequest(child: ChildProcessWithoutNullStreams, method: string, params: Params, timeoutMs = 15000): Promise<unknown> {
  const id = `vscode-${++sequence}`;
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      action();
    };
    const timer = setTimeout(() => finish(() => reject(new ApiError('timeout', `${method}: no answer in ${timeoutMs / 1000} s`))), timeoutMs);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      const line = out.split('\n').find((l) => l.includes(`"id":"${id}"`));
      if (line) finish(() => {
        try {
          resolve(envelope(line));
        } catch (error) {
          reject(error);
        }
      });
    });
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-500)));
    child.on('error', (error) => finish(() => reject(error)));
    // `close`, not `exit`: it waits for stdio, so stderr's reason has arrived.
    child.on('close', (code) => finish(() => reject(new ApiError('bridge_exit', `bridge exited (${code}) before answering${err.trim() ? `: ${err.trim()}` : ''}`))));
    // A bridge that has already exited fails the write (EPIPE); `close` says why.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

/** The remote script: run the first herdr found as the API bridge of `session`. */
export function apiBridgeCommand(session: string): string {
  const script = `${CANDIDATES}
    if [ -n "$path" ] && [ -x "$path" ]; then exec "$path" --session ${shellQuote(session)} remote-api-bridge; fi
done
echo 'herdr not found' >&2; exit 127`;
  return `/bin/sh -c ${shellQuote(script)}`;
}

function sshRequest(target: Extract<Target, { kind: 'ssh' }>, method: string, params: Params): Promise<unknown> {
  const child = spawn('ssh', [...sshOptions(), '--', target.target, apiBridgeCommand(target.session)], { stdio: 'pipe' });
  return stdioRequest(child, method, params);
}
