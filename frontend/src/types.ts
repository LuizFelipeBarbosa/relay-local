// Wire types for the local dashboard API (/api/v1/*).
// These mirror internal/dashboard/dashboard.go, internal/history/store.go,
// internal/metrics/metrics.go, internal/config/config.go and protocol/protocol.go.
// Fields the Go side marks omitempty are optional here: a zero value is simply absent.

export type BackendKind = 'ollama' | 'cliproxyapi';

/** 'local' = models installed on this machine; 'provider' = reached through a gateway account. */
export type BackendSource = 'local' | 'provider';

export interface Status {
  host_id: string;
  os: string;
  arch: string;
  /** The agent loop is running (connected or retrying). */
  running: boolean;
  /** The owner's intent: availability.enabled && !availability.paused. */
  sharing: boolean;
  /** RFC3339; when the agent loop last started. Absent if it never started. */
  started_at?: string;
  dashboard: string;
  token_present: boolean;
}

export interface Model {
  /** Prefixed id as advertised to buyers, e.g. "ollama/gemma4:e2b". */
  id: string;
  /** Native name as the runtime knows it; this is the key used in offers. */
  name: string;
  digest?: string;
}

export interface Backend {
  id: string;
  kind: BackendKind;
  source: BackendSource;
  ready: boolean;
  /** Configured concurrency. NOT live load — see derive.ts. */
  capacity: number;
  /** Equal to capacity on this endpoint; the discovery path does not report live use. */
  available: number;
  models: Model[];
}

/** offers[backend_id][model_name] === true when a model is allowlisted. */
export type Offers = Record<string, Record<string, boolean>>;

export interface ModelsResponse {
  backends: Backend[];
  offers: Offers;
}

export interface UsageSummary {
  requests: number;
  successful: number;
  failed: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** False when no request ever reported usage: totals are unknown, not zero. */
  usage_reported: boolean;
  /** False when some successful request lacked usage: totals are partial. */
  complete: boolean;
}

/** Requests in flight right now, counted by the agent as chunks stream through. */
export interface LiveUsage {
  requests: number;
  bytes: number;
  /** The agent's own rough estimate: streamed bytes / 4. Not a provider figure. */
  output_tokens_estimate: number;
}

export interface UsageResponse {
  today: UsageSummary;
  lifetime: UsageSummary;
  /** Absent on an agent older than the live-attempt tracking. */
  live?: LiveUsage;
  complete: boolean;
}

export type HistoryKind = 'request' | 'pause' | 'resume';

export interface HistoryEvent {
  time: string;
  kind: HistoryKind;
  /** "backend_id/model_name" for requests. */
  model?: string;
  /** 'completed' | 'failed' for requests; 'pause' | 'stop' | 'sharing' for availability events. */
  status?: string;
  duration_ms?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  usage_reported?: boolean;
  usage_complete?: boolean;
  total_reported?: boolean;
}

export interface HistoryResponse {
  events: HistoryEvent[];
  complete: boolean;
}

/** Host-wide metrics, not the agent's own usage. */
export interface Metrics {
  os: string;
  arch: string;
  cpus: number;
  memory_total: number;
  memory_used: number;
  memory_used_percent: number;
  cpu_percent: number;
  uptime_seconds: number;
}

export interface RuntimeInfo {
  name: string;
  id?: string;
  endpoint?: string;
  configured: boolean;
  /** Detected executable path, or "" when the binary was not found. */
  binary: string;
}

export interface Price {
  input_per_million?: string;
  output_per_million?: string;
}

/** Keyed by model id ("backend/name"), unlike offers which are keyed by name. */
export type Prices = Record<string, Price>;

export interface BackendConfig {
  id: string;
  label?: string;
  kind: BackendKind;
  url: string;
  key_env?: string;
  models: string[];
  concurrency: number;
}

export interface Availability {
  enabled: boolean;
  paused: boolean;
  timezone?: string;
}

export interface AgentConfig {
  coordinator_url: string;
  host_id: string;
  token_env: string;
  start_timeout_seconds: number;
  total_timeout_seconds: number;
  backends: BackendConfig[];
  prices?: Prices;
  availability?: Availability;
}

export interface ModelJob {
  id: string;
  model: string;
  /** Free text from Ollama ("pulling <digest>", "verifying sha256 digest", "complete", "failed"). */
  status: string;
  progress: number;
  error?: string;
}

export type AvailabilityAction = 'pause' | 'stop' | 'resume';
