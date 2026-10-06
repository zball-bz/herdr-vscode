// Messages between the extension host and the webviews. The extension owns the
// daemon transport and only relays opaque bytes; herdr-web (WASM) in the
// webview speaks herdr's client protocol. The settings page has its own pair.
import type { ColorScheme } from './colors/scheme';
import type { SchemeFormat } from './colors/formats';

/** Theme as herdr-web's `run` config takes it: colors are 0xRRGGBB numbers. */
export interface Theme {
  background?: number;
  foreground?: number;
  cursor?: number;
  palette: (number | null)[];
}

/** herdr-web `run` config. */
export interface ViewConfig {
  /**
   * Colors of the `herdr.colorScheme` in use; without one the webview reads
   * VS Code's terminal colors and follows theme changes.
   */
  theme?: Theme;
  /** The herdr tab this view shows; herdr-web keeps its own connection on it. */
  tabId: string;
  /**
   * Font bytes for GPUI's own text system. The extension sends none: a family
   * without bytes is drawn with the browser's fonts (see fonts.ts).
   */
  fonts: Uint8Array[];
  /** The first family of the CSS stack, then the rest, tried in order. */
  family: string;
  fallbacks: string[];
  fontSize: number;
  cellHeight: number;
  /** terminal.integrated.copyOnSelection: a finished selection emits `copy`. */
  copyOnSelect: boolean;
}

/** Events herdr-web accepts through `host_event`. */
export type HostEvent =
  | { type: 'open' }
  | { type: 'closed'; reason: string }
  | { type: 'paste'; text: string }
  | { type: 'focus'; focused: boolean }
  | { type: 'command'; name: ViewCommand }
  /** The panel was shown or hidden: a hidden view stops receiving surfaces. */
  | { type: 'visibility'; visible: boolean };

export type ViewCommand = 'find' | 'findNext' | 'findPrevious' | 'closeFind' | 'copy' | 'clearSelection' | 'scrollToBottom';

/**
 * How to open a link: `follow` is a link-modifier click (the editor for a
 * path, VS Code's external opener for a web address); the others are the
 * hover toolbar's buttons.
 */
export type LinkOpen = 'follow' | 'vscode' | 'external' | 'side';

/** A link as herdr-web reports it: `path` links carry their pane's working directory. */
export interface LinkTarget {
  kind: 'web' | 'path';
  /** `path` targets may end in `:line[:col]`. */
  target: string;
  /** The pane that printed a `path` link; web links carry none. */
  paneId?: string;
  /** The pane's foreground working directory. */
  cwd?: string | null;
}

/** Events herdr-web emits through `host.event`. */
export type ViewEvent =
  | { type: 'status'; text: string }
  /** Graphics started; the view will measure itself and send its hello. */
  | { type: 'ready' }
  /** The view cannot run, e.g. neither WebGPU nor WebGL2 started (`kind: 'graphics'`). */
  | { type: 'error'; kind: string; text: string }
  | ({ type: 'openLink'; open?: LinkOpen } & LinkTarget)
  /**
   * The link under the pointer changed (no `kind`: none), with its cells in
   * CSS pixels. The webview shows its toolbar; the extension never sees it.
   */
  | ({ type: 'linkHover'; x?: number; y?: number; width?: number; height?: number } & Partial<LinkTarget>)
  | { type: 'copy'; text: string }
  /** Ctrl+Shift+V / Cmd+V in the view: answer with a `paste` host event. */
  | { type: 'requestPaste' }
  /** The view's tab no longer exists (its pane exited or was closed). */
  | { type: 'tabClosed'; tabId: string };

/** Webview behavior outside herdr-web. */
export interface WebviewOptions {
  /** Keys to intercept (see `key`). */
  keys: string[];
  /** terminal.integrated.showLinkHover: offer the link toolbar on hover. */
  linkHover: boolean;
}

export type ToWebview =
  /** Start herdr-web. */
  | { type: 'init'; config: ViewConfig; options: WebviewOptions }
  /** Daemon bytes for `deliver`. */
  | { type: 'bytes'; data: Uint8Array }
  /** A host event for `host_event`. */
  | { type: 'host'; event: HostEvent }
  /** New options after a settings change. */
  | { type: 'options'; options: WebviewOptions };

/** Extension → settings page. */
export type SettingsToWebview =
  | { type: 'state'; schemes: ColorScheme[]; active: string; konsole: { name: string; current: boolean }[] }
  /** Show this scheme in the editor (after an import, a save under a new name). */
  | { type: 'select'; name: string }
  | { type: 'notice'; text: string; error?: boolean };

/** Settings page → extension. */
export type SettingsFromWebview =
  | { type: 'ready' }
  /** Store `scheme`, replacing `previousName` (a rename) or a scheme of its name. */
  | { type: 'save'; scheme: ColorScheme; previousName?: string }
  | { type: 'delete'; name: string }
  /** Use this scheme for herdr panels; '' follows the VS Code theme. */
  | { type: 'activate'; name: string }
  | { type: 'importFile' }
  /** A file dropped on the page. */
  | { type: 'importText'; text: string; fileName: string }
  | { type: 'importKonsole'; name: string }
  | { type: 'export'; name: string; format: SchemeFormat }
  /** Write the scheme into workbench.colorCustomizations, for VS Code's own terminal. */
  | { type: 'applyToVsCode'; name: string }
  | { type: 'resetVsCode' }
  | { type: 'openSettings' };

export type FromWebview =
  /** The script loaded; the extension answers with `init`. */
  | { type: 'ready' }
  /** `run` returned: (re)connect the transport, then send `open`. */
  | { type: 'started' }
  /**
   * herdr-web painted its first frame since `started`. `timings` are load
   * milestones in ms since the webview began loading: `script` (this script
   * ran), `wasm` (compiled and instantiated), `init` (fonts arrived), `run`
   * (herdr-web started), `painted`.
   */
  | { type: 'painted'; timings?: Record<string, number> }
  /** Bytes for the daemon, from `host.send`, written unchanged. */
  | { type: 'send'; data: Uint8Array }
  /** A parsed `host.event` from herdr-web. */
  | { type: 'event'; event: ViewEvent }
  /** The webview gained or lost keyboard focus. */
  | { type: 'focus'; focused: boolean }
  /** An intercepted key from `herdr.editorKeys` (canonical form). */
  | { type: 'key'; key: string }
  /** The VS Code theme colors changed; the view needs a restart to apply them. */
  | { type: 'themeChanged' }
  /** The GPU device or WebGL context was lost; GPUI cannot paint again without a reload. */
  | { type: 'graphicsLost' }
  /** Console output of the webview (herdr-web and GPUI log there). */
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'log'; text: string };
