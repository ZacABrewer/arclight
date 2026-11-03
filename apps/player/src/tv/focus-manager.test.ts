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

  it('enters a group for the first time on its current-page entry', () => {
    document.getElementById('r-movies')!.setAttribute('aria-current', 'page');
    document.getElementById('d1')!.focus();
    key('ArrowLeft'); // nearest would be Search (same height); the current page wins
    expect(active()).toBe('r-movies');
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

  it('right at the end of a row stays put; down stays in the page before the rail', () => {
    render(`<nav data-tv-group="rail"><a id="r1" href="#/1" data-box="0,140,60,50">R</a></nav>
      <main data-tv-group="main"><a id="back" href="#/b" data-box="100,0,80,30">Back</a>
      <a id="t1" href="#/t" data-box="100,40,60,30">T</a><a id="t2" href="#/u" data-box="300,40,60,30">U</a>
      <a id="card" href="#/c" data-box="100,100,100,150">C</a><a id="next-row" href="#/n" data-box="260,300,100,150">N</a></main>`);
    document.getElementById('card')!.focus();
    key('ArrowRight'); // nothing in its row: not up to t2, not down to next-row
    expect(active()).toBe('card');
    document.getElementById('back')!.focus();
    key('ArrowDown'); // t1 below, even though the rail is nearer than the card
    expect(active()).toBe('t1');
  });

  it('down from the stage header enters the page at its first item, not the nearest', () => {
    render(`<div data-tv-stage="" data-tv-scale="1" data-box="0,0,1280,720">
      <header data-tv-row="" data-tv-fixed=""><a id="h-home" href="#/h" data-box="300,20,80,32">Home</a>
      <a id="h-shows" href="#/s" data-box="500,20,80,32">TV Shows</a></header>
      <main data-tv-group="main"><a id="under" href="#/u" data-box="500,40,80,20">Under the header</a>
      <div data-tv-row=""><button id="chip-all" data-box="64,100,60,30">All</button>
      <button id="chip-drama" data-box="500,100,80,30">Drama</button></div>
      <a id="tile" href="#/t" data-box="500,200,200,120">Tile</a></main></div>`);
    document.getElementById('h-shows')!.focus();
    key('ArrowDown'); // not "Drama" right below the tab, and not what is still under the header
    expect(active()).toBe('chip-all');
    key('ArrowRight');
    key('ArrowDown'); // inside the page, down stays the nearest
    expect(active()).toBe('tile');
  });

  it('up into the stage header lands on the active tab, from any row (features spec 5.2, D12)', () => {
    const stage = (current: boolean) => `<div data-tv-stage="" data-tv-scale="1" data-box="0,0,1280,720">
      <header data-tv-row="" data-tv-fixed=""><a id="tab-home" href="#/h" data-box="300,20,80,32">Home</a>
      <a id="tab-movies" href="#/m" data-box="420,20,80,32" ${current ? 'aria-current="page"' : ''}>Movies</a></header>
      <main data-tv-group="main"><div data-tv-row=""><button id="chip-all" data-box="64,100,60,30">All</button>
      <button id="chip-under-home" data-box="300,100,80,30">Drama</button></div>
      <a id="tile" href="#/t" data-box="300,200,200,120">Tile</a></main></div>`;
    render(stage(true));
    document.getElementById('chip-under-home')!.focus();
    key('ArrowUp'); // "Home" is right above, but Movies is the page we are on
    expect(active()).toBe('tab-movies');
    key('ArrowLeft'); // inside the header, moves stay the nearest
    expect(active()).toBe('tab-home');
    // Without an active tab in the header (a detail page), the nearest one as before.
    render(stage(false));
    document.getElementById('chip-under-home')!.focus();
    key('ArrowUp');
    expect(active()).toBe('tab-home');
  });

  it('up / down at the ends of the rail stays in the rail', () => {
    render(`<nav data-tv-group="rail"><a id="r1" href="#/1" data-box="0,100,60,50">R1</a><a id="r2" href="#/2" data-box="0,160,60,50">R2</a></nav>
      <main data-tv-group="main"><a id="top" href="#/t" data-box="100,0,100,60">T</a><a id="low" href="#/l" data-box="100,300,100,60">L</a></main>`);
    document.getElementById('r2')!.focus();
    key('ArrowDown'); // the page has an item lower down, but the rail's end is an end
    expect(active()).toBe('r2');
    document.getElementById('r1')!.focus();
    key('ArrowUp');
    expect(active()).toBe('r1');
    document.getElementById('low')!.focus();
    key('ArrowUp'); // and the page's up goes to the page, not into the rail beside it
    expect(active()).toBe('top');
  });

  it('does not start on a text box unless it is marked to', () => {
    render(`<main data-tv-group="main"><input id="q" data-box="0,0,200,40" /><a id="first" href="#/f" data-box="0,60,60,40">F</a></main>`);
    key('ArrowDown', window);
    expect(active()).toBe('first');
  });

  it('does not start on an element marked data-tv-not-first', () => {
    render(`<main data-tv-group="main"><button id="out" data-tv-not-first data-box="0,0,60,40">Out</button><a id="next" href="#/n" data-box="0,60,60,40">N</a></main>`);
    key('ArrowDown', window);
    expect(active()).toBe('next');
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

  it('forget drops what it remembered (a new profile starts fresh)', async () => {
    vi.useFakeTimers();
    try {
      document.getElementById('d2')!.focus();
      page = '/player/movies';
      render(`<main data-tv-group="main"><a id="m1" href="#/m1" data-box="0,0,10,10">M1</a></main>`);
      fm.restore();
      await vi.advanceTimersByTimeAsync(10);
      fm.forget();
      page = '/player';
      render(LAYOUT);
      fm.restore();
      await vi.advanceTimersByTimeAsync(10);
      expect(active()).not.toBe('d2');
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
