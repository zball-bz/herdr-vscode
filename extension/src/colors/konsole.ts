// Konsole's color schemes on this machine, the current profile's first:
// konsolerc names the default profile, the profile names its scheme, and
// schemes live in `konsole/` under the XDG data directories (user first).
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface KonsoleScheme {
  name: string;
  file: string;
  /** The default profile's scheme. */
  current: boolean;
}

/** Konsole's built-in default when a profile names none. */
const DEFAULT_SCHEME = 'Breeze';

const readText = (file: string) => fs.readFile(file, 'utf8').catch(() => undefined);

function iniValue(text: string | undefined, section: string, key: string): string | undefined {
  if (!text) return undefined;
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) inside = header[1] === section;
    else if (inside) {
      const pair = new RegExp(`^\\s*${key}\\s*=\\s*(.*?)\\s*$`).exec(line);
      if (pair) return pair[1];
    }
  }
  return undefined;
}

export async function konsoleSchemes(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Promise<KonsoleScheme[]> {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const dataDirs = [env.XDG_DATA_HOME || path.join(home, '.local', 'share'), ...(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')]
    .filter(Boolean)
    .map((dir) => path.join(dir, 'konsole'));
  const profile = iniValue(await readText(path.join(configHome, 'konsolerc')), 'Desktop Entry', 'DefaultProfile');
  let current: string | undefined;
  if (profile) {
    for (const dir of dataDirs) {
      const text = await readText(path.join(dir, profile));
      if (text !== undefined) {
        current = iniValue(text, 'Appearance', 'ColorScheme') ?? DEFAULT_SCHEME;
        break;
      }
    }
  }
  const found = new Map<string, KonsoleScheme>();
  for (const dir of dataDirs) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    for (const entry of names.sort()) {
      if (!entry.endsWith('.colorscheme')) continue;
      const name = entry.slice(0, -'.colorscheme'.length);
      if (!found.has(name)) found.set(name, { name, file: path.join(dir, entry), current: name === current });
    }
  }
  return [...found.values()].sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name));
}
