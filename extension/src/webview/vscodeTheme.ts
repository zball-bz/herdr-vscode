// The VS Code terminal colors a webview sees as CSS variables (the active
// color theme with any workbench.colorCustomizations applied).
import type { Theme } from '../protocol';

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];
const PALETTE = [...ANSI, ...ANSI.map((name) => `Bright${name}`)].map((name) => `--vscode-terminal-ansi${name}`);
const scratch = document.createElement('canvas').getContext('2d')!;

/** RGBA of a CSS color, or undefined when unset or invalid. */
function rgba(text: string): [number, number, number, number] | undefined {
  if (!text || !CSS.supports('color', text)) return undefined;
  scratch.fillStyle = '#000000';
  scratch.fillStyle = text;
  const value = String(scratch.fillStyle);
  if (value.startsWith('#')) return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)).concat(1) as [number, number, number, number];
  const parts = value.match(/[\d.]+/g)?.map(Number);
  return parts && parts.length >= 3 ? [parts[0], parts[1], parts[2], parts[3] ?? 1] : undefined;
}

/** 0xRRGGBB, with translucent colors composited over `under`. */
function color(text: string, under = 0): number | undefined {
  const value = rgba(text);
  if (!value) return undefined;
  const [r, g, b, a] = value;
  const mix = (c: number, shift: number) => Math.round(c * a + ((under >> shift) & 0xff) * (1 - a));
  return (mix(r, 16) << 16) | (mix(g, 8) << 8) | mix(b, 0);
}

/** The VS Code terminal colors, from the theme's CSS variables. */
export function readTheme(): Theme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const background =
    color(read('--vscode-terminal-background')) ?? color(read('--vscode-editor-background')) ?? color(read('--vscode-panel-background'));
  const under = background ?? 0;
  const foreground = color(read('--vscode-terminal-foreground'), under) ?? color(read('--vscode-foreground'), under);
  return {
    background,
    foreground,
    cursor: color(read('--vscode-terminalCursor-foreground'), under) ?? foreground,
    palette: PALETTE.map((name) => color(read(name), under) ?? null),
  };
}
