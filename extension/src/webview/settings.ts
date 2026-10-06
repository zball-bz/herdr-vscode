// The settings page: color schemes on the left, the selected one's editor on
// the right (swatches with their readability, an OKLCH editor for one color,
// the readability optimizer, a terminal preview). Edits stay in a draft until
// saved; the extension stores schemes and answers with fresh state.
import { apcaLc, apcaY, deltaEOk, oklchToRgb, parseColor, type Rgb, rgbToOklch, toHex, wcagRatio } from '../colors/color';
import { FORMATS, type SchemeFormat } from '../colors/formats';
import { LEVELS, type Level, type Optimized, optimize, readability, type Reading } from '../colors/optimize';
import { ANSI_NAMES, type ColorScheme, type Slot, slotColor, slotLabel, withSlot } from '../colors/scheme';
import type { SettingsFromWebview, SettingsToWebview } from '../protocol';
import { readTheme } from './vscodeTheme';

declare function acquireVsCodeApi(): {
  postMessage(message: SettingsFromWebview): void;
  getState(): unknown;
  setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
const post = (message: SettingsFromWebview) => vscode.postMessage(message);

interface Saved {
  selected?: string;
  slot?: Slot;
  level?: Level;
}
const saved = (vscode.getState() ?? {}) as Saved;

let schemes: ColorScheme[] = [];
let active = '';
let konsole: { name: string; current: boolean }[] = [];
let selected = saved.selected;
let draft: ColorScheme | undefined;
let dirty = false;
let slot: Slot = saved.slot ?? 'foreground';
let level: Level = saved.level ?? 'standard';
let proposal: Optimized | undefined;

const ROLE_TEXT = {
  body: 'body text',
  text: 'colored text',
  secondary: 'secondary text (comments, dim output)',
  cursor: 'the cursor block',
  none: 'no readability target',
};

type Child = Node | string | null | undefined | false;

/** `replaceChildren` that skips the absent ones. */
function fill(element: Element, ...children: Child[]): void {
  element.replaceChildren(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: {
    class?: string;
    style?: string;
    title?: string;
    on?: Record<string, (event: Event) => void>;
    [key: string]: unknown;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === 'on')
      for (const [type, handler] of Object.entries(value as Record<string, (event: Event) => void>)) element.addEventListener(type, handler);
    else if (key === 'class') element.className = String(value);
    else if (key === 'style') element.setAttribute('style', String(value));
    else if (key in element) (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== null && child !== undefined && child !== false) element.append(child);
  return element;
}

const rgb = (hex: string): Rgb => parseColor(hex) ?? [0, 0, 0];
/** Black or white, whichever reads on `hex`. */
const inkOn = (hex: string) => (apcaY(rgb(hex)) > 0.36 ? '#000' : '#fff');
const lcText = (lc: number) => `Lc ${Math.abs(lc).toFixed(0)}`;
const stored = () => schemes.find((scheme) => scheme.name === selected);

function remember(): void {
  vscode.setState({ selected, slot, level } satisfies Saved);
}

function select(name: string | undefined): void {
  selected = name;
  const scheme = stored();
  draft = scheme && structuredClone(scheme);
  dirty = false;
  proposal = undefined;
  remember();
  render();
}

function edit(next: ColorScheme, full = false): void {
  draft = next;
  dirty = JSON.stringify(draft) !== JSON.stringify(stored());
  proposal = undefined;
  if (full) render();
  else refresh();
}

// --- the page ------------------------------------------------------------------

const app = document.getElementById('app')!;
const parts = {
  list: h('div'),
  title: h('div'),
  swatches: h('div'),
  slot: h('div'),
  readability: h('div'),
  preview: h('div'),
};

function render(): void {
  renderList();
  fill(
    app,
    h('h1', {}, 'Herdr Settings'),
    h('p', { class: 'sub' }, 'Terminal color schemes for herdr panels: import, export, edit, and tune for readability.'),
    h(
      'div',
      { class: 'row' },
      h('label', { for: 'active' }, 'Herdr panels use'),
      h(
        'select',
        {
          id: 'active',
          on: {
            change: (event) =>
              post({
                type: 'activate',
                name: (event.target as HTMLSelectElement).value,
              }),
          },
        },
        h('option', { value: '', selected: !active }, 'the VS Code theme'),
        ...schemes.map((scheme) => h('option', { value: scheme.name, selected: scheme.name === active }, scheme.name)),
      ),
      h('button', { on: { click: () => post({ type: 'openSettings' }) } }, 'All herdr settings…'),
    ),
    h(
      'div',
      { class: 'columns', style: 'margin-top: 16px' },
      parts.list,
      draft ? editor() : h('p', { class: 'muted' }, 'Import or create a scheme to edit it here.'),
    ),
  );
}

function renderList(): void {
  const konsolePick = h(
    'select',
    { id: 'konsole' },
    ...konsole.map((entry) => h('option', { value: entry.name }, `${entry.name}${entry.current ? ' (current)' : ''}`)),
  );
  parts.list.className = 'list';
  fill(
    parts.list,
    h(
      'div',
      { class: 'row' },
      h('button', { on: { click: () => post({ type: 'importFile' }) } }, 'Import…'),
      h(
        'button',
        {
          title: "A scheme from VS Code's current terminal colors",
          on: { click: fromVsCode },
        },
        'From VS Code theme',
      ),
    ),
    konsole.length
      ? h(
          'div',
          { class: 'row', style: 'margin-top: 6px' },
          konsolePick,
          h(
            'button',
            {
              on: {
                click: () => post({ type: 'importKonsole', name: konsolePick.value }),
              },
            },
            'Import from Konsole',
          ),
        )
      : null,
    h(
      'ul',
      {},
      ...schemes.map((scheme) =>
        h(
          'li',
          {
            class: scheme.name === selected ? 'selected' : '',
            on: { click: () => select(scheme.name) },
          },
          h('div', { class: 'name' }, h('span', {}, scheme.name), scheme.name === active ? h('span', { class: 'badge' }, 'in use') : null),
          h(
            'div',
            { class: 'mini' },
            ...[scheme.background, scheme.foreground, ...scheme.palette].map((color) => h('span', { style: `background:${color}` })),
          ),
        ),
      ),
    ),
    h('p', { class: 'drop' }, 'Drop Konsole, iTerm2, Windows Terminal, Ghostty, Alacritty, kitty, VS Code or Xresources files here to import them.'),
  );
}

function editor(): HTMLElement {
  renderTitle();
  refresh();
  renderSlot();
  return h('div', {}, parts.title, parts.swatches, parts.slot, parts.readability, parts.preview);
}

/** Everything that shows colors, without rebuilding the inputs being used. */
function refresh(): void {
  renderTitleState();
  renderSwatches();
  renderSlotReadout();
  renderReadability();
  renderPreview();
}

function renderTitle(): void {
  if (!draft) return;
  const name = h('input', {
    type: 'text',
    value: draft.name,
    style: 'font-size: 1.2em; min-width: 16em',
    on: {
      input: (event) => edit({ ...draft!, name: (event.target as HTMLInputElement).value }),
    },
  });
  const format = h('select', { title: 'Export format' }, ...Object.entries(FORMATS).map(([key, value]) => h('option', { value: key }, value.label)));
  fill(
    parts.title,
    h('div', { class: 'row' }, name, draft.source ? h('span', { class: 'muted' }, draft.source) : null),
    h(
      'div',
      { class: 'row', style: 'margin-top: 8px' },
      h('button', { class: 'primary', id: 'save', on: { click: save } }, 'Save'),
      h('button', { id: 'revert', on: { click: () => select(selected) } }, 'Revert'),
      h(
        'button',
        {
          id: 'use',
          on: { click: () => post({ type: 'activate', name: selected ?? '' }) },
        },
        'Use for herdr panels',
      ),
      h(
        'button',
        {
          title: 'Write it into workbench.colorCustomizations',
          on: {
            click: () => post({ type: 'applyToVsCode', name: selected ?? '' }),
          },
        },
        "Use for VS Code's terminal",
      ),
      h(
        'button',
        {
          title: 'Remove the terminal colors from workbench.colorCustomizations',
          on: { click: () => post({ type: 'resetVsCode' }) },
        },
        'Reset VS Code terminal',
      ),
    ),
    h(
      'div',
      { class: 'row', style: 'margin-top: 6px' },
      h('button', { on: { click: duplicate } }, 'Duplicate'),
      format,
      h(
        'button',
        {
          on: {
            click: () =>
              dirty
                ? notice('Save the scheme before exporting it.', true)
                : post({
                    type: 'export',
                    name: selected ?? '',
                    format: format.value as SchemeFormat,
                  }),
          },
        },
        'Export',
      ),
      h('button', { on: { click: () => post({ type: 'delete', name: selected ?? '' }) } }, 'Delete'),
    ),
  );
}

function renderTitleState(): void {
  const save = parts.title.querySelector<HTMLButtonElement>('#save');
  if (save) save.disabled = !dirty;
  const revert = parts.title.querySelector<HTMLButtonElement>('#revert');
  if (revert) revert.disabled = !dirty;
  const use = parts.title.querySelector<HTMLButtonElement>('#use');
  if (use) {
    use.disabled = selected === active || dirty;
    use.textContent = selected === active ? 'In use by herdr panels' : 'Use for herdr panels';
  }
}

function swatch(target: Slot, reading: Reading | undefined, small = false): HTMLElement {
  const color = slotColor(draft!, target) ?? (target === 'cursor' ? draft!.foreground : target === 'cursorText' ? draft!.background : undefined);
  const locked = draft!.locked?.includes(target);
  return h(
    'button',
    {
      class: `swatch${target === slot ? ' selected' : ''}${color ? '' : ' unset'}`,
      style: color ? `background:${color}` : '',
      title: `${slotLabel(target)} ${color ?? '(unset)'}`,
      'data-slot': target,
      on: {
        click: () => {
          slot = target;
          remember();
          renderSwatches();
          renderSlot();
        },
      },
    },
    small ? h('span', { class: 'name', style: color ? `color:${inkOn(color)}` : '' }, `${slotLabel(target)}${color ? '' : ' (unset)'}`) : null,
    locked ? h('span', { class: 'lock', style: `color:${inkOn(color ?? '#000000')}` }, '🔒') : null,
    reading && reading.target ? h('span', { class: `lc${reading.pass ? '' : ' fail'}` }, lcText(reading.lc)) : null,
  );
}

function renderSwatches(): void {
  if (!draft) return;
  const readings = new Map(readability(draft, level).map((reading) => [reading.slot, reading]));
  const cells: Child[] = [];
  for (const [label, offset] of [
    ['Normal', 0],
    ['Bright', 8],
  ] as const) {
    cells.push(h('span', { class: 'label' }, label));
    for (let i = 0; i < 8; i++) {
      const target = `${offset + i}` as Slot;
      const cell = swatch(target, readings.get(target));
      cell.title = `${slotLabel(target)} ${draft.palette[offset + i]}`;
      cells.push(cell);
    }
  }
  fill(
    parts.swatches,
    h('h2', {}, 'Colors'),
    h(
      'div',
      { class: 'roles' },
      ...(['background', 'foreground', 'cursor', 'selection'] as Slot[]).map((target) => swatch(target, readings.get(target), true)),
    ),
    h('div', { class: 'grid' }, h('span'), ...ANSI_NAMES.map((name) => h('span', { class: 'label' }, name)), ...cells),
  );
}

// --- one color ---------------------------------------------------------------------

const slotInputs = {
  picker: h('input', { type: 'color' }),
  hex: h('input', { type: 'text', size: 9 }),
  L: h('input'),
  C: h('input'),
  h: h('input'),
  lock: h('input', { type: 'checkbox' }),
};
const slotOut = {
  title: h('strong'),
  role: h('span', { class: 'muted' }),
  L: h('span', { class: 'value' }),
  C: h('span', { class: 'value' }),
  h: h('span', { class: 'value' }),
  contrast: h('span'),
};

function setSlotColor(hex: string): void {
  if (!draft) return;
  edit(withSlot(draft, slot, hex));
}

for (const [key, max, step] of [
  ['L', 1, 0.001],
  ['C', 0.37, 0.001],
  ['h', 360, 0.5],
] as const) {
  Object.assign(slotInputs[key], { type: 'range', min: 0, max, step });
  slotInputs[key].addEventListener('input', () => {
    const lch = {
      L: Number(slotInputs.L.value),
      C: Number(slotInputs.C.value),
      h: Number(slotInputs.h.value),
    };
    setSlotColor(toHex(oklchToRgb(lch)));
  });
}
slotInputs.picker.addEventListener('input', () => {
  setSlotColor(slotInputs.picker.value);
  syncSliders();
});
slotInputs.hex.addEventListener('change', () => {
  const color = parseColor(slotInputs.hex.value);
  if (!color) return notice(`Not a color: ${slotInputs.hex.value}`, true);
  setSlotColor(toHex(color));
  syncSliders();
});
slotInputs.lock.addEventListener('change', () => {
  if (!draft) return;
  const locked = new Set(draft.locked ?? []);
  if (slotInputs.lock.checked) locked.add(slot);
  else locked.delete(slot);
  edit({ ...draft, locked: [...locked] }, false);
  renderSwatches();
});

function currentColor(): string {
  return (draft && slotColor(draft, slot)) ?? (slot === 'cursor' ? draft?.foreground : draft?.background) ?? '#000000';
}

function syncSliders(): void {
  const lch = rgbToOklch(rgb(currentColor()));
  slotInputs.L.value = String(lch.L);
  slotInputs.C.value = String(lch.C);
  slotInputs.h.value = String(lch.h);
}

function renderSlot(): void {
  if (!draft) return;
  syncSliders();
  slotInputs.lock.checked = !!draft.locked?.includes(slot);
  fill(
    parts.slot,
    h(
      'div',
      { class: 'slot' },
      h('span', {}, slotOut.title),
      slotOut.role,
      h('span', {}, 'Color'),
      h('div', { class: 'row' }, slotInputs.picker, slotInputs.hex, slotOut.contrast),
      h('span', { title: 'OKLCH lightness, 0 black … 1 white' }, 'Lightness'),
      h('div', { class: 'row' }, slotInputs.L, slotOut.L),
      h('span', { title: 'OKLCH chroma; sRGB caps it per lightness and hue' }, 'Chroma'),
      h('div', { class: 'row' }, slotInputs.C, slotOut.C),
      h('span', { title: 'OKLCH hue angle' }, 'Hue'),
      h('div', { class: 'row' }, slotInputs.h, slotOut.h),
      h('span', {}, ''),
      h('label', {}, slotInputs.lock, ' Keep this color when optimizing'),
    ),
  );
  renderSlotReadout();
}

function renderSlotReadout(): void {
  if (!draft) return;
  const color = currentColor();
  const lch = rgbToOklch(rgb(color));
  const reading = readability(draft, level).find((candidate) => candidate.slot === slot);
  const role = reading?.role ?? 'none';
  slotOut.title.textContent = slotLabel(slot);
  slotOut.role.textContent = `— ${ROLE_TEXT[role]}${reading?.target ? `, target Lc ${reading.target}` : ''}`;
  if (document.activeElement !== slotInputs.hex) slotInputs.hex.value = color;
  slotInputs.picker.value = color;
  slotOut.L.textContent = lch.L.toFixed(3);
  slotOut.C.textContent = lch.C.toFixed(3);
  slotOut.h.textContent = `${lch.h.toFixed(1)}°`;
  const background = rgb(draft.background);
  const lc = apcaLc(rgb(color), background);
  const original = stored() && slotColor(stored()!, slot);
  fill(
    slotOut.contrast,
    slot === 'background'
      ? h('span', { class: 'muted' }, 'every other color is measured against this one')
      : h(
          'span',
          {
            class: reading && reading.target ? (reading.pass ? 'pass' : 'fail') : 'muted',
          },
          `${lcText(lc)} on the background · WCAG ${wcagRatio(rgb(color), background).toFixed(2)}:1`,
        ),
    original && original !== color ? h('span', { class: 'muted' }, ` · ΔE ${deltaEOk(rgb(original), rgb(color)).toFixed(3)} from saved`) : null,
  );
}

// --- readability -------------------------------------------------------------------

function renderReadability(): void {
  if (!draft) return;
  const readings = readability(draft, level).filter((reading) => reading.target);
  const failing = readings.filter((reading) => !reading.pass);
  const levelPick = h(
    'select',
    {
      on: {
        change: (event) => {
          level = (event.target as HTMLSelectElement).value as Level;
          proposal = undefined;
          remember();
          refresh();
        },
      },
    },
    ...(Object.keys(LEVELS) as Level[]).map((key) =>
      h(
        'option',
        { value: key, selected: key === level },
        `${key[0].toUpperCase()}${key.slice(1)} — body ${LEVELS[key].body}, colors ${LEVELS[key].text}, secondary ${LEVELS[key].secondary}`,
      ),
    ),
  );
  const summary = failing.length
    ? h('span', { class: 'fail' }, `${failing.length} of ${readings.length} colors fall short: ${failing.map((reading) => reading.label).join(', ')}`)
    : h('span', { class: 'pass' }, `All ${readings.length} colors are readable at this level.`);
  const rows = proposal?.changes.filter((change) => change.deltaE > 0 || (change.target && !change.reached && !change.locked)) ?? [];
  fill(
    parts.readability,
    h('h2', {}, 'Readability'),
    h(
      'p',
      { class: 'muted', style: 'margin: 0 0 8px' },
      'Each color is measured as text on the background with APCA lightness contrast (Lc), which follows how legible text is. ',
      'Optimizing moves only lightness in OKLCH — hue stays, chroma as sRGB allows — by the least amount that reaches the target, and never the background. Locked colors stay.',
    ),
    h('div', { class: 'row' }, levelPick, h('button', { class: 'primary', id: 'optimize', on: { click: runOptimize } }, 'Optimize'), summary),
    proposal
      ? h(
          'div',
          {},
          rows.length
            ? h(
                'div',
                { class: 'scroll' },
                h(
                  'table',
                  {},
                  h('tr', {}, ...['Color', 'Before', '', 'After', 'Lc', 'ΔE (OKLab)'].map((label) => h('th', {}, label))),
                  ...rows.map((change) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, change.label),
                      h(
                        'td',
                        {},
                        h('span', {
                          class: 'chip',
                          style: `background:${change.before}`,
                        }),
                        ` ${change.before}`,
                      ),
                      h('td', {}, '→'),
                      h(
                        'td',
                        {},
                        h('span', {
                          class: 'chip',
                          style: `background:${change.color}`,
                        }),
                        ` ${change.color}`,
                      ),
                      h(
                        'td',
                        { class: change.pass ? 'pass' : 'fail' },
                        `${Math.abs(change.lcBefore).toFixed(0)} → ${Math.abs(change.lc).toFixed(0)} (target ${change.target})`,
                      ),
                      h('td', {}, change.deltaE.toFixed(3)),
                    ),
                  ),
                ),
              )
            : h('p', {}, 'Nothing to change at this level.'),
          ...proposal.notes.map((note) => h('p', { class: 'muted', style: 'margin: 4px 0' }, note)),
          rows.length
            ? h(
                'div',
                { class: 'row', style: 'margin-top: 8px' },
                h(
                  'button',
                  {
                    class: 'primary',
                    id: 'apply-proposal',
                    on: { click: applyProposal },
                  },
                  'Apply changes',
                ),
                h(
                  'button',
                  {
                    on: {
                      click: () => ((proposal = undefined), renderReadability(), renderPreview()),
                    },
                  },
                  'Discard',
                ),
              )
            : null,
        )
      : null,
  );
}

function runOptimize(): void {
  if (!draft) return;
  proposal = optimize(draft, level);
  renderReadability();
  renderPreview();
}

function applyProposal(): void {
  if (!proposal || !draft) return;
  const next = { ...proposal.scheme, name: draft.name };
  proposal = undefined;
  edit(next);
  syncSliders();
}

// --- preview -----------------------------------------------------------------------

/** Text, foreground ('fg' or ANSI index), background index, bold. */
type Segment = [string, (number | 'fg')?, number?, boolean?];
const PREVIEW: Segment[][] = [
  [
    ['$ ', 8],
    ['ls --color', 'fg'],
  ],
  [
    ['README.md', 'fg'],
    ['  '],
    ['src/', 12, undefined, true],
    ['  '],
    ['build.sh', 10, undefined, true],
    ['  '],
    ['link', 14, undefined, true],
    ['  '],
    ['archive.tgz', 9, undefined, true],
  ],
  [
    ['$ ', 8],
    ['git diff', 'fg'],
  ],
  [['@@ -12,7 +12,8 @@ fn main() {', 6]],
  [['-    let total = old_sum(items);', 1]],
  [['+    let total = items.iter().sum();', 2]],
  [
    ['● ', 2],
    ['Update', 'fg', undefined, true],
    ['(src/store.ts)', 'fg'],
  ],
  [
    ['  ⎿  ', 8],
    ['Updated src/store.ts with 3 additions and 2 removals', 8],
  ],
  [
    ['warning', 3, undefined, true],
    [': unused variable `count`', 'fg', undefined, true],
  ],
  [
    ['error[E0425]', 1, undefined, true],
    [': cannot find value `z` in this scope', 'fg', undefined, true],
  ],
  [
    ['  --> ', 4],
    ['src/main.rs:14:9', 4],
    ['  ', 'fg'],
    ['magenta', 5],
    [' cyan', 6],
    [' white', 7],
  ],
];

function renderPreview(): void {
  const scheme = proposal?.scheme ?? draft;
  if (!scheme) return;
  const color = (value: number | 'fg' | undefined) => (value === 'fg' || value === undefined ? scheme.foreground : scheme.palette[value]);
  const line = (segments: Segment[]) =>
    h(
      'div',
      {},
      ...segments.map(([text, fg, bg, bold]) =>
        h(
          'span',
          {
            style: `color:${color(fg)};${bg !== undefined ? `background:${scheme.palette[bg]};` : ''}${bold ? 'font-weight:bold;' : ''}`,
          },
          text,
        ),
      ),
    );
  const swatchRow = (offset: number, asBackground: boolean) =>
    h(
      'div',
      {},
      ...Array.from({ length: 8 }, (_, i) =>
        h(
          'span',
          {
            style: asBackground ? `background:${scheme.palette[offset + i]};color:${scheme.foreground}` : `color:${scheme.palette[offset + i]}`,
          },
          ` ${String(offset + i).padStart(2)} `,
        ),
      ),
    );
  const cursor = h(
    'span',
    {
      style: `background:${scheme.cursor ?? scheme.foreground};color:${scheme.cursorText ?? scheme.background}`,
    },
    ' ',
  );
  const selection = h(
    'span',
    {
      style: `background:${scheme.selection ?? scheme.palette[8]};color:${scheme.foreground}`,
    },
    'selected text',
  );
  fill(
    parts.preview,
    h('h2', {}, proposal ? 'Preview (proposed)' : 'Preview'),
    h(
      'pre',
      {
        class: 'preview',
        style: `background:${scheme.background};color:${scheme.foreground}`,
      },
      ...PREVIEW.map(line),
      h('div', {}, ' '),
      swatchRow(0, false),
      swatchRow(8, false),
      swatchRow(0, true),
      swatchRow(8, true),
      h('div', {}, ' '),
      h('div', {}, h('span', { style: `color:${scheme.palette[8]}` }, '$ '), selection, ' then the cursor ', cursor),
    ),
  );
}

// --- actions -----------------------------------------------------------------------

function save(): void {
  if (!draft) return;
  post({ type: 'save', scheme: draft, previousName: selected });
}

function duplicate(): void {
  if (!draft) return;
  const taken = new Set(schemes.map((scheme) => scheme.name));
  let name = `${draft.name} copy`;
  for (let n = 2; taken.has(name); n++) name = `${draft.name} copy ${n}`;
  post({ type: 'save', scheme: { ...draft, name, source: undefined } });
}

function fromVsCode(): void {
  const theme = readTheme();
  const hex = (value: number | null | undefined, fallback: string) =>
    typeof value === 'number' ? `#${value.toString(16).padStart(6, '0')}` : fallback;
  const background = hex(theme.background, '#1e1e1e');
  const foreground = hex(theme.foreground, '#cccccc');
  const taken = new Set(schemes.map((scheme) => scheme.name));
  let name = 'VS Code theme';
  for (let n = 2; taken.has(name); n++) name = `VS Code theme ${n}`;
  post({
    type: 'save',
    scheme: {
      name,
      background,
      foreground,
      cursor: hex(theme.cursor, foreground),
      palette: theme.palette.map((value) => hex(value, foreground)),
      source: 'VS Code theme',
    },
  });
}

let noticeTimer: number | undefined;
function notice(text: string, error = false): void {
  document.querySelector('.notice')?.remove();
  const element = h('div', { class: `notice${error ? ' error' : ''}`, role: 'status' }, text);
  document.body.append(element);
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => element.remove(), 5000);
}

// Files dropped anywhere on the page are imported.
document.addEventListener('dragover', (event) => {
  event.preventDefault();
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', () => document.body.classList.remove('dragging'));
document.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  for (const file of event.dataTransfer?.files ?? []) void file.text().then((text) => post({ type: 'importText', text, fileName: file.name }));
});

window.addEventListener('message', (event: MessageEvent<SettingsToWebview>) => {
  const message = event.data;
  switch (message?.type) {
    case 'state': {
      schemes = message.schemes;
      active = message.active;
      konsole = message.konsole;
      if (!stored()) selected = schemes[0]?.name;
      // Keep unsaved edits; otherwise show what is stored now.
      if (!dirty || !draft) {
        draft = stored() && structuredClone(stored()!);
        dirty = false;
      }
      render();
      break;
    }
    case 'select':
      select(message.name);
      break;
    case 'notice':
      notice(message.text, message.error);
      break;
  }
});

// For tests and debugging.
Object.assign(window, {
  __herdrSettings: {
    state: () => ({ schemes, active, selected, dirty, draft, proposal }),
    importText: (text: string, fileName: string) => post({ type: 'importText', text, fileName }),
  },
});

render();
post({ type: 'ready' });
