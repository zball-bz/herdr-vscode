// Readability for a terminal scheme. Each color has a role (body text, colored
// text, secondary text, cursor, or none), and a role a minimum APCA contrast
// (Lc) against the background. Optimizing moves each short color in OKLCH
// lightness only, keeping its hue and as much chroma as sRGB allows, by the
// least amount that reaches its target; the background never moves. A second
// pass keeps every bright color tellable from its normal one, and the result
// reports what moved, by how much (ΔE in OKLab), and what could not reach.
//
// Why APCA for the measure and OKLab for the moves: legibility follows the
// luminance contrast between text and background, which APCA models (with
// polarity: dark-on-light and light-on-dark differ). OKLab lightness also
// rises with chroma, so saturated blue on black reads lighter in OKLab
// (L 0.45) than it is legible (APCA Lc 16, WCAG 2.4:1). OKLab is where colors
// are edited and compared: equal steps look equal, and hue holds still.
import { apcaLc, apcaY, deltaEOk, hueDistance, oklchToRgb, parseColor, type Rgb, rgbToOklch, toHex } from './color';
import { ANSI_NAMES, type ColorScheme, isDark, type Slot, slotColor, slotLabel, withSlot } from './scheme';

export type Level = 'relaxed' | 'standard' | 'high';
export type Role = 'body' | 'text' | 'secondary' | 'cursor' | 'none';

/** Minimum |Lc| per role (APCA's guidance: 75 body text, 60 content, 45 large or secondary, 30 marks). */
export const LEVELS: Record<Level, Record<Exclude<Role, 'none'>, number>> = {
  relaxed: { body: 60, text: 45, secondary: 30, cursor: 30 },
  standard: { body: 75, text: 60, secondary: 45, cursor: 45 },
  high: { body: 90, text: 75, secondary: 60, cursor: 60 },
};

/** Bright and normal variants closer than this (ΔE in OKLab) read as one color. */
const MIN_VARIANT_DELTA = 0.03;
/** Hues closer than this (ΔE in OKLab) are hard to tell apart in text. */
const MIN_HUE_DELTA = 0.08;

/**
 * What each color is for. Black on a dark scheme is a background tint, rarely
 * text, so it has no target; on a light scheme it is text. White is text on
 * either: light schemes darken it, as light terminal themes do.
 */
export function roles(scheme: ColorScheme): Partial<Record<Slot, Role>> {
  const dark = isDark(scheme);
  const out: Partial<Record<Slot, Role>> = { foreground: 'body', cursor: 'cursor', background: 'none', selection: 'none', cursorText: 'none' };
  for (let i = 0; i < 16; i++) {
    const slot = `${i}` as Slot;
    out[slot] = i === 8 ? 'secondary' : i === 0 ? (dark ? 'none' : 'text') : 'text';
  }
  return out;
}

export interface Reading {
  slot: Slot;
  label: string;
  role: Role;
  /** Minimum |Lc|; 0 for no target. */
  target: number;
  color: string;
  /** APCA Lc against the background (signed: negative is light on dark). */
  lc: number;
  pass: boolean;
}

const rgb = (hex: string): Rgb => parseColor(hex) ?? [0, 0, 0];

/** How readable each color of `scheme` is against its background. */
export function readability(scheme: ColorScheme, level: Level = 'standard'): Reading[] {
  const background = rgb(scheme.background);
  const assigned = roles(scheme);
  const slots: Slot[] = ['foreground', 'cursor', ...Array.from({ length: 16 }, (_, i) => `${i}` as Slot)];
  return slots.map((slot) => {
    const color = slotColor(scheme, slot) ?? scheme.foreground;
    const role = assigned[slot] ?? 'none';
    const target = role === 'none' ? 0 : LEVELS[level][role];
    const lc = apcaLc(rgb(color), background);
    return { slot, label: slotLabel(slot), role, target, color, lc, pass: Math.abs(lc) >= target - 0.05 };
  });
}

/**
 * The color nearest `color` (lightness only, hue kept, chroma as sRGB allows)
 * whose |Lc| on `background` reaches `target`; on the side of the background
 * the color is already on, else the other one. Unreachable: the best there is.
 */
export function reach(color: Rgb, background: Rgb, target: number): { color: Rgb; reached: boolean } {
  const contrast = (candidate: Rgb) => Math.abs(apcaLc(candidate, background));
  if (contrast(color) >= target) return { color, reached: true };
  const lch = rgbToOklch(color);
  // Searched as stored (#rrggbb), so the color found passes once written.
  const at = (L: number) => rgb(toHex(oklchToRgb({ L, C: lch.C, h: lch.h })));
  const darker = apcaY(color) <= apcaY(background);
  let best: { color: Rgb; reached: boolean } | undefined;
  for (const end of darker ? [0, 1] : [1, 0]) {
    if (contrast(at(end)) < target) {
      if (!best || contrast(at(end)) > contrast(best.color)) best = { color: at(end), reached: false };
      continue;
    }
    // The least move from the color's own lightness toward `end`.
    let [near, far] = [lch.L, end];
    for (let i = 0; i < 32; i++) {
      const middle = (near + far) / 2;
      if (contrast(at(middle)) >= target) far = middle;
      else near = middle;
    }
    return { color: at(far), reached: true };
  }
  return best ?? { color, reached: false };
}

export interface Change extends Reading {
  before: string;
  lcBefore: number;
  /** How far the color moved, in OKLab ΔE (0.02 ≈ just noticeable). */
  deltaE: number;
  reached: boolean;
  locked: boolean;
}

export interface Optimized {
  scheme: ColorScheme;
  changes: Change[];
  notes: string[];
}

export function optimize(scheme: ColorScheme, level: Level = 'standard'): Optimized {
  const background = rgb(scheme.background);
  const locked = new Set(scheme.locked ?? []);
  let result = scheme;
  const reached = new Map<Slot, boolean>();
  for (const reading of readability(scheme, level)) {
    if (!reading.target || locked.has(reading.slot)) continue;
    const moved = reach(rgb(reading.color), background, reading.target);
    reached.set(reading.slot, moved.reached);
    result = withSlot(result, reading.slot, toHex(moved.color));
  }
  const notes: string[] = [];
  // A bright color pulled onto its normal one (or left there) moves on, away
  // from the background, so the two stay apart.
  for (let i = 1; i < 8; i++) {
    const [normal, bright] = [result.palette[i], result.palette[i + 8]];
    if (deltaEOk(rgb(normal), rgb(bright)) >= MIN_VARIANT_DELTA) continue;
    const slot = `${i + 8}` as Slot;
    if (locked.has(slot)) {
      notes.push(`${ANSI_NAMES[i]} and Bright ${ANSI_NAMES[i]} look the same (Bright ${ANSI_NAMES[i]} is locked).`);
      continue;
    }
    const lch = rgbToOklch(rgb(bright));
    const away = isDark(result) ? 1 : -1;
    let moved = rgb(bright);
    for (let step = 1; step <= 10 && deltaEOk(rgb(normal), moved) < MIN_VARIANT_DELTA; step++) {
      moved = oklchToRgb({ ...lch, L: lch.L + away * 0.012 * step });
    }
    result = withSlot(result, slot, toHex(moved));
    if (deltaEOk(rgb(normal), moved) < MIN_VARIANT_DELTA) notes.push(`${ANSI_NAMES[i]} and Bright ${ANSI_NAMES[i]} stay close (ΔE ${deltaEOk(rgb(normal), moved).toFixed(3)}).`);
  }
  // Hues that end up alike are reported, not moved: hue is the colors' identity.
  for (let i = 1; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      const [x, y] = [rgb(result.palette[i]), rgb(result.palette[j])];
      const delta = deltaEOk(x, y);
      if (delta < MIN_HUE_DELTA && hueDistance(rgbToOklch(x).h, rgbToOklch(y).h) < 60) {
        notes.push(`${ANSI_NAMES[i]} and ${ANSI_NAMES[j]} are hard to tell apart (ΔE ${delta.toFixed(3)}).`);
      }
    }
  }
  const before = new Map(readability(scheme, level).map((reading) => [reading.slot, reading]));
  const changes = readability(result, level).map((after): Change => {
    const was = before.get(after.slot)!;
    return {
      ...after,
      before: was.color,
      lcBefore: was.lc,
      deltaE: deltaEOk(rgb(was.color), rgb(after.color)),
      reached: reached.get(after.slot) ?? after.pass,
      locked: locked.has(after.slot),
    };
  });
  for (const change of changes) {
    if (change.target && !change.reached && !change.locked) {
      notes.push(`${change.label} reaches Lc ${Math.abs(change.lc).toFixed(0)} at most on this background (target ${change.target}).`);
    }
  }
  return { scheme: result, changes, notes };
}
