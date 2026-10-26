import { describe, expect, it } from 'vitest';
import { Registry, formatValue } from './registry.js';

describe('metrics registry', () => {
  it('renders counters with HELP/TYPE, sorted and escaped labels', async () => {
    const r = new Registry();
    const c = r.counter('test_requests_total', 'Requests\nby "route".');
    c.inc({ route: '/a', method: 'GET' });
    c.inc({ method: 'GET', route: '/a' }, 2);
    c.inc({ route: 'quote"back\\slash\nnl' });
    const text = await r.render();
    expect(text).toContain('# HELP test_requests_total Requests\\nby "route".');
    expect(text).toContain('# TYPE test_requests_total counter');
    expect(text).toContain('test_requests_total{method="GET",route="/a"} 3');
    expect(text).toContain('test_requests_total{route="quote\\"back\\\\slash\\nnl"} 1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('gauges set, move both ways and reset', async () => {
    const r = new Registry();
    const g = r.gauge('test_gauge', 'A gauge.');
    g.set(5);
    g.inc({}, 2);
    g.dec({}, 10);
    expect(g.get()).toBe(-3);
    g.set({ state: 'x' }, 1);
    expect(await r.render()).toContain('test_gauge{state="x"} 1');
    g.reset();
    expect(await r.render()).not.toContain('test_gauge{');
  });

  it('histograms render cumulative buckets, +Inf, sum and count', async () => {
    const r = new Registry();
    const h = r.histogram('test_seconds', 'Durations.', [0.1, 1]);
    h.observe({ job: 'a' }, 0.05);
    h.observe({ job: 'a' }, 0.5);
    h.observe({ job: 'a' }, 5);
    const text = await r.render();
    expect(text).toContain('test_seconds_bucket{job="a",le="0.1"} 1');
    expect(text).toContain('test_seconds_bucket{job="a",le="1"} 2');
    expect(text).toContain('test_seconds_bucket{job="a",le="+Inf"} 3');
    expect(text).toContain('test_seconds_sum{job="a"} 5.55');
    expect(text).toContain('test_seconds_count{job="a"} 3');
    expect(h.count({ job: 'a' })).toBe(3);
  });

  it('rejects invalid names, duplicate metrics and decreasing counters', () => {
    const r = new Registry();
    expect(() => r.counter('bad-name', 'x')).toThrow();
    r.counter('ok_total', 'x');
    expect(() => r.counter('ok_total', 'x')).toThrow(/already registered/);
    const c = r.get('ok_total') as ReturnType<Registry['counter']>;
    expect(() => c.inc({}, -1)).toThrow(/cannot decrease/);
    expect(() => c.inc({ 'bad-label': 1 })).toThrow(/invalid label/);
  });

  it('a throwing collector is counted and does not break the scrape', async () => {
    const r = new Registry();
    const g = r.gauge('test_value', 'x');
    r.addCollector('broken', () => {
      throw new Error('boom');
    });
    r.addCollector('fine', () => g.set(7));
    const errors: string[] = [];
    const text = await r.render((name) => errors.push(name));
    expect(errors).toEqual(['broken']);
    expect(text).toContain('test_value 7');
    expect(text).toContain('arclight_metrics_collector_errors_total{collector="broken"} 1');
  });

  it('formats special values', () => {
    expect(formatValue(Infinity)).toBe('+Inf');
    expect(formatValue(-Infinity)).toBe('-Inf');
    expect(formatValue(NaN)).toBe('NaN');
    expect(formatValue(1.5)).toBe('1.5');
  });
});
