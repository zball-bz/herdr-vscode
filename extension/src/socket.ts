// Where the herdr daemon's binary client protocol socket lives, following
// herdr-gpui's discovery rules (crates/herdr-client/src/discovery.rs).
import * as os from 'node:os';
import * as path from 'node:path';

/** Session names that may become a directory under the config root. */
export function validSessionName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && name !== '.' && name !== '..' && /^[A-Za-z0-9._-]+$/.test(name);
}

/** herdr's config root: $XDG_CONFIG_HOME, %APPDATA% on Windows, else ~/.config. */
export function configRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  if (process.platform === 'win32') {
    if (env.APPDATA) return env.APPDATA;
    if (env.USERPROFILE) return path.join(env.USERPROFILE, 'AppData', 'Roaming');
  }
  return path.join(env.HOME || os.homedir(), '.config');
}

export function sessionSocket(session: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!validSessionName(session)) throw new Error(`invalid herdr session name ${JSON.stringify(session)}`);
  const base = path.join(configRoot(env), 'herdr');
  return path.join(session === 'default' ? base : path.join(base, 'sessions', session), 'herdr-client.sock');
}

/**
 * The local socket: the `herdr.socketPath` setting, then HERDR_CLIENT_SOCKET_PATH,
 * then HERDR_SOCKET_PATH's sibling `<stem>-client.sock`, then the session's socket.
 */
export function localSocketPath(socketPath: string, session: string, env: NodeJS.ProcessEnv = process.env): string {
  if (socketPath) return socketPath.replace(/^~(?=$|[\\/])/, os.homedir());
  if (env.HERDR_CLIENT_SOCKET_PATH) return env.HERDR_CLIENT_SOCKET_PATH;
  if (env.HERDR_SOCKET_PATH) {
    const api = env.HERDR_SOCKET_PATH;
    const stem = path.basename(api, path.extname(api)) || 'herdr';
    return path.join(path.dirname(api), `${stem}-client.sock`);
  }
  return sessionSocket(session || 'default', env);
}
