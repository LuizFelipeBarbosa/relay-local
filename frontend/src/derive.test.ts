import { describe, expect, it } from 'vitest';
import {
  bucketByHour, estimateEarnings, eventAmount, eventTokens, installTargetId,
  isLoopbackHost, nextBackendId, normalizeConfig, rollupByModel, runtimeViews,
  sessionSeconds, summarizeSharing, usageView, validateBackendURL, validateConcurrency,
  validateConfig, validateCoordinatorURL, validatePriceInput,
} from './derive';
import type { AgentConfig, Backend, HistoryEvent, Prices, Status, UsageSummary } from './types';

const status = (over: Partial<Status> = {}): Status => ({
  host_id: 'henry-mbp', os: 'darwin', arch: 'arm64', running: true, sharing: true,
  started_at: '2026-09-12T21:44:50Z', dashboard: 'http://127.0.0.1:7331', token_present: true, ...over,
});

const config = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  coordinator_url: 'ws://127.0.0.1:8080/relay/v1/connect',
  host_id: 'henry-mbp', token_env: 'RELAY_MAC_TOKEN',
  start_timeout_seconds: 120, total_timeout_seconds: 600,
  backends: [
    { id: 'fake', label: 'Test backend', kind: 'ollama', url: 'http://127.0.0.1:11435', models: ['fake'], concurrency: 2 },
    { id: 'ollama', kind: 'ollama', url: 'http://127.0.0.1:11434', models: [], concurrency: 1 },
    { id: 'cliproxyapi-8317', label: 'CLIProxyAPI', kind: 'cliproxyapi', url: 'http://127.0.0.1:8317', key_env: 'CLIPROXYAPI_KEY', models: [], concurrency: 1 },
  ],
  ...over,
});

// Shapes taken from a live agent (scratchpad/env/api/*.json).
const backends: Backend[] = [
  { id: 'fake', kind: 'ollama', source: 'local', ready: true, capacity: 2, available: 2, models: [{ id: 'fake/fake', name: 'fake', digest: 'fake-digest-v1' }] },
  { id: 'ollama', kind: 'ollama', source: 'local', ready: true, capacity: 1, available: 1, models: [{ id: 'ollama/vaultbox/qwen3.5-uncensored:4b', name: 'vaultbox/qwen3.5-uncensored:4b', digest: '388a0b599356d3508709fa595fc1af158e1b749bd25c61961b49be25c6d72e85' }] },
  { id: 'cliproxyapi-8317', kind: 'cliproxyapi', source: 'provider', ready: false, capacity: 1, available: 1, models: [] },
];
const offers = { fake: { fake: true }, ollama: {}, 'cliproxyapi-8317': {} };

const completed = (over: Partial<HistoryEvent> = {}): HistoryEvent => ({
  time: '2026-09-12T21:45:17.147294Z', kind: 'request', model: 'fake/fake', status: 'completed',
  duration_ms: 302, input_tokens: 3, output_tokens: 4, total_tokens: 7,
  usage_reported: true, usage_complete: true, total_reported: true, ...over,
});

describe('summarizeSharing', () => {
  it('reports live sharing when the agent loop is running', () => {
    expect(summarizeSharing(status()).state).toBe('live');
  });

  it('distinguishes sharing-on-but-not-running from paused', () => {
    // The pair disagrees when the host token is missing: this must not read as "live".
    expect(summarizeSharing(status({ running: false })).state).toBe('starting');
    expect(summarizeSharing(status({ sharing: false })).state).toBe('paused');
    expect(summarizeSharing(status({ sharing: false, running: false })).state).toBe('paused');
  });
});

describe('sessionSeconds', () => {
  it('measures from started_at', () => {
    const now = new Date('2026-09-12T22:44:50Z');
    expect(sessionSeconds(status(), now)).toBe(3600);
  });

  it('returns null when the agent never started', () => {
    expect(sessionSeconds(status({ started_at: undefined }))).toBeNull();
  });
});

describe('runtimeViews', () => {
  it('joins labels from the config, which the inventory endpoint omits', () => {
    const views = runtimeViews(backends, offers, config());
    expect(views.map(v => v.label)).toEqual(['Test backend', 'ollama', 'CLIProxyAPI']);
  });

  it('falls back to the id when no config is loaded yet', () => {
    expect(runtimeViews(backends, offers, null)[0].label).toBe('fake');
  });

  it('counts installed and offered models separately', () => {
    const views = runtimeViews(backends, offers, config());
    expect(views[0]).toMatchObject({ installed: 1, offered: 1 });
    // Installed but deliberately not offered.
    expect(views[1]).toMatchObject({ installed: 1, offered: 0 });
    expect(views[2]).toMatchObject({ installed: 0, offered: 0, ready: false });
  });

  it('prefers configured concurrency over the advertised capacity', () => {
    expect(runtimeViews(backends, offers, config())[0].concurrency).toBe(2);
  });
});

describe('installTargetId', () => {
  it('names the first Ollama backend, which is where installs land', () => {
    expect(installTargetId(config())).toBe('fake');
  });

  it('returns null without an Ollama runtime', () => {
    expect(installTargetId(config({ backends: [config().backends[2]] }))).toBeNull();
  });
});

describe('usageView', () => {
  const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
    requests: 10, successful: 9, failed: 1, input_tokens: 27, output_tokens: 36,
    total_tokens: 63, usage_reported: true, complete: true, ...over,
  });

  it('passes through reported totals', () => {
    expect(usageView(summary()).displayTotal).toBe(63);
  });

  it('shows unknown rather than zero when nothing was reported', () => {
    const view = usageView(summary({ usage_reported: false, total_tokens: 0 }));
    expect(view.displayTotal).toBeNull();
    expect(view.note).toBe('No request reported token usage.');
  });

  it('flags partial totals', () => {
    expect(usageView(summary({ complete: false })).note).toMatch(/lower bound/);
  });

  it('says so when there is no traffic at all', () => {
    expect(usageView(summary({ requests: 0, usage_reported: false })).note).toBe('No requests yet.');
  });
});

describe('eventTokens', () => {
  it('uses the reported total when the backend sent one', () => {
    expect(eventTokens(completed()).total).toBe(7);
  });

  it('falls back to input + output when only those were reported', () => {
    expect(eventTokens(completed({ total_reported: false, total_tokens: undefined })).total).toBe(7);
  });

  it('returns null for a failed request that reported nothing', () => {
    const failed: HistoryEvent = { time: completed().time, kind: 'request', model: 'fake/fake', status: 'failed', duration_ms: 156 };
    expect(eventTokens(failed).total).toBeNull();
  });
});

describe('eventAmount', () => {
  const prices: Prices = { 'fake/fake': { input_per_million: '0.10', output_per_million: '0.40' } };

  it('prices reported tokens at the asking rate', () => {
    // 3 input @ $0.10/M + 4 output @ $0.40/M
    expect(eventAmount(completed(), prices)).toBeCloseTo((3 * 0.1 + 4 * 0.4) / 1e6, 12);
  });

  it('is zero for an unpriced model', () => {
    expect(eventAmount(completed({ model: 'ollama/other' }), prices)).toBe(0);
  });

  it('is zero when usage was never reported', () => {
    expect(eventAmount(completed({ usage_reported: false }), prices)).toBe(0);
  });

  it('ignores a negative or unparseable rate', () => {
    expect(eventAmount(completed(), { 'fake/fake': { input_per_million: '-1', output_per_million: 'free' } })).toBe(0);
  });
});

describe('estimateEarnings', () => {
  const prices: Prices = { 'fake/fake': { input_per_million: '0.10', output_per_million: '0.40' } };
  const events = [completed(), completed({ time: '2026-09-12T21:45:17.114537Z' })];

  it('sums only request events', () => {
    const withPause: HistoryEvent[] = [...events, { time: '2026-09-12T21:40:00Z', kind: 'pause', status: 'pause' }];
    expect(estimateEarnings(withPause, prices).countedRequests).toBe(2);
  });

  it('flags truncation when usage counts more requests than history retains', () => {
    const usage: UsageSummary = { requests: 140, successful: 139, failed: 1, input_tokens: 0, output_tokens: 0, total_tokens: 0, usage_reported: true, complete: true };
    const estimate = estimateEarnings(events, prices, usage);
    expect(estimate.truncated).toBe(true);
    expect(estimate.countedRequests).toBe(2);
    expect(estimate.reportedRequests).toBe(140);
  });

  it('is not truncated when history holds everything', () => {
    const usage: UsageSummary = { requests: 2, successful: 2, failed: 0, input_tokens: 6, output_tokens: 8, total_tokens: 14, usage_reported: true, complete: true };
    expect(estimateEarnings(events, prices, usage).truncated).toBe(false);
  });

  it('lists models that have no price instead of counting them as zero earned', () => {
    const estimate = estimateEarnings([...events, completed({ model: 'ollama/qwen' })], prices);
    expect(estimate.unpricedModels).toEqual(['ollama/qwen']);
    expect(estimate.anyPriced).toBe(true);
  });

  it('reports anyPriced false when no model has a price', () => {
    expect(estimateEarnings(events, {}).anyPriced).toBe(false);
  });

  it('honors a since cutoff', () => {
    const older = completed({ time: '2026-09-11T10:00:00Z' });
    const estimate = estimateEarnings([...events, older], prices, undefined, new Date('2026-09-12T00:00:00Z'));
    expect(estimate.countedRequests).toBe(2);
  });

  it('returns an empty estimate for empty history', () => {
    expect(estimateEarnings([], prices)).toMatchObject({ amount: 0, countedRequests: 0, anyPriced: false });
  });
});

describe('rollupByModel', () => {
  it('separates successes from failures and averages only reported durations', () => {
    const events = [
      completed(),
      completed({ status: 'failed', duration_ms: undefined, usage_reported: false }),
      completed({ model: 'ollama/qwen' }),
    ];
    const rows = rollupByModel(events, { 'fake/fake': { output_per_million: '0.40' } });
    const fake = rows.find(r => r.model === 'fake/fake')!;
    expect(fake).toMatchObject({ requests: 2, successful: 1, failed: 1, durationSamples: 1, priced: true });
    expect(rows.find(r => r.model === 'ollama/qwen')!.priced).toBe(false);
  });

  it('ignores non-request events', () => {
    expect(rollupByModel([{ time: '2026-09-12T21:40:00Z', kind: 'resume', status: 'sharing' }], {})).toEqual([]);
  });
});

describe('bucketByHour', () => {
  it('produces one bucket per hour, oldest first, with empty hours kept', () => {
    const now = new Date('2026-09-12T21:30:00Z');
    const buckets = bucketByHour([completed({ time: '2026-09-12T21:05:00Z' })], 4, now);
    expect(buckets).toHaveLength(4);
    expect(buckets[3].requests).toBe(1);
    expect(buckets[0].requests).toBe(0);
  });

  it('drops events older than the window', () => {
    const now = new Date('2026-09-12T21:30:00Z');
    const buckets = bucketByHour([completed({ time: '2026-09-10T21:05:00Z' })], 4, now);
    expect(buckets.reduce((n, b) => n + b.requests, 0)).toBe(0);
  });
});

describe('config validation', () => {
  it('accepts the live configuration', () => {
    expect(validateConfig(config())).toEqual({});
  });

  it('rejects a string concurrency, the bug that made every save fail', () => {
    expect(validateConcurrency('2')).toBeNull(); // numeric text is fine to type
    expect(validateConcurrency('two')).toMatch(/whole number/);
    expect(validateConcurrency(0)).toMatch(/between 1 and 64/);
    expect(validateConcurrency(65)).toMatch(/between 1 and 64/);
    expect(validateConcurrency(1.5)).toMatch(/whole number/);
  });

  it('sends concurrency as a number after normalizing', () => {
    const normalized = normalizeConfig({ ...config(), backends: [{ ...config().backends[0], concurrency: '4' as unknown as number }] });
    expect(normalized.backends[0].concurrency).toBe(4);
    expect(typeof normalized.backends[0].concurrency).toBe('number');
  });

  it('requires the coordinator path and allows ws only on loopback', () => {
    expect(validateCoordinatorURL('ws://127.0.0.1:8080/relay/v1/connect')).toBeNull();
    expect(validateCoordinatorURL('wss://relay.example.com/relay/v1/connect')).toBeNull();
    expect(validateCoordinatorURL('ws://relay.example.com/relay/v1/connect')).toMatch(/wss/);
    expect(validateCoordinatorURL('ws://127.0.0.1:8080/')).toMatch(/relay\/v1\/connect/);
    expect(validateCoordinatorURL('ws://user:pass@127.0.0.1:8080/relay/v1/connect')).toMatch(/credentials/);
    expect(validateCoordinatorURL('not a url')).toMatch(/WebSocket URL/);
  });

  it('requires a loopback root URL for runtimes', () => {
    expect(validateBackendURL('http://127.0.0.1:11434')).toBeNull();
    expect(validateBackendURL('http://127.0.0.1:11434/v1')).toMatch(/root URL/);
    expect(validateBackendURL('http://example.com:11434')).toMatch(/this machine/);
    expect(validateBackendURL('ftp://127.0.0.1')).toMatch(/http/);
  });

  it('rejects duplicate runtime ids', () => {
    const duplicated = config();
    duplicated.backends[1].id = 'fake';
    expect(validateConfig(duplicated)['backends.1.id']).toMatch(/already uses/);
  });

  it('rejects an invalid host id or token variable', () => {
    const errors = validateConfig(config({ host_id: 'bad host', token_env: '' }));
    expect(errors.host_id).toBeDefined();
    expect(errors.token_env).toBeDefined();
  });

  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.5.5.5')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('192.168.1.4')).toBe(false);
  });

  it('generates an unused id for a new endpoint', () => {
    expect(nextBackendId(config())).toBe('cliproxyapi-1');
    const taken = config();
    taken.backends.push({ ...taken.backends[2], id: 'cliproxyapi-1' });
    expect(nextBackendId(taken)).toBe('cliproxyapi-2');
  });
});

describe('validatePriceInput', () => {
  it('accepts empty, integers and decimals', () => {
    expect(validatePriceInput('')).toBeNull();
    expect(validatePriceInput('0')).toBeNull();
    expect(validatePriceInput('1.25')).toBeNull();
  });

  it('rejects text and negatives', () => {
    expect(validatePriceInput('free')).toMatch(/number/);
    expect(validatePriceInput('-1')).toMatch(/number/);
  });
});
