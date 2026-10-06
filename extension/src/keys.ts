// Canonical key names shared by the webview (from KeyboardEvent.code) and the
// extension (from the `herdr.editorKeys` setting): modifiers in the order
// ctrl, shift, alt, meta, then the key, joined with `+`, lowercase.

const MODIFIERS = ['ctrl', 'shift', 'alt', 'meta'] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIERS)[number]> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  meta: 'meta',
  cmd: 'meta',
  win: 'meta',
  super: 'meta',
};
const KEY_ALIASES: Record<string, string> = { esc: 'escape', return: 'enter', del: 'delete', ins: 'insert' };

/** `KeyboardEvent.code` to the VS Code key name, layout independent. */
const CODES: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Tab: 'tab',
  Escape: 'escape',
  Space: 'space',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

function codeName(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return CODES[code];
}

function join(modifiers: Set<string>, key: string): string {
  return [...MODIFIERS.filter((m) => modifiers.has(m)), key].join('+');
}

/** Canonical name of a pressed key, or undefined for bare modifiers and unknown keys. */
export function eventKey(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string | undefined {
  const key = codeName(event.code);
  if (!key) return undefined;
  const modifiers = new Set<string>();
  if (event.ctrlKey) modifiers.add('ctrl');
  if (event.shiftKey) modifiers.add('shift');
  if (event.altKey) modifiers.add('alt');
  if (event.metaKey) modifiers.add('meta');
  return join(modifiers, key);
}

/** Canonical form of a key written as in VS Code keybindings (`Ctrl+Shift+P`, `cmd+f`). */
export function normalizeKey(text: string): string | undefined {
  const parts = text.toLowerCase().split('+').map((part) => part.trim());
  const key = parts.pop();
  if (!key) return undefined;
  const modifiers = new Set<string>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) return undefined;
    modifiers.add(modifier);
  }
  return join(modifiers, KEY_ALIASES[key] ?? key);
}
