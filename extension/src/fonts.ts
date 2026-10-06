// The terminal font as herdr-web draws it: a CSS font stack that the browser in
// the webview resolves, measures and rasterizes, as VS Code's own terminal
// does. No font files are read or sent, so any installed font works (font
// collections included), a remote window uses the fonts of the machine showing
// it, and the browser supplies glyphs (CJK, emoji) the family lacks.

export interface FontSettings {
  /** CSS font stack, e.g. terminal.integrated.fontFamily. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /** herdr.fontFallbacks, tried after the stack's own fallbacks. */
  fallbacks: string[];
}

export interface ResolvedFonts {
  family: string;
  fallbacks: string[];
  fontSize: number;
  cellHeight: number;
}

/** Generic families end every stack herdr-web builds; quoted, they would name no font. */
const GENERIC = new Set(['monospace', 'ui-monospace', 'sans-serif', 'serif', 'system-ui', 'emoji']);

/** Splits a CSS font stack, dropping quotes: `'Fira Code', monospace` → [Fira Code, monospace]. */
export function fontStack(css: string): string[] {
  const names: string[] = [];
  for (const match of css.matchAll(/\s*(?:"([^"]*)"|'([^']*)'|([^,]+))\s*(?:,|$)/g)) {
    const name = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (name) names.push(name);
  }
  return names;
}

export function cellHeight(fontSize: number, lineHeight: number): number {
  return Math.round(fontSize * lineHeight * 1.43);
}

export function resolveFonts(settings: FontSettings): ResolvedFonts {
  const named = [...fontStack(settings.fontFamily), ...settings.fallbacks].filter((name) => !GENERIC.has(name.toLowerCase()));
  const [family = 'monospace', ...fallbacks] = [...new Set(named)];
  return { family, fallbacks, fontSize: settings.fontSize, cellHeight: cellHeight(settings.fontSize, settings.lineHeight) };
}
