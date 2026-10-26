import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The v1.1 ambient-light rules are CSS: check the guarantees the handoff spells out.
const css = (name: string) => readFileSync(join(process.cwd(), 'src/styles/arclight', name), 'utf8');
const kit = css('arclight.css');
const layout = css('layout.css');

/** The rule bodies (selector → declarations) of a stylesheet, comments stripped, media blocks flattened. */
function rules(text: string): Array<{ selector: string; body: string }> {
  const out: Array<{ selector: string; body: string }> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(re)) out.push({ selector: m[1]!.trim(), body: m[2]!.trim() });
  return out;
}

describe('ambient motion CSS (v1.1)', () => {
  it('the trail flow runs only on the active trail', () => {
    const flow = rules(kit).filter((r) => r.body.includes('al-trail-flow'));
    expect(flow.map((r) => r.selector)).toEqual(['.al-trail[data-state="active"]::after']);
  });

  it('ships the runners, edge glint and trace pulse with the kit timings', () => {
    expect(kit).toContain('--t-flow: 1.8s; --t-runner-v: 9s; --t-runner-h: 12s;');
    expect(kit).toMatch(/\.al-edge \{ animation: al-edge-glint 7s/);
    expect(kit).toMatch(/\.al-trace-pulse \{[^}]*offset-path: var\(--path\)/);
    for (const k of ['al-rail-run', 'al-bar-run', 'al-trail-flow', 'al-edge-glint', 'al-trace-run']) expect(kit).toContain(`@keyframes ${k}`);
  });

  it('ambient keyframes and classes never use the warn/danger colours', () => {
    const start = kit.indexOf('ambient light (v1.1)');
    const ambient = kit.slice(start, kit.indexOf('@media (prefers-reduced-motion'));
    expect(start).toBeGreaterThan(0);
    expect(ambient).not.toMatch(/--al-warn|--al-danger|255,\s*154,\s*77|255,\s*90,\s*70|#ff9a4d|#ff5a46/i);
  });

  it('decorative motion never takes pointer events', () => {
    for (const sel of ['.al-backdrop__motion', '.al-runner', '.al-trace-pulse']) {
      const r = rules(kit).find((x) => x.selector === sel);
      expect(r?.body, sel).toContain('pointer-events: none');
    }
    for (const sel of ['.al-rail__runner', '.al-topbar__runner']) {
      expect(rules(layout).find((x) => x.selector === sel)?.body, sel).toContain('pointer-events: none');
    }
  });

  it('prefers-reduced-motion and data-motion="off" both stop every animation', () => {
    expect(kit).toContain('@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }');
    const off = rules(layout).find((r) => r.selector.startsWith('[data-motion="off"] *'));
    expect(off?.selector).toBe('[data-motion="off"] *, [data-motion="off"] *::before, [data-motion="off"] *::after');
    expect(off?.body).toContain('animation: none !important');
  });
});
