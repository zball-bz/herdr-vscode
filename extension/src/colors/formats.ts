// Terminal color scheme files: what each terminal reads and writes, parsed into
// `ColorScheme`s and written back out. Parsers accept what real exports
// contain and ignore everything else; a file that names no complete scheme
// yields none.
import { parseColor, toHex } from './color';
import { type ColorScheme, validScheme } from './scheme';

export type SchemeFormat = 'konsole' | 'iterm' | 'windowsTerminal' | 'ghostty' | 'alacritty' | 'kitty' | 'vscode' | 'xresources';

export const FORMATS: Record<SchemeFormat, { label: string; extension: string }> = {
  konsole: { label: 'Konsole (.colorscheme)', extension: 'colorscheme' },
  iterm: { label: 'iTerm2 (.itermcolors)', extension: 'itermcolors' },
  windowsTerminal: { label: 'Windows Terminal (JSON)', extension: 'json' },
  ghostty: { label: 'Ghostty theme', extension: 'ghostty' },
  alacritty: { label: 'Alacritty (TOML)', extension: 'toml' },
  kitty: { label: 'kitty (.conf)', extension: 'conf' },
  vscode: { label: 'VS Code (workbench.colorCustomizations)', extension: 'json' },
  xresources: { label: 'Xresources', extension: 'Xresources' },
};

const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
/** A color as `#rrggbb`; `0x` prefixes (Alacritty) are accepted. */
function hex(text: string | undefined): string | undefined {
  const rgb = text === undefined ? undefined : parseColor(text.replace(/^0x/i, '#'));
  return rgb && toHex(rgb);
}

function scheme(name: string, fields: Partial<Record<'background' | 'foreground' | 'cursor' | 'cursorText' | 'selection', string>>, palette: (string | undefined)[], source: string): ColorScheme | undefined {
  return validScheme({ name, ...fields, palette, source });
}

// --- Konsole ---------------------------------------------------------------------

/** INI sections → keys → values. */
function ini(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current = new Map<string, string>();
  sections.set('', current);
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      current = new Map();
      sections.set(section[1], current);
      continue;
    }
    const pair = /^\s*([^#;=][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (pair) current.set(pair[1], pair[2]);
  }
  return sections;
}

export function parseKonsole(text: string, fallbackName: string): ColorScheme[] {
  const sections = ini(text);
  const color = (section: string) => hex(sections.get(section)?.get('Color'));
  // The file name, which Konsole lists schemes by; descriptions are often generic.
  const name = fallbackName || sections.get('General')?.get('Description') || 'Konsole';
  const palette = Array.from({ length: 16 }, (_, i) => color(`Color${i % 8}${i >= 8 ? 'Intense' : ''}`));
  const found = scheme(name, { background: color('Background'), foreground: color('Foreground') }, palette, `Konsole: ${name}`);
  return found ? [found] : [];
}

const triple = (color: string) => {
  const rgb = parseColor(color)!;
  return rgb.map((channel) => Math.round(channel * 255)).join(',');
};

export function writeKonsole(scheme: ColorScheme): string {
  const block = (section: string, color: string) => `[${section}]\nColor=${triple(color)}\n`;
  const out = [`[General]\nDescription=${scheme.name}\nOpacity=1\n`];
  for (const [section, color] of [
    ['Background', scheme.background],
    ['Foreground', scheme.foreground],
  ] as const) {
    for (const variant of ['', 'Faint', 'Intense']) out.push(block(`${section}${variant}`, color));
  }
  for (let i = 0; i < 8; i++) {
    out.push(block(`Color${i}`, scheme.palette[i]), block(`Color${i}Faint`, scheme.palette[i]), block(`Color${i}Intense`, scheme.palette[i + 8]));
  }
  return out.join('\n');
}

// --- iTerm2 ----------------------------------------------------------------------

export function parseIterm(text: string, fallbackName: string): ColorScheme[] {
  const colors = new Map<string, string>();
  for (const entry of text.matchAll(/<key>([^<]+)<\/key>\s*<dict>([\s\S]*?)<\/dict>/g)) {
    const component = (name: string) => Number(new RegExp(`<key>${name} Component</key>\\s*<real>([^<]+)</real>`).exec(entry[2])?.[1] ?? NaN);
    const rgb = ['Red', 'Green', 'Blue'].map(component);
    if (rgb.every((channel) => Number.isFinite(channel))) colors.set(entry[1].trim(), toHex(rgb as [number, number, number]));
  }
  const palette = Array.from({ length: 16 }, (_, i) => colors.get(`Ansi ${i} Color`));
  const found = scheme(
    fallbackName,
    {
      background: colors.get('Background Color'),
      foreground: colors.get('Foreground Color'),
      cursor: colors.get('Cursor Color'),
      cursorText: colors.get('Cursor Text Color'),
      selection: colors.get('Selection Color'),
    },
    palette,
    `iTerm2: ${fallbackName}`,
  );
  return found ? [found] : [];
}

export function writeIterm(scheme: ColorScheme): string {
  const entry = (key: string, color: string) => {
    const [r, g, b] = parseColor(color)!;
    const real = (value: number) => `<real>${value.toFixed(6)}</real>`;
    return `\t<key>${key}</key>\n\t<dict>\n\t\t<key>Alpha Component</key>\n\t\t<real>1</real>\n\t\t<key>Blue Component</key>\n\t\t${real(b)}\n\t\t<key>Color Space</key>\n\t\t<string>sRGB</string>\n\t\t<key>Green Component</key>\n\t\t${real(g)}\n\t\t<key>Red Component</key>\n\t\t${real(r)}\n\t</dict>`;
  };
  const entries = [
    ...scheme.palette.map((color, i) => entry(`Ansi ${i} Color`, color)),
    entry('Background Color', scheme.background),
    entry('Foreground Color', scheme.foreground),
    entry('Bold Color', scheme.foreground),
    entry('Cursor Color', scheme.cursor ?? scheme.foreground),
    entry('Cursor Text Color', scheme.cursorText ?? scheme.background),
    ...(scheme.selection ? [entry('Selection Color', scheme.selection)] : []),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${entries.join('\n')}\n</dict>\n</plist>\n`;
}

// --- JSON: Windows Terminal and VS Code -------------------------------------------

/** JSON with comments and trailing commas, as VS Code and Windows Terminal write it. */
function jsonc(text: string): unknown {
  const stripped = text
    .replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : ''))
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

const WT_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white'];

function windowsTerminalScheme(value: Record<string, unknown>, fallbackName: string): ColorScheme | undefined {
  const field = (key: string) => (typeof value[key] === 'string' ? hex(value[key] as string) : undefined);
  const name = typeof value.name === 'string' && value.name ? value.name : fallbackName;
  const palette = [...WT_NAMES, ...WT_NAMES.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)].map(field);
  return scheme(
    name,
    { background: field('background'), foreground: field('foreground'), cursor: field('cursorColor'), selection: field('selectionBackground') },
    palette,
    `Windows Terminal: ${name}`,
  );
}

export function writeWindowsTerminal(scheme: ColorScheme): string {
  const out: Record<string, string> = { name: scheme.name, background: scheme.background, foreground: scheme.foreground };
  if (scheme.cursor) out.cursorColor = scheme.cursor;
  if (scheme.selection) out.selectionBackground = scheme.selection;
  [...WT_NAMES, ...WT_NAMES.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)].forEach((key, i) => (out[key] = scheme.palette[i]));
  return `${JSON.stringify(out, null, 4)}\n`;
}

const VSCODE_ANSI = [...ANSI_KEYS, ...ANSI_KEYS.map((n) => `bright${n[0].toUpperCase()}${n.slice(1)}`)].map(
  (name) => `terminal.ansi${name[0].toUpperCase()}${name.slice(1)}`,
);

function vscodeScheme(colors: Record<string, unknown>, fallbackName: string): ColorScheme | undefined {
  const field = (key: string) => (typeof colors[key] === 'string' ? hex(colors[key] as string) : undefined);
  return scheme(
    fallbackName,
    {
      background: field('terminal.background') ?? field('editor.background'),
      foreground: field('terminal.foreground') ?? field('editor.foreground'),
      cursor: field('terminalCursor.foreground'),
      selection: field('terminal.selectionBackground'),
    },
    VSCODE_ANSI.map(field),
    `VS Code: ${fallbackName}`,
  );
}

/** The `workbench.colorCustomizations` entries for VS Code's own terminal. */
export function vscodeColors(scheme: ColorScheme): Record<string, string> {
  const out: Record<string, string> = { 'terminal.background': scheme.background, 'terminal.foreground': scheme.foreground };
  if (scheme.cursor) out['terminalCursor.foreground'] = scheme.cursor;
  if (scheme.selection) out['terminal.selectionBackground'] = scheme.selection;
  VSCODE_ANSI.forEach((key, i) => (out[key] = scheme.palette[i]));
  return out;
}

export function writeVscode(scheme: ColorScheme): string {
  return `${JSON.stringify({ 'workbench.colorCustomizations': vscodeColors(scheme) }, null, 4)}\n`;
}

export function parseJson(text: string, fallbackName: string): ColorScheme[] {
  let value: unknown;
  try {
    value = jsonc(text);
  } catch {
    return [];
  }
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  // Windows Terminal: one scheme, or a settings file with `schemes`.
  if (Array.isArray(object.schemes)) {
    return object.schemes.flatMap((item) => (item && typeof item === 'object' ? [windowsTerminalScheme(item as Record<string, unknown>, fallbackName)] : [])).filter((s): s is ColorScheme => !!s);
  }
  if (typeof object.background === 'string' && typeof object.black === 'string') {
    const found = windowsTerminalScheme(object, fallbackName);
    return found ? [found] : [];
  }
  // VS Code: settings, a color theme, or bare color keys.
  const colors = (object['workbench.colorCustomizations'] ?? object.colors ?? object) as Record<string, unknown>;
  const found = colors && typeof colors === 'object' ? vscodeScheme(colors, typeof object.name === 'string' ? object.name : fallbackName) : undefined;
  return found ? [found] : [];
}

// --- line-based formats: Ghostty, kitty, Xresources -------------------------------

export function parseGhostty(text: string, fallbackName: string): ColorScheme[] {
  const fields: Record<string, string> = {};
  const palette: (string | undefined)[] = [];
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!pair) continue;
    if (pair[1] === 'palette') {
      const entry = /^(\d+)\s*=\s*(\S+)$/.exec(pair[2]);
      if (entry && Number(entry[1]) < 16) palette[Number(entry[1])] = hex(entry[2]);
    } else fields[pair[1]] = pair[2];
  }
  const found = scheme(
    fallbackName,
    {
      background: hex(fields.background),
      foreground: hex(fields.foreground),
      cursor: hex(fields['cursor-color']),
      cursorText: hex(fields['cursor-text']),
      selection: hex(fields['selection-background']),
    },
    palette,
    `Ghostty: ${fallbackName}`,
  );
  return found ? [found] : [];
}

export function writeGhostty(scheme: ColorScheme): string {
  const lines = scheme.palette.map((color, i) => `palette = ${i}=${color}`);
  lines.push(`background = ${scheme.background}`, `foreground = ${scheme.foreground}`);
  if (scheme.cursor) lines.push(`cursor-color = ${scheme.cursor}`);
  if (scheme.cursorText) lines.push(`cursor-text = ${scheme.cursorText}`);
  if (scheme.selection) lines.push(`selection-background = ${scheme.selection}`);
  return `${lines.join('\n')}\n`;
}

export function parseKitty(text: string, fallbackName: string): ColorScheme[] {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*(\w+)\s+(#?[0-9a-fA-F]{3,6})\s*$/.exec(line);
    if (pair) fields[pair[1]] = pair[2];
  }
  const found = scheme(
    fallbackName,
    {
      background: hex(fields.background),
      foreground: hex(fields.foreground),
      cursor: hex(fields.cursor),
      cursorText: hex(fields.cursor_text_color),
      selection: hex(fields.selection_background),
    },
    Array.from({ length: 16 }, (_, i) => hex(fields[`color${i}`])),
    `kitty: ${fallbackName}`,
  );
  return found ? [found] : [];
}

export function writeKitty(scheme: ColorScheme): string {
  const lines = [`background ${scheme.background}`, `foreground ${scheme.foreground}`];
  if (scheme.cursor) lines.push(`cursor ${scheme.cursor}`);
  if (scheme.cursorText) lines.push(`cursor_text_color ${scheme.cursorText}`);
  if (scheme.selection) lines.push(`selection_background ${scheme.selection}`);
  scheme.palette.forEach((color, i) => lines.push(`color${i} ${color}`));
  return `${lines.join('\n')}\n`;
}

export function parseXresources(text: string, fallbackName: string): ColorScheme[] {
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const pair = /^\s*[\w.*-]*?[*.]?(color\d+|background|foreground|cursorColor)\s*:\s*(\S+)/.exec(line);
    if (pair && !line.trim().startsWith('!')) fields[pair[1]] = pair[2];
  }
  const found = scheme(
    fallbackName,
    { background: hex(fields.background), foreground: hex(fields.foreground), cursor: hex(fields.cursorColor) },
    Array.from({ length: 16 }, (_, i) => hex(fields[`color${i}`])),
    `Xresources: ${fallbackName}`,
  );
  return found ? [found] : [];
}

export function writeXresources(scheme: ColorScheme): string {
  const lines = [`*.background: ${scheme.background}`, `*.foreground: ${scheme.foreground}`];
  if (scheme.cursor) lines.push(`*.cursorColor: ${scheme.cursor}`);
  scheme.palette.forEach((color, i) => lines.push(`*.color${i}: ${color}`));
  return `! ${scheme.name}\n${lines.join('\n')}\n`;
}

// --- Alacritty --------------------------------------------------------------------

export function parseAlacritty(text: string, fallbackName: string): ColorScheme[] {
  const tables = new Map<string, Map<string, string>>();
  let table = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      table = header[1].trim();
      continue;
    }
    const pair = /^\s*(\w+)\s*=\s*["']([^"']+)["']/.exec(line);
    if (pair) {
      if (!tables.has(table)) tables.set(table, new Map());
      tables.get(table)!.set(pair[1], pair[2]);
    }
  }
  const get = (name: string, key: string) => hex(tables.get(`colors.${name}`)?.get(key));
  const found = scheme(
    fallbackName,
    {
      background: get('primary', 'background'),
      foreground: get('primary', 'foreground'),
      cursor: get('cursor', 'cursor'),
      cursorText: get('cursor', 'text'),
      selection: get('selection', 'background'),
    },
    [...ANSI_KEYS.map((key) => get('normal', key)), ...ANSI_KEYS.map((key) => get('bright', key))],
    `Alacritty: ${fallbackName}`,
  );
  return found ? [found] : [];
}

export function writeAlacritty(scheme: ColorScheme): string {
  const table = (name: string, colors: string[]) => `[colors.${name}]\n${ANSI_KEYS.map((key, i) => `${key} = "${colors[i]}"`).join('\n')}\n`;
  const out = [`[colors.primary]\nbackground = "${scheme.background}"\nforeground = "${scheme.foreground}"\n`];
  if (scheme.cursor) out.push(`[colors.cursor]\ncursor = "${scheme.cursor}"\ntext = "${scheme.cursorText ?? scheme.background}"\n`);
  if (scheme.selection) out.push(`[colors.selection]\nbackground = "${scheme.selection}"\ntext = "CellForeground"\n`);
  out.push(table('normal', scheme.palette.slice(0, 8)), table('bright', scheme.palette.slice(8)));
  return out.join('\n');
}

// --- dispatch ---------------------------------------------------------------------

const PARSERS: [SchemeFormat, RegExp, (text: string, name: string) => ColorScheme[]][] = [
  ['konsole', /\.colorscheme$/i, parseKonsole],
  ['iterm', /\.itermcolors$/i, parseIterm],
  ['vscode', /\.jsonc?$/i, parseJson],
  ['alacritty', /\.toml$/i, parseAlacritty],
  ['kitty', /\.conf$/i, parseKitty],
  ['xresources', /xresources|xdefaults/i, parseXresources],
  ['ghostty', /./, parseGhostty],
];

/**
 * The schemes in a file, by its name's extension first and then by trying
 * every format. A scheme without a name of its own takes the file's.
 */
export function parseSchemes(text: string, fileName: string): ColorScheme[] {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Imported';
  const byName = PARSERS.find(([, pattern]) => pattern.test(fileName));
  const first = byName ? byName[2](text, base) : [];
  if (first.length) return first;
  for (const [, , parse] of PARSERS) {
    const found = parse(text, base);
    if (found.length) return found;
  }
  return [];
}

export function writeScheme(scheme: ColorScheme, format: SchemeFormat): string {
  switch (format) {
    case 'konsole':
      return writeKonsole(scheme);
    case 'iterm':
      return writeIterm(scheme);
    case 'windowsTerminal':
      return writeWindowsTerminal(scheme);
    case 'ghostty':
      return writeGhostty(scheme);
    case 'alacritty':
      return writeAlacritty(scheme);
    case 'kitty':
      return writeKitty(scheme);
    case 'vscode':
      return writeVscode(scheme);
    case 'xresources':
      return writeXresources(scheme);
  }
}
