// Typed access to the local dashboard API.
//
// Auth is an HttpOnly `relay_session` cookie set by POST /session; the page never
// holds the token. The server also rejects non-GET requests whose Origin is not the
// loopback dashboard, which the Vite dev proxy rewrites for us in development.
import type {
  AgentConfig, AvailabilityAction, HistoryResponse, Metrics, ModelJob,
  ModelsResponse, Prices, RuntimeInfo, Status, UsageResponse,
} from './types';

/** Message the server returns when the session cookie is missing or stale. */
export const AUTH_REQUIRED = 'dashboard authentication required';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
  get authRequired(): boolean {
    return this.status === 401 || this.message === AUTH_REQUIRED;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/v1' + path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
  } catch {
    // Network-level failure: the agent stopped, or the browser is offline.
    throw new ApiError('Cannot reach the Relay agent on this machine.', 0);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  /** Exchange a dashboard token for the session cookie. */
  authenticate: (token: string) => post<{ authenticated: boolean }>('/session', { token }),

  status: () => request<Status>('/status'),
  metrics: () => request<Metrics>('/metrics'),
  runtimes: () => request<RuntimeInfo[]>('/runtimes'),
  usage: () => request<UsageResponse>('/usage'),
  history: () => request<HistoryResponse>('/history'),
  models: () => request<ModelsResponse>('/models'),
  config: () => request<AgentConfig>('/config'),
  prices: () => request<Prices>('/prices'),
  modelJobs: () => request<ModelJob[]>('/models/jobs'),

  /** pause: take no new work. stop: also cancel work in flight. resume: share again. */
  setAvailability: (action: AvailabilityAction) => post<Status>('/availability', { action }),

  /** `model` is the runtime's native model name, not the prefixed id. */
  setOffer: (backend_id: string, model: string, offer: boolean) =>
    post<{ saved: boolean }>('/models', { backend_id, model, offer }),

  /** Pulls into the first configured Ollama backend; poll modelJobs() for progress. */
  installModel: (model: string) => post<ModelJob>('/models/install', { model }),
  removeModel: (model: string) => post<{ removed: boolean }>('/models/remove', { model }),

  /** `model` is the prefixed model id here, matching the prices map keys. */
  setPrice: (model: string, input_per_million: string, output_per_million: string) =>
    post<Prices>('/prices', { model, input_per_million, output_per_million }),

  /** Send the whole config back; saving restarts the agent loop. */
  saveConfig: (config: AgentConfig) =>
    request<AgentConfig>('/config', { method: 'PUT', body: JSON.stringify(config) }),
};
