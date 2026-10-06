// `openLink` events from herdr-web. A web link opens through VS Code's external
// opener (a link-modifier click), its integrated browser, or the system
// browser. A path link opens in the main editor group (file) or reveals in the
// Explorer (directory), found by the pane's working directory, the workspace
// folders, or a search for the path under them.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { LinkOpen } from './protocol';

/** Schemes passed to the OS opener. Terminal output is untrusted, so no `command:`, `file:` or `vscode:`. */
const WEB_SCHEMES = new Set(['http', 'https', 'mailto', 'ftp']);
/** Searches skip dependencies and VCS internals; they would bury the project's own files. */
const SEARCH_EXCLUDE = '**/{node_modules,.git}/**';
const SEARCH_LIMIT = 50;
const SEARCH_TIMEOUT_MS = 3000;

export interface PathLink {
  file: string;
  line?: number;
  column?: number;
}

/** Splits an optional `:line[:col]` suffix off a path link (`src/a.rs:12:5`). */
export function splitLocation(target: string): PathLink {
  const match = /^(.*?):(\d+)(?::(\d+))?:?$/.exec(target);
  if (!match || !match[1]) return { file: target };
  return { file: match[1], line: Number(match[2]), column: match[3] ? Number(match[3]) : undefined };
}

/** Expands `~/` and resolves a relative path against `base`. */
export function resolvePath(file: string, base: string | undefined, home: string = os.homedir()): string {
  let expanded = file;
  if (file === '~') expanded = home;
  else if (file.startsWith('~/') || file.startsWith('~\\')) expanded = path.join(home, file.slice(2));
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(base ?? home, expanded);
}

// --- web links ---------------------------------------------------------------------

export function isLocalhost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || name === '0.0.0.0' || /^127(\.\d{1,3}){3}$/.test(name);
}

/** The OS opener, for a link `openExternal` would hand to VS Code's integrated browser. */
function openWithSystem(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

export async function openWebLink(target: string, open: LinkOpen = 'follow'): Promise<string> {
  let uri: vscode.Uri;
  try {
    uri = vscode.Uri.parse(target, true);
  } catch {
    return `not a URL: ${target}`;
  }
  const scheme = uri.scheme.toLowerCase();
  if (!WEB_SCHEMES.has(scheme)) return `refused ${uri.scheme}: link ${target}`;
  if (open === 'vscode' && (scheme === 'http' || scheme === 'https')) {
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('workbench.action.browser.open')) {
      // Its default placement is the active group, which is this terminal:
      // unless the user chose a placement, use VS Code's side group for
      // browsers (locked to them and reused), keeping the terminal in view.
      const placement = vscode.workspace.getConfiguration('workbench.browser').inspect('newTabPlacement');
      const chosen = [placement?.globalValue, placement?.workspaceValue, placement?.workspaceFolderValue].some((value) => value !== undefined);
      await vscode.commands.executeCommand('workbench.action.browser.open', { url: target, openToSide: !chosen });
      return `opened ${target} in the integrated browser${chosen ? '' : ' beside the terminal'}`;
    }
    if (commands.includes('simpleBrowser.show')) {
      await vscode.commands.executeCommand('simpleBrowser.show', target);
      return `opened ${target} in the Simple Browser`;
    }
  }
  // VS Code's own opener sends localhost links to its integrated browser when
  // workbench.browser.openLocalhostLinks is on; "Open in Browser" means the
  // system's. Only a local extension host can start it.
  const intercepted =
    open === 'external' &&
    !vscode.env.remoteName &&
    vscode.workspace.getConfiguration('workbench.browser').get<boolean>('openLocalhostLinks') &&
    isLocalhost(uri.authority.replace(/:\d+$/, ''));
  if (intercepted) {
    return (await openWithSystem(target)) ? `opened ${target} in the system browser` : `the system browser did not open ${target}`;
  }
  const opened = await vscode.env.openExternal(uri);
  return opened ? `opened ${target}` : `the browser did not open ${target}`;
}

// --- path links --------------------------------------------------------------------

/** Lists absolute paths of files under `root` matching a glob pattern. */
export type FileSearch = (root: string, pattern: string) => Promise<string[]>;

/**
 * The relative path a search looks for, or undefined when a suffix search
 * makes no sense (absolute, home-relative, or climbing with `..`). A leading
 * `./` goes, and so does a `@/` import alias (`@/data/vehicles`).
 */
export function searchSuffix(file: string): string | undefined {
  let suffix = file.replace(/\\/g, '/');
  if (suffix.startsWith('~') || path.posix.isAbsolute(suffix) || path.win32.isAbsolute(file)) return undefined;
  suffix = suffix.replace(/^(\.\/)+/, '').replace(/^@\//, '').replace(/\/+$/, '');
  if (!suffix || suffix.split('/').some((part) => part === '..' || part === '.' || part === '')) return undefined;
  return suffix;
}

/**
 * A glob for files ending in `suffix`, or, when its last part has no
 * extension, in `suffix.<ext>` or `suffix/index.<ext>` (module paths). Glob
 * syntax in names (`app/[id]/page.tsx`) becomes `?`; `matchesSuffix` checks
 * the results exactly.
 */
export function suffixPattern(suffix: string): string {
  const literal = suffix.replace(/[[\]{}*?,!]/g, '?');
  return path.posix.extname(suffix) ? `**/${literal}` : `**/{${literal},${literal}.*,${literal}/index.*}`;
}

export function matchesSuffix(file: string, suffix: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const tail = `/${suffix}`;
  if (normalized.endsWith(tail)) return true;
  if (path.posix.extname(suffix)) return false;
  const at = normalized.lastIndexOf(tail);
  if (at < 0) return false;
  const rest = normalized.slice(at + tail.length);
  return /^\.[^/]+$/.test(rest) || /^\/index\.[^/]+$/.test(rest);
}

/** Nearest first: fewest directories below `cwd`, then shortest, then by name. */
export function rankMatches(files: string[], cwd: string | null): string[] {
  const depth = (file: string) => {
    if (!cwd) return 0;
    const relative = path.relative(cwd, file);
    return relative.startsWith('..') || path.isAbsolute(relative) ? Number.MAX_SAFE_INTEGER : relative.split(path.sep).length;
  };
  return [...new Set(files)].sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b));
}

const exists = (file: string) => fs.stat(file).then(() => true, () => false);

/** Files (or a directory) `file` may mean, nearest first. */
export async function findPathLink(file: string, cwd: string | null, folders: string[], search: FileSearch): Promise<string[]> {
  const bases = [...new Set([cwd, ...folders].filter((base): base is string => !!base))];
  for (const base of bases.length ? bases : [undefined]) {
    const direct = resolvePath(file, base);
    if (await exists(direct)) return [direct];
  }
  const suffix = searchSuffix(file);
  if (!suffix) return [];
  // A base inside another is searched with it.
  const roots = bases.filter((base) => !bases.some((other) => other !== base && !path.relative(other, base).startsWith('..') && !path.isAbsolute(path.relative(other, base))));
  const pattern = suffixPattern(suffix);
  const found = (await Promise.all(roots.map((root) => search(root, pattern).catch(() => [])))).flat();
  return rankMatches(found.filter((match) => matchesSuffix(match, suffix)), cwd);
}

/** `FileSearch` through VS Code's file search (ripgrep), which also covers folders outside the workspace. */
export const searchWithVsCode: FileSearch = async (root, pattern) => {
  const cancel = new vscode.CancellationTokenSource();
  const timer = setTimeout(() => cancel.cancel(), SEARCH_TIMEOUT_MS);
  try {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(root), pattern), SEARCH_EXCLUDE, SEARCH_LIMIT, cancel.token);
    return uris.map((uri) => uri.fsPath);
  } finally {
    clearTimeout(timer);
    cancel.dispose();
  }
};

/**
 * Where a file from a terminal panel in column `from` opens: the main editor
 * group (top left), unless that group is the terminal's own, which a file
 * would cover; then beside it. `side` always goes beside the terminal.
 */
export function pathColumn(open: LinkOpen, from: vscode.ViewColumn | undefined): vscode.ViewColumn {
  if (open === 'side' || from === vscode.ViewColumn.One) return vscode.ViewColumn.Beside;
  return vscode.ViewColumn.One;
}

export async function openPathLink(
  target: string,
  cwd: string | null,
  open: LinkOpen = 'follow',
  from?: vscode.ViewColumn,
  search: FileSearch = searchWithVsCode,
): Promise<string> {
  const folders = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  let { file, line, column } = splitLocation(target);
  let matches = await findPathLink(file, cwd, folders, search);
  if (!matches.length && file !== target) {
    // The suffix may belong to the name (`notes:1`).
    matches = await findPathLink(target, cwd, folders, search);
    if (matches.length) ({ file, line, column } = { file: target, line: undefined, column: undefined });
  }
  if (!matches.length) {
    await vscode.commands.executeCommand('workbench.action.quickOpen', searchSuffix(file) ?? path.basename(file));
    return `no file matches ${file} under ${[cwd, ...folders].filter(Boolean).join(', ') || 'the home directory'}; Quick Open shows the name`;
  }
  let chosen = matches[0];
  if (matches.length > 1) {
    const base = cwd ?? folders[0];
    const picked = await vscode.window.showQuickPick(
      matches.map((match) => ({ label: base ? path.relative(base, match) : match, match })),
      { placeHolder: `${matches.length}${matches.length >= SEARCH_LIMIT ? '+' : ''} files match ${file}` },
    );
    if (!picked) return `${matches.length} files match ${file}; none picked`;
    chosen = picked.match;
  }
  const uri = vscode.Uri.file(chosen);
  if ((await fs.stat(chosen)).isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
    return `revealed ${chosen}`;
  }
  const options: vscode.TextDocumentShowOptions = { preview: true, viewColumn: pathColumn(open, from) };
  if (line) {
    const position = new vscode.Position(Math.max(line - 1, 0), Math.max((column ?? 1) - 1, 0));
    options.selection = new vscode.Range(position, position);
  }
  await vscode.window.showTextDocument(uri, options);
  return `opened ${chosen}${line ? `:${line}${column ? `:${column}` : ''}` : ''}${matches.length > 1 ? ` (picked of ${matches.length})` : ''}`;
}
