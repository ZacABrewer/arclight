import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusManager, focusKey } from './focus-manager';
import type { Box } from './spatial';

// jsdom has no layout: each element carries its box in data-box="left,top,width,height".
const rectOf = (el: Element): Box => {
  const [l, t, w, h] = (el.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number) as [number, number, number, number];
  return { left: l, top: t, right: l + w, bottom: t + h };
};
const visible = (el: HTMLElement) => !el.closest('[hidden]');

function render(html: string) {
  document.body.innerHTML = html;
}

function key(k: string, target: EventTarget = document.activeElement ?? window): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e;
}

const active = () => {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body ? a.id : undefined;
};

let page = '/player';
let fm: FocusManager;
let detach: () => void;
const reveal = vi.fn();

const LAYOUT = `
  <nav data-tv-group="rail">
    <a id="r-home" href="#/player" data-box="0,0,60,50">Home</a>
    <a id="r-movies" href="#/movies" data-box="0,60,60,50">Movies</a>
    <a id="r-search" href="#/search" data-box="0,120,60,50">Search</a>
  </nav>
  <main data-tv-group="main">
    <a id="c1" href="#/a" data-box="100,0,100,60">A</a>
    <a id="c2" href="#/b" data-box="220,0,100,60">B</a>
    <a id="c3" href="#/c" data-box="340,0,100,60">C</a>
    <a id="d1" href="#/d" data-box="100,100,100,60">D</a>
    <a id="d2" href="#/e" data-box="220,100,100,60">E</a>
    <button id="hidden-btn" hidden data-box="460,0,100,60">Hidden</button>
  </main>`;

beforeEach(() => {
  page = '/player';
  reveal.mockReset();
  render(LAYOUT);
  fm = new FocusManager({ rectOf, visible, reveal, pageKey: () => page });
  detach = fm.attach();
});

afterEach(() => {
  detach();
  document.body.innerHTML = '';
});

describe('FocusManager', () => {
  it('focuses the first item of the page when nothing has focus', () => {
    key('ArrowRight', window);
    expect(active()).toBe('c1');
  });

  it('moves with the arrows and scrolls the target into view', () => {
    document.getElementById('c1')!.focus();
    expect(key('ArrowRight').defaultPrevented).toBe(true);
    expect(active()).toBe('c2');
    key('ArrowDown');
    expect(active()).toBe('d2');
    key('ArrowLeft');
    expect(active()).toBe('d1');
    expect(reveal).toHaveBeenLastCalledWith(document.getElementById('d1'));
  });

  it('skips hidden elements and stays put at an edge without scrolling the page', () => {
    document.getElementById('c3')!.focus();
    const e = key('ArrowRight');
    expect(active()).toBe('c3');
    expect(e.defaultPrevented).toBe(true);
  });

  it('remembers where it was in each group', () => {
    document.getElementById('r-search')!.focus();
    document.getElementById('d2')!.focus();
    key('ArrowLeft'); // d1
    expect(active()).toBe('d1');
    key('ArrowLeft'); // into the rail: lands on Search, where it left
    expect(active()).toBe('r-search');
    key('ArrowRight'); // back into the page: lands on d1
    expect(active()).toBe('d1');
  });

  it('keeps focus inside an open dialog', () => {
    render(`${LAYOUT}<div role="dialog" aria-modal="true" data-box="150,30,200,200">
      <button id="ok" data-box="160,40,80,40">OK</button><button id="cancel" data-box="260,40,80,40">Cancel</button></div>`);
    expect(fm.hasOpenScope()).toBe(true);
    key('ArrowDown', window);
    expect(active()).toBe('ok');
    key('ArrowRight');
    expect(active()).toBe('cancel');
    key('ArrowLeft');
    key('ArrowLeft'); // the dialog's edge: focus does not escape to the page
    expect(active()).toBe('ok');
  });

  it('leaves left / right to a text input until the caret reaches an end', () => {
    render(`<main data-tv-group="main"><input id="q" data-box="100,0,200,40" value="abc" /><a id="go" href="#" data-box="320,0,60,40">Go</a></main>`);
    const input = document.getElementById('q') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(1, 1);
    expect(key('ArrowRight').defaultPrevented).toBe(false);
    expect(active()).toBe('q');
    input.setSelectionRange(3, 3);
    key('ArrowRight');
    expect(active()).toBe('go');
  });

  it('OK clicks a non-native focusable', () => {
    render(`<main data-tv-group="main"><div id="tile" tabindex="0" role="button" data-box="0,0,10,10">Tile</div></main>`);
    const click = vi.fn();
    const tile = document.getElementById('tile')!;
    tile.addEventListener('click', click);
    tile.focus();
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('restores the remembered element when coming back to a page', async () => {
    vi.useFakeTimers();
    try {
      document.getElementById('d2')!.focus();
      page = '/player/movies';
      render(`<main data-tv-group="main"><a id="m1" href="#/m1" data-box="0,0,10,10">M1</a></main>`);
      fm.restore();
      await vi.advanceTimersByTimeAsync(10);
      expect(active()).toBe('m1');
      page = '/player';
      render(LAYOUT);
      fm.restore();
      await vi.advanceTimersByTimeAsync(10);
      expect(active()).toBe('d2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a page that renders late', async () => {
    vi.useFakeTimers();
    try {
      render(`<main data-tv-group="main"></main>`);
      fm.restore();
      await vi.advanceTimersByTimeAsync(200);
      expect(active()).toBeUndefined();
      document.querySelector('main')!.innerHTML = `<a id="other" href="#/o" data-box="0,0,10,10">O</a><a id="late" href="#" data-tv-autofocus data-box="0,20,10,10">Late</a>`;
      await vi.advanceTimersByTimeAsync(100);
      expect(active()).toBe('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('focusGroup moves to the rail', () => {
    document.getElementById('c2')!.focus();
    expect(fm.focusGroup('rail')).toBe(true);
    expect(fm.inGroup('rail')).toBe(true);
  });

  it('keys elements by data-tv-key, else tag + href + label', () => {
    render(`<a id="x" href="#/x" data-tv-key="movie:4">X</a><button id="y" aria-label="Play">P</button>`);
    expect(focusKey(document.getElementById('x')!)).toBe('k:movie:4');
    expect(focusKey(document.getElementById('y')!)).toBe('BUTTON||Play');
  });
});
