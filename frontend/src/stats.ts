// Derived numbers for the dashboard. Everything here is computed from the
// request history the agent records (last 100 requests) and the asking prices
// stored in relay.json. Nothing is fabricated: when data is missing the
// helpers return zero or null and the views show a placeholder.
import type { HistoryEvent, Prices } from './api';

export type Range = '24h' | '7d' | '30d' | 'ytd';
export const RANGES: Range[] = ['24h', '7d', '30d', 'ytd'];

export const formatNumber = (n: number) => new Intl.NumberFormat().format(n);
export const formatCompact = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
export const usd = (n: number) => '$' + n.toFixed(2);
export const formatMs = (ms: number) => ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms';

export function percentChange(current: number, previous: number): number | null {
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function requestEvents(events: HistoryEvent[]) {
  return events.filter(e => e.kind === 'request');
}

export function completed(events: HistoryEvent[]) {
  return events.filter(e => e.status === 'completed');
}

function parsePrice(value?: string): number | null {
  if (!value || !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function isPriced(prices: Prices, modelId: string) {
  const price = prices[modelId];
  return !!price && parsePrice(price.input_per_million) !== null && parsePrice(price.output_per_million) !== null;
}

/** Estimated USD earned by one request, using both asking rates. Unpriced or usage-less requests earn nothing. */
export function revenueOf(event: HistoryEvent, prices: Prices): number {
  if (!event.model || !event.usage_reported || !isPriced(prices, event.model)) return 0;
  const price = prices[event.model];
  const input = parsePrice(price.input_per_million) ?? 0;
  const output = parsePrice(price.output_per_million) ?? 0;
  return ((event.input_tokens || 0) / 1e6) * input + ((event.output_tokens || 0) / 1e6) * output;
}

export function tokensOf(event: HistoryEvent) {
  if (!event.usage_reported) return 0;
  return event.total_reported ? (event.total_tokens || 0) : (event.input_tokens || 0) + (event.output_tokens || 0);
}

/** Output tokens per second for a completed request, or null when either number is missing. */
export function throughputOf(event: HistoryEvent): number | null {
  if (event.status !== 'completed' || !event.output_tokens || !event.duration_ms) return null;
  return event.output_tokens / (event.duration_ms / 1000);
}

export function sumRevenue(events: HistoryEvent[], prices: Prices) {
  return events.reduce((total, e) => total + revenueOf(e, prices), 0);
}

export function startOfDay(date: Date, daysAgo = 0) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo);
}

export function eventsSince(events: HistoryEvent[], since: Date, until?: Date) {
  return events.filter(e => {
    const t = new Date(e.time).getTime();
    return t >= since.getTime() && (!until || t < until.getTime());
  });
}

export type Series = { revenue: number[]; throughput: number[]; start: string; mid: string; hasData: boolean };

/** Buckets request history into a revenue-per-bucket and throughput-per-bucket series for the chart. */
export function series(events: HistoryEvent[], prices: Prices, range: Range, now = new Date()): Series {
  const buckets = bucketsFor(range, now);
  const revenue = new Array(buckets.length).fill(0);
  const outputTokens = new Array(buckets.length).fill(0);
  const seconds = new Array(buckets.length).fill(0);
  for (const event of events) {
    const t = new Date(event.time).getTime();
    const index = buckets.findIndex((b, i) => t >= b.getTime() && (i === buckets.length - 1 || t < buckets[i + 1].getTime()));
    if (index < 0) continue;
    revenue[index] += revenueOf(event, prices);
    if (event.status === 'completed' && event.output_tokens && event.duration_ms) {
      outputTokens[index] += event.output_tokens;
      seconds[index] += event.duration_ms / 1000;
    }
  }
  const throughput = outputTokens.map((tokens, i) => seconds[i] > 0 ? tokens / seconds[i] : 0);
  const labels = axisLabels(range, buckets);
  return { revenue, throughput, ...labels, hasData: revenue.some(v => v > 0) || throughput.some(v => v > 0) };
}

function bucketsFor(range: Range, now: Date): Date[] {
  if (range === '24h') {
    const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    return Array.from({ length: 24 }, (_, i) => new Date(currentHour.getTime() - (23 - i) * 3600_000));
  }
  if (range === '7d') return Array.from({ length: 7 }, (_, i) => startOfDay(now, 6 - i));
  if (range === '30d') return Array.from({ length: 30 }, (_, i) => startOfDay(now, 29 - i));
  return Array.from({ length: now.getMonth() + 1 }, (_, i) => new Date(now.getFullYear(), i, 1));
}

function axisLabels(range: Range, buckets: Date[]) {
  const mid = buckets[Math.floor(buckets.length / 2)];
  const day = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
  const month = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' }).toLowerCase();
  if (range === '24h') return { start: pad(buckets[0].getHours()) + ':00', mid: pad(mid.getHours()) + ':00' };
  if (range === 'ytd') return { start: month(buckets[0]), mid: buckets.length > 2 ? month(mid) : '' };
  return { start: day(buckets[0]), mid: day(mid) };
}

export const pad = (n: number) => String(n).padStart(2, '0');

/** SVG path through the values, scaled into the given box. A single point draws as a flat line. */
export function linePath(values: number[], max: number, width: number, top: number, bottom: number) {
  if (values.length === 0) return '';
  const points = values.length === 1 ? [values[0], values[0]] : values;
  const scale = max > 0 ? max : 1;
  return points.map((v, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * width).toFixed(1)},${(bottom - (v / scale) * (bottom - top)).toFixed(1)}`).join(' ');
}

export type DayTokens = { date: Date; input: number; output: number };

export function tokensPerDay(events: HistoryEvent[], days: number, now = new Date()): DayTokens[] {
  const result = Array.from({ length: days }, (_, i) => ({ date: startOfDay(now, days - 1 - i), input: 0, output: 0 }));
  for (const event of events) {
    if (!event.usage_reported) continue;
    const day = startOfDay(new Date(event.time)).getTime();
    const bucket = result.find(r => r.date.getTime() === day);
    if (!bucket) continue;
    bucket.input += event.input_tokens || 0;
    bucket.output += event.output_tokens || 0;
  }
  return result;
}

export type ModelStats = { model: string; requests: number; failed: number; tokens: number; revenue: number; throughputP50: number | null; durationP50: number | null; durationP95: number | null };

export function perModel(events: HistoryEvent[], prices: Prices): ModelStats[] {
  const groups = new Map<string, HistoryEvent[]>();
  for (const event of events) {
    if (!event.model) continue;
    groups.set(event.model, [...(groups.get(event.model) || []), event]);
  }
  return [...groups].map(([model, list]) => {
    const durations = completed(list).map(e => e.duration_ms || 0).filter(d => d > 0);
    const throughputs = list.map(throughputOf).filter((v): v is number => v !== null);
    return {
      model,
      requests: list.length,
      failed: list.filter(e => e.status !== 'completed').length,
      tokens: list.reduce((n, e) => n + tokensOf(e), 0),
      revenue: sumRevenue(list, prices),
      throughputP50: percentile(throughputs, 50),
      durationP50: percentile(durations, 50),
      durationP95: percentile(durations, 95),
    };
  });
}

/** Schedule of accepting hours, kept in this browser. Rows are Monday..Sunday, columns are hours. */
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export type Schedule = boolean[][];
export const nightsAndWeekends = (): Schedule => DAYS.map((_, day) => Array.from({ length: 24 }, (_, hour) => day >= 5 || hour < 8 || hour >= 19));
export const alwaysOn = (): Schedule => DAYS.map(() => Array(24).fill(true));
