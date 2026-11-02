// Arclight intro: DOM renderer. Builds the 1920x1080 stage once and paints any frame with
// `render(T)`. Plain DOM + inline SVG, no framework, no font (the wordmark letters are Michroma
// outlines from glyphs.ts). The element structure and styles mirror the design file so the
// browser composites it the same way.
import { ASCENDER, DESCENDER, GLYPHS, UNITS_PER_EM } from './glyphs.js';
import {
  CHEV_LEN,
  PALETTE,
  STAGE_H,
  STAGE_W,
  STRIPES,
  WORD,
  WORD_FONT_SIZE,
  WORD_LEFT,
  WORD_LINE_HEIGHT,
  introFrame,
  mixColor,
  type IntroFrame,
} from './timeline.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const [BLUE, CYAN] = PALETTE;

export interface IntroStage {
  /** The 1920x1080 stage element. Scale it with a CSS transform to fit the screen. */
  readonly el: HTMLDivElement;
  /** Paint the frame at time T (seconds). Returns the computed frame values. */
  render(T: number): IntroFrame;
}

export interface IntroStageOptions {
  /** Clip to the stage rectangle (default true). Turn off to let the ribbons run into a letterbox. */
  clip?: boolean;
}

let instance = 0;

/** Line box of one wordmark letter: height and baseline, the way Blink lays out the text. */
export function letterBox(fontSize = WORD_FONT_SIZE, lineHeight = WORD_LINE_HEIGHT): { height: number; baseline: number } {
  const height = fontSize * lineHeight;
  // Blink rounds the font's ascent and descent to whole pixels before splitting the leading.
  const ascent = Math.round((ASCENDER / UNITS_PER_EM) * fontSize);
  const descent = Math.round((DESCENDER / UNITS_PER_EM) * fontSize);
  // On the 1080p stage the text baseline lands on y = 577.5 and Blink snaps text to the pixel row
  // above; the -0.5 matches that (measured against the font-rendered design, Chrome).
  return { height, baseline: (height - (ascent + descent)) / 2 + ascent - 0.5 };
}

export function createIntroStage(doc: Document = document, opts: IntroStageOptions = {}): IntroStage {
  const id = `arcG${++instance}`;
  const div = (style: Partial<CSSStyleDeclaration>, parent: HTMLElement) => {
    const e = doc.createElement('div');
    Object.assign(e.style, style);
    parent.appendChild(e);
    return e;
  };
  const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element) => {
    const e = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    parent.appendChild(e);
    return e;
  };

  const root = doc.createElement('div');
  Object.assign(root.style, {
    position: 'relative',
    width: `${STAGE_W}px`,
    height: `${STAGE_H}px`,
    background: '#000',
    overflow: opts.clip === false ? 'visible' : 'hidden',
  } satisfies Partial<CSSStyleDeclaration>);
  root.setAttribute('aria-hidden', 'true');

  const glow = div({ position: 'absolute', inset: '0', background: `radial-gradient(900px 500px at 50% 50%, ${BLUE}14, transparent 70%)` }, root);

  const ignite = div(
    {
      position: 'absolute',
      top: '539px',
      height: '2px',
      background: `linear-gradient(90deg, transparent, ${CYAN}, #fff, ${CYAN}, transparent)`,
      boxShadow: `0 0 18px 2px ${CYAN}, 0 0 60px 6px ${BLUE}88`,
    },
    root,
  );

  const flash = div({ position: 'absolute', borderRadius: '50%', background: `radial-gradient(circle, ${CYAN}66 0%, ${BLUE}22 40%, transparent 70%)` }, root);

  const ribbons = STRIPES.map((s) => {
    const color = PALETTE[s.c] ?? BLUE;
    return div({ position: 'absolute', width: `${s.w}px`, background: `linear-gradient(180deg, transparent, ${color}, transparent)`, boxShadow: `0 0 24px ${color}88` }, root);
  });

  // Mark: 360px box, chevrons in a 100x100 viewBox.
  const markBox = div({ position: 'absolute', top: `${540 - 180}px`, width: '360px', height: '360px', transformOrigin: '42% 50%' }, root);
  const markSvg = svgEl('svg', { width: 360, height: 360, viewBox: '0 0 100 100' }, markBox);
  Object.assign(markSvg.style, { display: 'block', overflow: 'visible', filter: `drop-shadow(0 0 ${360 * 0.06}px ${CYAN}aa)` });
  const grad = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 1, y2: 0 }, svgEl('defs', {}, markSvg));
  svgEl('stop', { offset: 0, 'stop-color': BLUE }, grad);
  svgEl('stop', { offset: 1, 'stop-color': CYAN }, grad);
  const chevron = { fill: 'none', stroke: `url(#${id})`, 'stroke-width': 13, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const back = svgEl('path', { d: 'M48,22 L76,50 L48,78', ...chevron }, markSvg);
  const front = svgEl('path', { d: 'M24,22 L52,50 L24,78', ...chevron, 'stroke-dasharray': CHEV_LEN }, markSvg);

  // Wordmark: letters in a flex row, sliced through the middle by a mask, with a glowing line.
  const { height: lineH, baseline } = letterBox();
  const k = WORD_FONT_SIZE / UNITS_PER_EM;
  const slice = 'linear-gradient(180deg,#000 47%,transparent 47%,transparent 53%,#000 53%)';
  const word = div({ position: 'absolute', left: `${WORD_LEFT}px`, top: '540px', transform: 'translateY(-50%)' }, root);
  const row = div({ display: 'flex', height: `${lineH}px`, webkitMaskImage: slice, maskImage: slice } as Partial<CSSStyleDeclaration>, word);
  const letters = [...WORD].map((ch, i) => {
    const g = GLYPHS[ch];
    if (!g) throw new Error(`no glyph for ${ch}`);
    const span = doc.createElement('span');
    Object.assign(span.style, { display: 'inline-block', flex: 'none', height: `${lineH}px` } satisfies Partial<CSSStyleDeclaration>);
    const svg = svgEl('svg', { width: g.advance * k, height: lineH, viewBox: `0 0 ${g.advance * k} ${lineH}` }, span);
    Object.assign(svg.style, { display: 'block', overflow: 'visible' });
    svgEl('path', { d: g.d, fill: mixColor(i / 7), transform: `translate(0 ${baseline}) scale(${k})` }, svg);
    row.appendChild(span);
    return { span, advance: g.advance * k };
  });
  const line = div(
    {
      position: 'absolute',
      left: '0',
      right: '0',
      top: '50%',
      height: '2px',
      marginTop: '-1px',
      background: `linear-gradient(90deg, transparent, ${CYAN}, transparent)`,
      boxShadow: `0 0 14px ${CYAN}`,
    },
    word,
  );

  const px = (n: number) => `${n}px`;

  function render(T: number): IntroFrame {
    const f = introFrame(T);
    glow.style.opacity = String(f.markO);

    ignite.style.left = px(960 - f.ignite.w / 2);
    ignite.style.width = px(f.ignite.w);
    ignite.style.opacity = String(f.ignite.opacity);

    flash.style.left = px(960 - f.flash.r);
    flash.style.top = px(540 - f.flash.r);
    flash.style.width = flash.style.height = px(f.flash.r * 2);
    flash.style.opacity = String(f.flash.opacity);

    f.ribbons.forEach((r, i) => {
      const el = ribbons[i];
      const s = STRIPES[i];
      if (!el || !s) return;
      el.style.left = px(r.x - s.w / 2);
      el.style.top = px(540 - r.h / 2);
      el.style.height = px(r.h);
      el.style.opacity = String(r.opacity);
    });

    const m = f.mark;
    markBox.style.left = px(960 - 180 + m.shiftX);
    markBox.style.opacity = String(f.markO);
    markBox.style.transform = `scale(${m.scale})`;
    markSvg.style.transform = `scale(${m.pop})`;
    back.setAttribute('opacity', String(m.backOpacity));
    back.setAttribute('transform', `translate(${m.backX} 0)`);
    front.setAttribute('stroke-dashoffset', String(m.frontDashOffset));
    front.setAttribute('opacity', String(m.frontOpacity));

    word.style.opacity = String(f.word.opacity);
    const spacing = f.word.tracking * WORD_FONT_SIZE; // CSS letter-spacing: added after every letter
    letters.forEach(({ span, advance }, i) => {
      const l = f.word.letters[i];
      if (!l) return;
      span.style.width = px(advance + spacing);
      span.style.opacity = String(l.opacity);
      span.style.transform = `translateY(${l.y}px)`;
    });
    line.style.transform = `scaleX(${f.word.line})`;
    return f;
  }

  render(0);
  return { el: root, render };
}
