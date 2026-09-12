export type Status = { host_id: string; os: string; arch: string; running: boolean; sharing: boolean; started_at?: string; dashboard: string };
export type Model = { id: string; name: string; digest?: string };
export type Backend = { id: string; kind: string; source: string; ready: boolean; capacity: number; available: number; models: Model[] };
export type Offers = Record<string, Record<string, boolean>>;
export type UsageSummary = { requests: number; successful: number; failed: number; input_tokens: number; output_tokens: number; total_tokens: number; usage_reported: boolean; complete: boolean };
export type Usage = { today: UsageSummary; lifetime: UsageSummary; live?: { requests: number; bytes: number; output_tokens_estimate: number }; complete: boolean };
export type HistoryEvent = { time: string; kind: string; model?: string; status?: string; duration_ms?: number; input_tokens?: number; output_tokens?: number; total_tokens?: number; usage_reported?: boolean; usage_complete?: boolean; total_reported?: boolean };
export type Price = { input_per_million?: string; output_per_million?: string };
export type Prices = Record<string, Price>;
export type BackendConfig = { id: string; label?: string; kind: string; url: string; key_env?: string; models: string[]; concurrency: number };
export type AgentConfig = { coordinator_url: string; host_id: string; token_env: string; start_timeout_seconds: number; total_timeout_seconds: number; backends: BackendConfig[]; prices?: Prices; availability?: { enabled: boolean; paused: boolean; timezone?: string } };
export type ModelJob = { id: string; model: string; status: string; progress: number; error?: string };

const emptySummary: UsageSummary = { requests: 0, successful: 0, failed: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, usage_reported: false, complete: true };
export const emptyStatus: Status = { host_id: '—', os: '—', arch: '—', running: false, sharing: false, dashboard: 'http://127.0.0.1:7331' };
export const emptyUsage: Usage = { today: emptySummary, lifetime: emptySummary, complete: true };

export const AUTH_REQUIRED = 'dashboard authentication required';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/api/v1' + path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return response.json();
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

const KIND_NAMES: Record<string, string> = { ollama: 'Ollama', cliproxyapi: 'CLIProxyAPI' };

/** Product name for a runtime kind, used as the display fallback and the provider column. */
export function kindName(kind: string) {
  return KIND_NAMES[kind] || kind;
}

/** Display name for a backend: the configured label; the product name when the id is just the kind; otherwise the id. */
export function backendTitle(backend: { id: string; kind?: string }, config: AgentConfig | null) {
  const configured = config?.backends.find(b => b.id === backend.id);
  if (configured?.label) return configured.label;
  const kind = backend.kind || configured?.kind || '';
  return backend.id === kind ? kindName(kind) : backend.id;
}

export function backendRole(kind: string) {
  return kind === 'ollama' ? 'Local weights runtime' : 'Provider gateway';
}
