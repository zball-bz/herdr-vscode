// Color math for terminal schemes: sRGB hex, OKLab/OKLCH (Björn Ottosson's
// perceptual space, used to edit colors and to measure how far they move),
// sRGB gamut mapping, and APCA lightness contrast (Lc), used to measure how
// readable text is. Pure and dependency-free, shared by the extension and the
// settings webview.

/** sRGB channels in 0..1. */
export type Rgb = [number, number, number];

export interface Oklab {
  L: number;
  a: number;
  b: number;
}

export interface Oklch {
  L: number;
  C: number;
  /** Hue in degrees, 0..360. */
  h: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `r,g,b` (0..255), else undefined. */
export function parseColor(text: string): Rgb | undefined {
  const value = text.trim();
  let match = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  if (match) return [0, 2, 4].map((at) => parseInt(match![1].slice(at, at + 2), 16) / 255) as Rgb;
  match = /^#?([0-9a-f]{3})$/i.exec(value);
  if (match) return [...match[1]].map((digit) => parseInt(digit + digit, 16) / 255) as Rgb;
  match = /^(?:rgba?\()?\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)?$/i.exec(value);
  if (match) {
    const channels = match.slice(1, 4).map(Number);
    if (channels.every((channel) => channel <= 255)) return channels.map((channel) => channel / 255) as Rgb;
  }
  return undefined;
}

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((channel) => Math.round(clamp01(channel) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The hex form of a color string, or undefined when it is not one. */
export function normalizeHex(text: string): string | undefined {
  const rgb = parseColor(text);
  return rgb && toHex(rgb);
}

export const toLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
export const fromLinear = (channel: number) => (channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]: Rgb): Oklab {
  const [lr, lg, lb] = [r, g, b].map(toLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB of an OKLab color, possibly outside 0..1 (out of gamut). */
export function oklabToLinear({ L, a, b }: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToRgb(lab: Oklab): Rgb {
  return oklabToLinear(lab).map((channel) => fromLinear(clamp01(channel))) as Rgb;
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return { L, C: Math.hypot(a, b), h: h < 0 ? h + 360 : h };
}

export function oklchToOklab({ L, C, h }: Oklch): Oklab {
  const radians = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(radians), b: C * Math.sin(radians) };
}

export const rgbToOklch = (rgb: Rgb) => oklabToOklch(rgbToOklab(rgb));

const GAMUT_EPSILON = 1e-6;
const inGamut = (lab: Oklab) => oklabToLinear(lab).every((channel) => channel >= -GAMUT_EPSILON && channel <= 1 + GAMUT_EPSILON);

/**
 * The sRGB color nearest `lch` in hue and lightness: chroma is reduced (never
 * hue or lightness) until it fits the gamut, as CSS Color 4 maps colors.
 */
export function oklchToRgb(lch: Oklch): Rgb {
  const L = clamp01(lch.L);
  let lab = oklchToOklab({ L, C: lch.C, h: lch.h });
  if (!inGamut(lab)) {
    let [low, high] = [0, lch.C];
    for (let i = 0; i < 24; i++) {
      const C = (low + high) / 2;
      if (inGamut(oklchToOklab({ L, C, h: lch.h }))) low = C;
      else high = C;
    }
    lab = oklchToOklab({ L, C: low, h: lch.h });
  }
  return oklabToRgb(lab);
}

/** Euclidean distance in OKLab: how different two colors look (0.02 ≈ just noticeable). */
export function deltaEOk(x: Rgb, y: Rgb): number {
  const [p, q] = [rgbToOklab(x), rgbToOklab(y)];
  return Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
}

/** Hue difference in degrees, 0..180. */
export function hueDistance(x: number, y: number): number {
  const d = Math.abs(x - y) % 360;
  return d > 180 ? 360 - d : d;
}

// --- APCA (SAPC-APCA 0.0.98G-4g) -------------------------------------------------

const APCA = {
  trc: 2.4,
  r: 0.2126729,
  g: 0.7151522,
  b: 0.072175,
  normBg: 0.56,
  normText: 0.57,
  revText: 0.62,
  revBg: 0.65,
  blackThreshold: 0.022,
  blackClamp: 1.414,
  scale: 1.14,
  offset: 0.027,
  deltaYMin: 0.0005,
  lowClip: 0.1,
};

/** APCA's screen luminance estimate, with its soft clamp near black. */
export function apcaY([r, g, b]: Rgb): number {
  const y = APCA.r * r ** APCA.trc + APCA.g * g ** APCA.trc + APCA.b * b ** APCA.trc;
  return y > APCA.blackThreshold ? y : y + (APCA.blackThreshold - y) ** APCA.blackClamp;
}

/**
 * APCA lightness contrast of `text` on `background`: about 0..106 for dark
 * text on light, 0..-108 for light text on dark. |Lc| 75 suits body text, 60
 * content text, 45 large or secondary text, 30 the least for anything legible.
 */
export function apcaLc(text: Rgb, background: Rgb): number {
  const [yText, yBg] = [apcaY(text), apcaY(background)];
  if (Math.abs(yBg - yText) < APCA.deltaYMin) return 0;
  if (yBg > yText) {
    const sapc = (yBg ** APCA.normBg - yText ** APCA.normText) * APCA.scale;
    return sapc < APCA.lowClip ? 0 : (sapc - APCA.offset) * 100;
  }
  const sapc = (yBg ** APCA.revBg - yText ** APCA.revText) * APCA.scale;
  return sapc > -APCA.lowClip ? 0 : (sapc + APCA.offset) * 100;
}

/** WCAG 2 contrast ratio, 1..21, for reference next to APCA. */
export function wcagRatio(x: Rgb, y: Rgb): number {
  const luminance = (rgb: Rgb) => 0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2]);
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}
