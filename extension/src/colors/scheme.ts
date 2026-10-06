// A terminal color scheme as the settings page edits it and `herdr.colorSchemes`
// stores it: hex strings, so settings.json stays readable and hand-editable.
import type { Theme } from '../protocol';
import { normalizeHex, parseColor, rgbToOklab } from './color';

export const ANSI_NAMES = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'] as const;

export interface ColorScheme {
  name: string;
  background: string;
  foreground: string;
  /** The block cursor; the foreground when unset. */
  cursor?: string;
  /** Text under the block cursor; the background when unset. */
  cursorText?: string;
  selection?: string;
  /** 0–7 normal, 8–15 bright. */
  palette: string[];
  /** Slots the readability optimizer leaves alone (see `Slot`). */
  locked?: Slot[];
  /** Where the scheme came from, e.g. "Konsole: light_optimized". */
  source?: string;
}

/** A color of a scheme: a named role, or an ANSI index as a string. */
export type Slot = 'background' | 'foreground' | 'cursor' | 'cursorText' | 'selection' | `${number}`;

export function slotLabel(slot: Slot): string {
  if (/^\d+$/.test(slot)) {
    const index = Number(slot);
    return `${index >= 8 ? 'Bright ' : ''}${ANSI_NAMES[index % 8]}`;
  }
  return { background: 'Background', foreground: 'Foreground', cursor: 'Cursor', cursorText: 'Cursor text', selection: 'Selection' }[
    slot as Exclude<Slot, `${number}`>
  ];
}

export function slotColor(scheme: ColorScheme, slot: Slot): string | undefined {
  if (/^\d+$/.test(slot)) return scheme.palette[Number(slot)];
  return scheme[slot as Exclude<Slot, `${number}`>];
}

export function withSlot(scheme: ColorScheme, slot: Slot, color: string): ColorScheme {
  if (/^\d+$/.test(slot)) {
    const palette = [...scheme.palette];
    palette[Number(slot)] = color;
    return { ...scheme, palette };
  }
  return { ...scheme, [slot]: color };
}

/** A dark scheme draws light text on a dark background. */
export function isDark(scheme: ColorScheme): boolean {
  return rgbToOklab(parseColor(scheme.background) ?? [0, 0, 0]).L < 0.6;
}

/**
 * A scheme from untrusted JSON (settings, imports), with colors normalized to
 * `#rrggbb`; undefined without a name, background, foreground and 16 colors.
 * Bright colors missing from a 8-color source repeat the normal ones.
 */
export function validScheme(value: unknown): ColorScheme | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const hex = (field: unknown) => (typeof field === 'string' ? normalizeHex(field) : undefined);
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const [background, foreground] = [hex(raw.background), hex(raw.foreground)];
  const colors = Array.isArray(raw.palette) ? raw.palette.map(hex) : [];
  if (!name || !background || !foreground || colors.length < 8 || colors.slice(0, 8).some((color) => !color)) return undefined;
  const palette = Array.from({ length: 16 }, (_, i) => colors[i] ?? colors[i % 8]!) as string[];
  const scheme: ColorScheme = { name, background, foreground, palette };
  for (const field of ['cursor', 'cursorText', 'selection'] as const) {
    const color = hex(raw[field]);
    if (color) scheme[field] = color;
  }
  if (Array.isArray(raw.locked)) {
    scheme.locked = raw.locked.filter((slot): slot is Slot => typeof slot === 'string' && isSlot(slot));
  }
  if (typeof raw.source === 'string') scheme.source = raw.source;
  return scheme;
}

export function isSlot(slot: string): slot is Slot {
  return ['background', 'foreground', 'cursor', 'cursorText', 'selection'].includes(slot) || (/^\d+$/.test(slot) && Number(slot) < 16);
}

const packed = (hex: string) => parseInt(hex.slice(1), 16);

/** The colors herdr-web draws a panel with. */
export function schemeTheme(scheme: ColorScheme): Theme {
  return {
    background: packed(scheme.background),
    foreground: packed(scheme.foreground),
    cursor: packed(scheme.cursor ?? scheme.foreground),
    palette: scheme.palette.map(packed),
  };
}
