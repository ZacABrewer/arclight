// A tiny Prometheus registry: counters, gauges and histograms with labels, rendered in the
// text exposition format 0.0.4. No dependencies; just enough for GET /metrics.

export type Labels = Readonly<Record<string, string | number | boolean>>;
export type MetricType = 'counter' | 'gauge' | 'histogram';

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function escapeHelp(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/** Prometheus number format: integers plain, +Inf/-Inf/NaN spelled out. */
export function formatValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${String(labels[k])}`)
    .join('\u0000');
}

function renderLabels(labels: Labels, extra?: [string, string]): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(String(labels[k]))}"`);
  if (extra) pairs.push(`${extra[0]}="${escapeLabel(extra[1])}"`);
  return pairs.length ? `{${pairs.join(',')}}` : '';
}

abstract class Metric {
  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: MetricType,
  ) {
    if (!NAME.test(name)) throw new Error(`invalid metric name: ${name}`);
  }

  protected checkLabels(labels: Labels): void {
    for (const k of Object.keys(labels)) {
      if (!LABEL.test(k) || k.startsWith('__')) throw new Error(`invalid label name ${k} on ${this.name}`);
    }
  }

  abstract samples(): string[];
  abstract reset(): void;

  render(): string {
    return [`# HELP ${this.name} ${escapeHelp(this.help)}`, `# TYPE ${this.name} ${this.type}`, ...this.samples()].join('\n');
  }
}

class ValueMetric extends Metric {
  protected readonly values = new Map<string, { labels: Labels; value: number }>();

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels))?.value ?? 0;
  }

  protected add(labels: Labels, delta: number): void {
    this.checkLabels(labels);
    const key = labelKey(labels);
    const entry = this.values.get(key);
    if (entry) entry.value += delta;
    else this.values.set(key, { labels: { ...labels }, value: delta });
  }

  reset(): void {
    this.values.clear();
  }

  samples(): string[] {
    return [...this.values.values()].map((e) => `${this.name}${renderLabels(e.labels)} ${formatValue(e.value)}`);
  }
}

export class Counter extends ValueMetric {
  constructor(name: string, help: string) {
    super(name, help, 'counter');
  }

  inc(labels: Labels = {}, by = 1): void {
    if (by < 0) throw new Error(`counter ${this.name} cannot decrease`);
    this.add(labels, by);
  }

  /** For totals tracked elsewhere (process CPU time): publish the current value as is. */
  setTotal(labels: Labels, value: number): void {
    this.checkLabels(labels);
    this.values.set(labelKey(labels), { labels: { ...labels }, value });
  }
}

export class Gauge extends ValueMetric {
  constructor(name: string, help: string) {
    super(name, help, 'gauge');
  }

  set(labels: Labels, value: number): void;
  set(value: number): void;
  set(a: Labels | number, b?: number): void {
    const labels = typeof a === 'number' ? {} : a;
    const value = typeof a === 'number' ? a : (b ?? 0);
    this.checkLabels(labels);
    this.values.set(labelKey(labels), { labels: { ...labels }, value });
  }

  inc(labels: Labels = {}, by = 1): void {
    this.add(labels, by);
  }

  dec(labels: Labels = {}, by = 1): void {
    this.add(labels, -by);
  }
}

export const DEFAULT_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Histogram extends Metric {
  private readonly series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>();
  readonly buckets: readonly number[];

  constructor(name: string, help: string, buckets: readonly number[] = DEFAULT_BUCKETS) {
    super(name, help, 'histogram');
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    this.checkLabels(labels);
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { labels: { ...labels }, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) s.counts[i]!++;
    s.sum += value;
    s.count++;
  }

  /** Observation count for a label set (tests). */
  count(labels: Labels = {}): number {
    return this.series.get(labelKey(labels))?.count ?? 0;
  }

  reset(): void {
    this.series.clear();
  }

  samples(): string[] {
    const out: string[] = [];
    for (const s of this.series.values()) {
      this.buckets.forEach((le, i) => out.push(`${this.name}_bucket${renderLabels(s.labels, ['le', formatValue(le)])} ${s.counts[i]}`));
      out.push(`${this.name}_bucket${renderLabels(s.labels, ['le', '+Inf'])} ${s.count}`);
      out.push(`${this.name}_sum${renderLabels(s.labels)} ${formatValue(s.sum)}`);
      out.push(`${this.name}_count${renderLabels(s.labels)} ${s.count}`);
    }
    return out;
  }
}

/** Runs before each render to refresh scrape-time gauges. Throwing is counted, not fatal. */
export type Collector = () => void | Promise<void>;

export class Registry {
  private readonly metrics = new Map<string, Metric>();
  private readonly collectors: Array<{ name: string; fn: Collector }> = [];
  private readonly collectorErrors: Counter;

  constructor() {
    this.collectorErrors = this.counter('arclight_metrics_collector_errors_total', 'Scrape-time collectors that threw, by collector.');
  }

  private add<M extends Metric>(metric: M): M {
    if (this.metrics.has(metric.name)) throw new Error(`metric already registered: ${metric.name}`);
    this.metrics.set(metric.name, metric);
    return metric;
  }

  counter(name: string, help: string): Counter {
    return this.add(new Counter(name, help));
  }

  gauge(name: string, help: string): Gauge {
    return this.add(new Gauge(name, help));
  }

  histogram(name: string, help: string, buckets?: readonly number[]): Histogram {
    return this.add(new Histogram(name, help, buckets));
  }

  get(name: string): Metric | undefined {
    return this.metrics.get(name);
  }

  addCollector(name: string, fn: Collector): void {
    this.collectors.push({ name, fn });
  }

  async collect(onError?: (name: string, err: unknown) => void): Promise<void> {
    for (const c of this.collectors) {
      try {
        await c.fn();
      } catch (err) {
        this.collectorErrors.inc({ collector: c.name });
        onError?.(c.name, err);
      }
    }
  }

  /** Text exposition format; metrics without samples print only HELP/TYPE. */
  async render(onError?: (name: string, err: unknown) => void): Promise<string> {
    await this.collect(onError);
    return [...this.metrics.values()].map((m) => m.render()).join('\n') + '\n';
  }
}
