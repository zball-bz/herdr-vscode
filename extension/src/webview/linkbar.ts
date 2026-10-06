// The link toolbar: herdr-web reports the link under the pointer (`linkHover`),
// and after a short rest this offers where to open it, styled as a VS Code
// hover. It is plain DOM above the canvas, which receives none of its pointer
// events, so a click on it never reaches the terminal.
import type { LinkOpen, LinkTarget, ViewEvent } from '../protocol';

type Hover = Extract<ViewEvent, { type: 'linkHover' }>;
export type LinkAction = LinkOpen | 'copy';

interface Placed extends LinkTarget {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SHOW_DELAY_MS = 500;
/** Time to move from the link onto the toolbar before it goes. */
const HIDE_DELAY_MS = 300;
const IS_MAC = navigator.platform.toLowerCase().startsWith('mac');

const ACTIONS: Record<LinkTarget['kind'], [LinkAction, string, string][]> = {
  web: [
    ['vscode', 'Open in VS Code', "Open in VS Code's integrated browser, beside this terminal"],
    ['external', 'Open in Browser', 'Open in the system browser'],
    ['copy', 'Copy', 'Copy the address'],
  ],
  path: [
    ['follow', 'Open', 'Open in the main editor group (top left), or beside this terminal when it is that group'],
    ['side', 'Open to the Side', 'Open beside this terminal'],
    ['copy', 'Copy', 'Copy the path as printed'],
  ],
};

const same = (a: LinkTarget | undefined, b: LinkTarget | undefined) =>
  a?.kind === b?.kind && a?.target === b?.target && a?.paneId === b?.paneId;

export class LinkBar {
  private readonly element = document.createElement('div');
  /** The link under the pointer, as herdr-web last reported it. */
  private hovered: Placed | undefined;
  /** The link the toolbar is showing. */
  private shown: Placed | undefined;
  private overBar = false;
  private showTimer: number | undefined;
  private hideTimer: number | undefined;
  enabled = true;

  constructor(private readonly act: (link: LinkTarget, action: LinkAction) => void) {
    this.element.id = 'herdr-linkbar';
    this.element.setAttribute('role', 'toolbar');
    this.element.addEventListener('pointerenter', () => {
      this.overBar = true;
      window.clearTimeout(this.hideTimer);
    });
    this.element.addEventListener('pointerleave', () => {
      this.overBar = false;
      if (!same(this.hovered, this.shown)) this.scheduleHide();
    });
    // Keep keyboard focus in the terminal's input; the click still fires.
    this.element.addEventListener('mousedown', (event) => event.preventDefault());
    document.body.append(this.element);
    window.addEventListener('keydown', () => this.hide(), true);
    window.addEventListener('wheel', () => this.hide(), { capture: true, passive: true });
    window.addEventListener('blur', () => this.hide());
  }

  /** A `linkHover` event from herdr-web. */
  hover(event: Hover): void {
    const link: Placed | undefined =
      event.kind && event.target && [event.x, event.y, event.width, event.height].every((n) => typeof n === 'number')
        ? { kind: event.kind, target: event.target, paneId: event.paneId, cwd: event.cwd, x: event.x!, y: event.y!, width: event.width!, height: event.height! }
        : undefined;
    this.hovered = link;
    window.clearTimeout(this.showTimer);
    if (!link || !this.enabled) {
      if (!this.overBar) this.scheduleHide();
      return;
    }
    window.clearTimeout(this.hideTimer);
    if (same(link, this.shown)) return;
    // Already showing: follow the pointer to the next link at once, as hovers do.
    if (this.shown) this.show(link);
    else this.showTimer = window.setTimeout(() => this.show(link), SHOW_DELAY_MS);
  }

  hide(): void {
    window.clearTimeout(this.showTimer);
    window.clearTimeout(this.hideTimer);
    this.shown = undefined;
    this.overBar = false;
    this.element.classList.remove('shown');
  }

  private scheduleHide(): void {
    window.clearTimeout(this.hideTimer);
    if (this.shown) this.hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY_MS);
  }

  private show(link: Placed): void {
    this.shown = link;
    this.element.replaceChildren(
      ...ACTIONS[link.kind].map(([action, label, title]) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.title = `${title}\n${link.target}`;
        button.dataset.action = action;
        button.addEventListener('click', () => {
          this.hide();
          this.act(link, action);
        });
        return button;
      }),
      Object.assign(document.createElement('span'), {
        className: 'hint',
        textContent: `${IS_MAC ? '⌘' : 'Ctrl'}+Click: ${link.kind === 'web' ? 'follow' : 'open'}`,
      }),
    );
    this.element.classList.add('shown');
    // Above the link, or below it when the top row has no room; inside the view.
    const { offsetWidth: width, offsetHeight: height } = this.element;
    const above = link.y - height - 2;
    const top = above >= 0 ? above : Math.min(link.y + link.height + 2, window.innerHeight - height);
    const left = Math.max(0, Math.min(link.x, window.innerWidth - width));
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }
}
