import { directionOf, pickNext, pickStage, stageScore, type Box, type Direction } from './spatial';
import { ensureVisible, stageScale } from './stage-scroll';

// D-pad focus for the TV layout. The remote's arrows arrive as ArrowUp/Down/Left/Right key
// events and OK as Enter (the Android side maps DPAD_CENTER); this moves real DOM focus between
// whatever is focusable on screen, so the pages need nothing TV-specific beyond being made of
// links, buttons and inputs:
//
//  - an arrow picks the nearest focusable in that direction (spatial.ts);
//  - an open dialog / menu / panel ([aria-modal], [role=dialog], [role=menu], [data-tv-scope])
//    keeps focus inside it;
//  - groups ([data-tv-group="name"], e.g. the rail and the page) remember their last focused
//    element: coming back into a group lands where you left it;
//  - the focused element is scrolled into view (rows sideways, the page up and down);
//  - each page (pathname) remembers its focused element, restored when you come back;
//  - text inputs keep left/right for the caret until it reaches an end; range inputs keep them.
//
// On the redesign's TV stage ([data-tv-stage]) the design's own rules apply instead (spatial.ts
// `stageScore`, stage-scroll.ts): rows ([data-tv-row]) bound left / right, the fixed header
// ([data-tv-fixed]) is reached up from the top of a page, and the stage scrollers move. Moving
// into a [data-tv-enter] block from outside lands on its first item ("first") or on its
// aria-current one ("current", else the first), not on whichever is level with the origin.

export const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
  '[data-tv-focus]',
].join(',');

const SCOPES = '[aria-modal="true"], [role="dialog"], [role="menu"], [data-tv-scope]';
const GROUP_ATTR = 'data-tv-group';

export interface FocusManagerOptions {
  root?: HTMLElement;
  /** Box of an element (tests stub this; jsdom has no layout). */
  rectOf?: (el: Element) => Box;
  /** Whether an element is shown (tests stub this too). */
  visible?: (el: HTMLElement) => boolean;
  /** Key of the current page, for focus memory (the router's pathname). */
  pageKey?: () => string;
  /** Moves focus into view; default scrollIntoView. */
  reveal?: (el: HTMLElement) => void;
  /** Turn the manager off for some screens (e.g. one that handles its own keys). */
  enabled?: () => boolean;
  /** Called after an arrow moved focus. */
  onMove?: (el: HTMLElement, dir: Direction) => void;
  /** Moves focus into view on the stage; default stage-scroll's ensureVisible. */
  revealStage?: (el: HTMLElement, instant: boolean) => void;
}

const isTextInput = (el: Element): el is HTMLInputElement | HTMLTextAreaElement => {
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return ['text', 'search', 'url', 'email', 'password', 'tel', 'number', ''].includes(el.type);
};

/** Activates natively on Enter (no synthetic click needed). */
const NATIVE_ENTER = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY']);

function defaultVisible(el: HTMLElement): boolean {
  if (el.closest('[inert], [aria-hidden="true"]')) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 && r.height <= 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** A stable-ish identity for an element across renders of the same page. */
export function focusKey(el: Element): string {
  const explicit = el.getAttribute('data-tv-key');
  if (explicit) return `k:${explicit}`;
  const href = el.getAttribute('href') ?? '';
  const label = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 60);
  return `${el.tagName}|${href}|${label}`;
}

export class FocusManager {
  private readonly root: HTMLElement;
  private readonly rectOf: (el: Element) => Box;
  private readonly visible: (el: HTMLElement) => boolean;
  private readonly opts: FocusManagerOptions;
  private readonly groupMemory = new Map<string, HTMLElement>();
  private readonly pageMemory = new Map<string, string>();
  private restoreTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: FocusManagerOptions = {}) {
    this.opts = opts;
    this.root = opts.root ?? document.body;
    this.rectOf = opts.rectOf ?? ((el) => el.getBoundingClientRect());
    this.visible = opts.visible ?? defaultVisible;
  }

  attach(): () => void {
    const onKey = (e: KeyboardEvent) => this.onKeyDown(e);
    const onFocus = (e: FocusEvent) => this.remember(e.target);
    window.addEventListener('keydown', onKey);
    this.root.addEventListener('focusin', onFocus);
    return () => {
      window.removeEventListener('keydown', onKey);
      this.root.removeEventListener('focusin', onFocus);
      if (this.restoreTimer) clearTimeout(this.restoreTimer);
    };
  }

  /** Forget where focus was on every page (a profile switch starts each page fresh). */
  forget(): void {
    this.pageMemory.clear();
    this.groupMemory.clear();
  }

  /** The element focus is confined to: the topmost open scope, else the root. */
  scope(): HTMLElement {
    const open = [...this.root.querySelectorAll<HTMLElement>(SCOPES)].filter((s) => this.visible(s) || s.matches('[data-tv-scope]'));
    return open[open.length - 1] ?? this.root;
  }

  /** Focusable, shown elements inside `within` (default: the current scope). */
  focusables(within: HTMLElement = this.scope()): HTMLElement[] {
    return [...within.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => this.visible(el));
  }

  private current(): HTMLElement | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && a !== document.body && this.root.contains(a) ? a : null;
  }

  private groupOf(el: Element): HTMLElement | null {
    return el.closest<HTMLElement>(`[${GROUP_ATTR}]`);
  }

  private remember(target: EventTarget | null): void {
    if (!(target instanceof HTMLElement)) return;
    const group = this.groupOf(target);
    if (group) this.groupMemory.set(group.getAttribute(GROUP_ATTR) ?? '', target);
    const page = this.opts.pageKey?.();
    if (page !== undefined && !target.closest('[data-tv-group="rail"], [data-tv-fixed]')) this.pageMemory.set(page, focusKey(target));
  }

  /** `instant`: no scroll animation (a new screen, focus restored after Back). */
  focus(el: HTMLElement, dir?: Direction, instant = false): void {
    el.focus({ preventScroll: true });
    if (el.closest('[data-tv-stage]')) (this.opts.revealStage ?? ensureVisible)(el, instant);
    else (this.opts.reveal ?? reveal)(el);
    if (dir) this.opts.onMove?.(el, dir);
  }

  /** The design's move on the stage: nearest by its scoring, rows bound left / right. */
  private moveOnStage(from: HTMLElement, stage: HTMLElement, scope: HTMLElement, dir: Direction): boolean {
    const within = scope === this.root ? stage : scope;
    const els = this.focusables(within).filter((el) => el !== from && !from.contains(el));
    const row = from.closest('[data-tv-row]');
    const origin = { box: this.rectOf(from), inHeader: Boolean(from.closest('[data-tv-fixed]')) };
    const headerBottom = this.rectOf(stage).top + 72 * stageScale(stage);
    const candidates = els.map((el) => ({ box: this.rectOf(el), sameRow: !row || row.contains(el), inHeader: Boolean(el.closest('[data-tv-fixed]')) }));
    // Down from the header enters the page at its first item (the "All" chip, the hero's
    // button), not whichever is nearest the tab: the first in page order that down can reach.
    let i =
      origin.inHeader && dir === 'down'
        ? candidates.findIndex((c) => !c.inHeader && stageScore(origin, c, dir, headerBottom) < Infinity)
        : pickStage(origin, candidates, dir, headerBottom);
    if (i < 0) return false;
    const block = els[i]!.closest<HTMLElement>('[data-tv-enter]');
    if (block && !block.contains(from)) {
      const inside = els.filter((el) => block.contains(el));
      const current = block.getAttribute('data-tv-enter') === 'current' ? inside.find((el) => el.getAttribute('aria-current') === 'true') : undefined;
      const k = els.indexOf(current ?? inside[0]!);
      if (k >= 0) i = k;
    }
    // Up from the page into the header lands on the active tab (aria-current), not on whichever
    // tab is nearest; with none shown (a title page), the nearest as before.
    if (dir === 'up' && !origin.inHeader && candidates[i]!.inHeader) {
      const current = els.findIndex((el, k) => candidates[k]!.inHeader && el.getAttribute('aria-current') === 'page');
      if (current >= 0) i = current;
    }
    this.focus(els[i]!, dir);
    return true;
  }

  /** Move focus one step. Returns whether it moved. */
  move(dir: Direction): boolean {
    const from = this.current();
    const scope = this.scope();
    if (!from || !scope.contains(from)) return this.focusFirst(scope);
    const stage = from.closest<HTMLElement>('[data-tv-stage]');
    if (stage) return this.moveOnStage(from, stage, scope, dir);
    const candidates = this.focusables(scope).filter((el) => el !== from && !from.contains(el));
    const origin = this.rectOf(from);
    const fromGroup = this.groupOf(from);
    // Stay in the group when it has something that way (down from the page never jumps into the
    // rail); left / right inside a group only along the row, so the end of a row is an end.
    const horizontal = dir === 'left' || dir === 'right';
    const inLane = (b: Box) => b.bottom > origin.top && b.top < origin.bottom;
    const own = candidates.filter((el) => this.groupOf(el) === fromGroup && (!horizontal || inLane(this.rectOf(el))));
    // The rail is a column: up / down never leaves it or enters it (its last item is an end).
    const isRail = (g: Element | null) => g?.getAttribute(GROUP_ATTR) === 'rail';
    const other = candidates.filter((el) => {
      const g = this.groupOf(el);
      return g !== fromGroup && (horizontal || (!isRail(g) && !isRail(fromGroup)));
    });
    let target: HTMLElement | undefined;
    for (const tier of [own, other]) {
      const i = pickNext(origin, tier.map((el) => this.rectOf(el)), dir);
      if (i >= 0) {
        target = tier[i]!;
        break;
      }
    }
    if (!target) return false;
    // Entering another group: land on what was focused there last, if it is still around.
    const toGroup = this.groupOf(target);
    if (toGroup && toGroup !== fromGroup) {
      const last = this.groupMemory.get(toGroup.getAttribute(GROUP_ATTR) ?? '');
      if (last && last.isConnected && toGroup.contains(last) && scope.contains(last) && this.visible(last)) target = last;
      else {
        // First time in (e.g. the rail): the current page's entry, not whichever is nearest.
        const current = toGroup.querySelector<HTMLElement>('[aria-current="page"]');
        if (current && candidates.includes(current)) target = current;
      }
    }
    this.focus(target, dir);
    return true;
  }

  /** Focus the first element of a group (or the scope), preferring the page's remembered one. */
  focusFirst(within: HTMLElement = this.scope()): boolean {
    const list = this.focusables(within);
    const page = this.opts.pageKey?.();
    const wanted = page !== undefined ? this.pageMemory.get(page) : undefined;
    const main = within.querySelector<HTMLElement>('[data-tv-group="main"]');
    const pool = main ? list.filter((el) => main.contains(el)) : list;
    // A text box is not a good first stop (the on-screen keyboard is one OK away), unless asked for;
    // neither is anything marked data-tv-not-first (such as Sign out).
    const el =
      (wanted ? pool.find((x) => focusKey(x) === wanted) : undefined) ??
      pool.find((x) => x.hasAttribute('data-tv-autofocus')) ??
      pool.find((x) => !isTextInput(x) && !x.hasAttribute('data-tv-not-first')) ??
      pool.find((x) => !isTextInput(x)) ??
      pool[0] ??
      list[0];
    if (!el) return false;
    this.focus(el, undefined, true);
    return true;
  }

  /** Focus a group's remembered element (or its first). */
  focusGroup(name: string): boolean {
    const group = this.root.querySelector<HTMLElement>(`[${GROUP_ATTR}="${name}"]`);
    if (!group) return false;
    const last = this.groupMemory.get(name);
    if (last && last.isConnected && group.contains(last) && this.visible(last)) {
      this.focus(last);
      return true;
    }
    const first = this.focusables(group)[0];
    if (!first) return false;
    this.focus(first);
    return true;
  }

  /** Is focus inside the named group? */
  inGroup(name: string): boolean {
    const c = this.current();
    return Boolean(c && this.groupOf(c)?.getAttribute(GROUP_ATTR) === name);
  }

  /** Is a dialog / menu / panel open? */
  hasOpenScope(): boolean {
    return this.scope() !== this.root;
  }

  /**
   * After a page change: wait for the page to render (lazy chunks, queries), then focus its
   * remembered element or its first one. Gives up after `timeoutMs`.
   */
  restore(timeoutMs = 2500): void {
    if (this.restoreTimer) clearTimeout(this.restoreTimer);
    const started = Date.now();
    const page = this.opts.pageKey?.();
    const attempt = () => {
      this.restoreTimer = null;
      const c = this.current();
      const wanted = page !== undefined ? this.pageMemory.get(page) : undefined;
      const main = this.root.querySelector<HTMLElement>('[data-tv-group="main"]');
      // Something on the page already has focus (and it is the remembered one, or there is none).
      if (c && main?.contains(c) && (!wanted || focusKey(c) === wanted)) return;
      // The stage's header keeps focus across its own tab switches (the design's tab()).
      if (c && c.closest('[data-tv-fixed]')) return;
      const pool = this.focusables(main ?? this.root);
      const match = wanted ? pool.find((x) => focusKey(x) === wanted) : undefined;
      const late = Date.now() - started > timeoutMs;
      if (match) return this.focus(match, undefined, true);
      // Wait a little for the remembered element; then settle for the first one.
      if (pool.length && (!wanted || Date.now() - started > 600)) {
        if (!c || !main?.contains(c)) this.focusFirst();
        return;
      }
      if (!late) this.restoreTimer = setTimeout(attempt, 80);
    };
    this.restoreTimer = setTimeout(attempt, 0);
  }

  onKeyDown(e: KeyboardEvent): void {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (this.opts.enabled && !this.opts.enabled()) return;
    const dir = directionOf(e.key);
    const el = this.current();
    if (dir) {
      if (el && this.keepsArrow(el, dir)) return;
      if (this.move(dir)) e.preventDefault();
      else if (el) e.preventDefault(); // An edge: stay put rather than scroll the page.
      return;
    }
    if ((e.key === 'Enter' || e.key === ' ') && el && !NATIVE_ENTER.has(el.tagName)) {
      // role=button / tabindex elements: OK clicks them.
      e.preventDefault();
      el.click();
    }
  }

  /** Text carets and sliders use some arrows themselves. */
  private keepsArrow(el: HTMLElement, dir: Direction): boolean {
    if (el instanceof HTMLInputElement && el.type === 'range') return dir === 'left' || dir === 'right';
    if (isTextInput(el)) {
      if (dir === 'up' || dir === 'down') return el instanceof HTMLTextAreaElement;
      try {
        const start = el.selectionStart ?? 0;
        const end = el.selectionEnd ?? 0;
        const len = el.value.length;
        if (dir === 'left') return !(start === 0 && end === 0);
        return !(start === len && end === len);
      } catch {
        return false; // number inputs have no selection API
      }
    }
    return false;
  }
}

/** Scroll so the element is in view, keeping a margin; horizontal rows scroll on their own. */
export function reveal(el: HTMLElement): void {
  try {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  } catch {
    el.scrollIntoView?.();
  }
}
