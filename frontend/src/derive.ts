// Pure derivations from the API payloads. No React, no DOM, no fetch.
//
// The rule throughout: never invent a number. When the agent does not report
// something, these functions say so explicitly instead of returning zero.
import type {
  AgentConfig, Backend, BackendConfig, HistoryEvent, Metrics, Offers, Prices, Status, UsageSummary,
} from './types';

/** The single sharing state to show, resolved from two independent booleans. */
export type SharingState = 'live' | 'starting' | 'paused';

export interface SharingSummary {
  state: SharingState;
  label: string;
  detail: string;
}

/**
 * `sharing` is the owner's intent and `running` is the agent loop. They disagree
 * when sharing is on but the loop is not up — usually a missing host token env var.
 */
export function summarizeSharing(status: Status): SharingSummary {
  if (!status.sharing) {
    return {
      state: 'paused',
      label: 'Not sharing',
      detail: 'This machine is not accepting work. Resume to start again.',
    };
  }
  if (!status.running) {
    return {
      state: 'starting',
      label: 'Sharing is on, agent is not running',
      detail: `The agent loop is not running. Check that ${'$'}{token_env} is set in the environment that started Relay.`,
    };
  }
  return {
    state: 'live',
    label: 'Sharing',
    detail: 'Connected to the coordinator and accepting work.',
  };
}

/** Seconds since the agent loop started, or null when it never has. */
export function sessionSeconds(status: Status, now: Date = new Date()): number | null {
  if (!status.started_at) return null;
  const started = new Date(status.started_at).getTime();
  if (!Number.isFinite(started)) return null;
  return Math.max(0, (now.getTime() - started) / 1000);
}

export interface RuntimeView {
  id: string;
  label: string;
  kind: Backend['kind'];
  source: Backend['source'];
  ready: boolean;
  /** Configured concurrency. The discovery endpoint does not report live load. */
  concurrency: number;
  url?: string;
  keyEnv?: string;
  installed: number;
  offered: number;
  models: Backend['models'];
}

/**
 * The inventory endpoint omits the human label, which only exists in the config,
 * so the two have to be joined by backend id before anything is displayed.
 */
export function runtimeViews(backends: Backend[], offers: Offers, config: AgentConfig | null): RuntimeView[] {
  const byId = new Map<string, BackendConfig>((config?.backends || []).map(b => [b.id, b]));
  return backends.map(backend => {
    const configured = byId.get(backend.id);
    const offered = offers[backend.id] || {};
    return {
      id: backend.id,
      label: configured?.label?.trim() || backend.id,
      kind: backend.kind,
      source: backend.source,
      ready: backend.ready,
      concurrency: configured?.concurrency ?? backend.capacity,
      url: configured?.url,
      keyEnv: configured?.key_env,
      installed: backend.models.length,
      offered: backend.models.filter(m => offered[m.name]).length,
      models: backend.models,
    };
  });
}

/** Ollama install and remove act on the first configured Ollama backend only. */
export function installTargetId(config: AgentConfig | null): string | null {
  return config?.backends.find(b => b.kind === 'ollama')?.id ?? null;
}

export interface UsageView {
  /** True when at least one request reported usage; otherwise totals are unknown. */
  reported: boolean;
  /** False when some successful request lacked usage, making totals a lower bound. */
  complete: boolean;
  requests: number;
  successful: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Null when nothing was reported — render as "not reported", never as 0. */
  displayTotal: number | null;
  note: string | null;
}

export function usageView(summary: UsageSummary): UsageView {
  const reported = summary.usage_reported;
  let note: string | null = null;
  if (!reported && summary.requests > 0) note = 'No request reported token usage.';
  else if (!reported) note = 'No requests yet.';
  else if (!summary.complete) note = 'Some requests did not report usage, so totals are a lower bound.';
  return {
    reported,
    complete: summary.complete,
    requests: summary.requests,
    successful: summary.successful,
    failed: summary.failed,
    inputTokens: summary.input_tokens,
    outputTokens: summary.output_tokens,
    totalTokens: summary.total_tokens,
    displayTotal: reported ? summary.total_tokens : null,
    note,
  };
}

export const isRequest = (event: HistoryEvent): boolean => event.kind === 'request';
export const isSuccess = (event: HistoryEvent): boolean => event.kind === 'request' && event.status === 'completed';

/** Tokens actually reported for one event; absent fields mean "not reported". */
export function eventTokens(event: HistoryEvent): { input: number; output: number; total: number | null } {
  const input = event.input_tokens ?? 0;
  const output = event.output_tokens ?? 0;
  if (!event.usage_reported) return { input, output, total: null };
  const total = event.total_reported ? (event.total_tokens ?? 0) : input + output;
  return { input, output, total };
}

export interface ModelRollup {
  model: string;
  requests: number;
  successful: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of reported durations, and how many events reported one. */
  durationMs: number;
  durationSamples: number;
  amount: number;
  priced: boolean;
}

export function rollupByModel(events: HistoryEvent[], prices: Prices): ModelRollup[] {
  const rows = new Map<string, ModelRollup>();
  for (const event of events) {
    if (!isRequest(event) || !event.model) continue;
    let row = rows.get(event.model);
    if (!row) {
      const price = prices[event.model];
      row = {
        model: event.model, requests: 0, successful: 0, failed: 0,
        inputTokens: 0, outputTokens: 0, durationMs: 0, durationSamples: 0,
        amount: 0, priced: hasPrice(price),
      };
      rows.set(event.model, row);
    }
    row.requests++;
    if (event.status === 'completed') row.successful++;
    else row.failed++;
    const tokens = eventTokens(event);
    row.inputTokens += tokens.input;
    row.outputTokens += tokens.output;
    if (event.duration_ms !== undefined) {
      row.durationMs += event.duration_ms;
      row.durationSamples++;
    }
    row.amount += eventAmount(event, prices);
  }
  return [...rows.values()].sort((a, b) => b.requests - a.requests);
}

function hasPrice(price: Prices[string] | undefined): boolean {
  if (!price) return false;
  return parseRate(price.input_per_million) !== null || parseRate(price.output_per_million) !== null;
}

/** Prices are decimal strings; anything unparseable or negative counts as unset. */
export function parseRate(value: string | undefined): number | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** What one request would be worth at the owner's asking prices. */
export function eventAmount(event: HistoryEvent, prices: Prices): number {
  if (!event.model || !event.usage_reported) return 0;
  const price = prices[event.model];
  if (!price) return 0;
  const input = parseRate(price.input_per_million) ?? 0;
  const output = parseRate(price.output_per_million) ?? 0;
  const tokens = eventTokens(event);
  return (tokens.input * input + tokens.output * output) / 1_000_000;
}

export interface EarningsEstimate {
  amount: number;
  /** Request events the estimate is based on. */
  countedRequests: number;
  /** Requests today per /usage, when known — may exceed what history still holds. */
  reportedRequests: number | null;
  /** True when /usage counts more of today's requests than history retains. */
  truncated: boolean;
  /** Models seen in the counted events that have no price set. */
  unpricedModels: string[];
  /** True when no model involved has any price. */
  anyPriced: boolean;
}

/**
 * History keeps only the last 100 events, so this is explicitly an estimate over
 * the events still held — never presented as money received.
 */
export function estimateEarnings(
  events: HistoryEvent[],
  prices: Prices,
  todayUsage?: UsageSummary,
  since?: Date,
): EarningsEstimate {
  const cutoff = since ? since.getTime() : null;
  const counted = events.filter(event => {
    if (!isRequest(event) || !event.model) return false;
    if (cutoff === null) return true;
    const time = new Date(event.time).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
  let amount = 0;
  const unpriced = new Set<string>();
  let anyPriced = false;
  for (const event of counted) {
    amount += eventAmount(event, prices);
    if (hasPrice(prices[event.model!])) anyPriced = true;
    else unpriced.add(event.model!);
  }
  const reportedRequests = todayUsage ? todayUsage.requests : null;
  return {
    amount,
    countedRequests: counted.length,
    reportedRequests,
    truncated: reportedRequests !== null && reportedRequests > counted.length,
    unpricedModels: [...unpriced].sort(),
    anyPriced,
  };
}

export interface Bucket {
  /** Start of the bucket. */
  time: Date;
  requests: number;
  successful: number;
  failed: number;
  tokens: number;
}

/** Request counts per hour over the last `hours`, oldest first, gaps included as zeroes. */
export function bucketByHour(events: HistoryEvent[], hours = 12, now: Date = new Date()): Bucket[] {
  const end = new Date(now);
  end.setMinutes(0, 0, 0);
  const buckets: Bucket[] = [];
  const index = new Map<number, Bucket>();
  for (let i = hours - 1; i >= 0; i--) {
    const time = new Date(end.getTime() - i * 3_600_000);
    const bucket: Bucket = { time, requests: 0, successful: 0, failed: 0, tokens: 0 };
    buckets.push(bucket);
    index.set(time.getTime(), bucket);
  }
  for (const event of events) {
    if (!isRequest(event)) continue;
    const time = new Date(event.time);
    if (Number.isNaN(time.getTime())) continue;
    time.setMinutes(0, 0, 0);
    const bucket = index.get(time.getTime());
    if (!bucket) continue;
    bucket.requests++;
    if (event.status === 'completed') bucket.successful++;
    else bucket.failed++;
    const tokens = eventTokens(event);
    bucket.tokens += tokens.total ?? 0;
  }
  return buckets;
}

export interface HostSummary {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsed: number;
  memoryTotal: number;
  cpus: number;
  uptimeSeconds: number;
}

/** These are machine-wide figures from gopsutil, not Relay's own consumption. */
export function hostSummary(metrics: Metrics): HostSummary {
  return {
    cpuPercent: metrics.cpu_percent,
    memoryPercent: metrics.memory_used_percent,
    memoryUsed: metrics.memory_used,
    memoryTotal: metrics.memory_total,
    cpus: metrics.cpus,
    uptimeSeconds: metrics.uptime_seconds,
  };
}

// ---------------------------------------------------------------------------
// Config validation — mirrors config.Validate in internal/config/config.go so the
// owner sees field-level errors instead of one generic 400 from the server.
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[a-zA-Z0-9_-]{1,64}$/;

export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (hostname === '::1' || hostname === '[::1]') return true;
  return /^127(\.\d{1,3}){3}$/.test(hostname);
}

export type FieldErrors = Record<string, string>;

export function validateCoordinatorURL(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a WebSocket URL, for example ws://127.0.0.1:8080/relay/v1/connect';
  }
  if (url.username || url.password) return 'Remove the credentials from the URL.';
  if (url.search || url.hash) return 'Remove the query string and fragment.';
  if (url.pathname !== '/relay/v1/connect') return 'The path must be /relay/v1/connect';
  const scheme = url.protocol.replace(':', '');
  if (scheme === 'wss') return null;
  if (scheme === 'ws') {
    return isLoopbackHost(url.hostname) ? null : 'Use wss:// for a coordinator that is not on this machine.';
  }
  return 'Use ws:// or wss://';
}

export function validateBackendURL(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a URL, for example http://127.0.0.1:11434';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'Use http:// or https://';
  if (url.username || url.password) return 'Remove the credentials from the URL.';
  if (url.search || url.hash) return 'Remove the query string and fragment.';
  if (url.pathname !== '' && url.pathname !== '/') return 'Enter the root URL, without /v1 or any other path.';
  if (!isLoopbackHost(url.hostname)) return 'The runtime must be on this machine (127.0.0.1 or localhost).';
  return null;
}

/**
 * Concurrency must reach the server as a number: the previous UI kept the raw input
 * string, which made every configuration save fail with HTTP 400.
 */
export function validateConcurrency(value: unknown): string | null {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 'Enter a whole number.';
  if (parsed < 1 || parsed > 64) return 'Choose a value between 1 and 64.';
  return null;
}

export function validateConfig(config: AgentConfig): FieldErrors {
  const errors: FieldErrors = {};
  if (!IDENTIFIER.test(config.host_id)) errors.host_id = 'Letters, numbers, dashes and underscores only.';
  if (!IDENTIFIER.test(config.token_env)) errors.token_env = 'Letters, numbers, dashes and underscores only.';
  const coordinator = validateCoordinatorURL(config.coordinator_url);
  if (coordinator) errors.coordinator_url = coordinator;
  if (config.backends.length === 0) errors.backends = 'Add at least one runtime.';
  if (config.backends.length > 64) errors.backends = 'Relay supports up to 64 runtimes.';

  const seen = new Set<string>();
  config.backends.forEach((backend, index) => {
    const at = (field: string) => `backends.${index}.${field}`;
    if (!IDENTIFIER.test(backend.id)) errors[at('id')] = 'Letters, numbers, dashes and underscores only.';
    else if (seen.has(backend.id)) errors[at('id')] = 'Another runtime already uses this id.';
    seen.add(backend.id);
    const url = validateBackendURL(backend.url);
    if (url) errors[at('url')] = url;
    if (backend.key_env && !IDENTIFIER.test(backend.key_env)) {
      errors[at('key_env')] = 'Enter the variable name, not the key itself.';
    }
    const concurrency = validateConcurrency(backend.concurrency);
    if (concurrency) errors[at('concurrency')] = concurrency;
    if (backend.models.length > 1024) errors[at('models')] = 'Too many models allowlisted.';
  });
  return errors;
}

/** Coerce form values to the types the server expects before PUT /config. */
export function normalizeConfig(config: AgentConfig): AgentConfig {
  return {
    ...config,
    host_id: config.host_id.trim(),
    token_env: config.token_env.trim(),
    coordinator_url: config.coordinator_url.trim(),
    backends: config.backends.map(backend => ({
      ...backend,
      id: backend.id.trim(),
      url: backend.url.trim().replace(/\/+$/, ''),
      label: backend.label?.trim() || undefined,
      key_env: backend.key_env?.trim() || undefined,
      concurrency: Number(backend.concurrency),
    })),
  };
}

/** A unique id for a newly added CLIProxyAPI endpoint. */
export function nextBackendId(config: AgentConfig, prefix = 'cliproxyapi'): string {
  const taken = new Set(config.backends.map(b => b.id));
  for (let n = 1; n < 1000; n++) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}-${Date.now()}`;
}

export function validatePriceInput(value: string): string | null {
  if (value.trim() === '') return null;
  if (!/^\d*(\.\d*)?$/.test(value.trim())) return 'Enter a number, for example 0.40';
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 'Enter a number of zero or more.';
  return null;
}
