// Pure display formatters. No React, no DOM.

const counts = new Intl.NumberFormat('en-US');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
// Estimates at per-million-token prices are routinely fractions of a cent; rounding
// them to $0.00 would read as "earned nothing", so small amounts keep their digits.
const preciseMoney = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 8 });

export function formatCount(value: number): string {
  return counts.format(value);
}

/** Token counts: exact below 10k, abbreviated above so columns stay narrow. */
export function formatTokens(value: number): string {
  if (value < 10_000) return counts.format(value);
  if (value < 1_000_000) return (value / 1000).toFixed(value < 100_000 ? 1 : 0) + 'k';
  return (value / 1_000_000).toFixed(1) + 'M';
}

/** Amounts are estimates; keep sub-cent figures legible instead of rounding them to $0.00. */
export function formatMoney(value: number): string {
  if (value === 0) return money.format(0);
  if (Math.abs(value) < 0.01) return preciseMoney.format(value);
  return money.format(value);
}

export function formatDuration(ms: number | undefined): string | null {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/** Longer spans, for uptime and "sharing since". */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
}

export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const seconds = Math.max(0, (now.getTime() - then) / 1000);
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
  const gb = bytes / 1_073_741_824;
  if (gb >= 1) return `${gb.toFixed(gb < 100 ? 1 : 0)} GB`;
  return `${Math.round(bytes / 1_048_576)} MB`;
}

export function formatPercent(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** Digests are long; show enough to compare without wrapping the row. */
export function shortDigest(digest: string | undefined, length = 12): string | null {
  if (!digest) return null;
  return digest.length <= length ? digest : digest.slice(0, length);
}

/** "ollama/gemma4:e2b" → { backend: "ollama", name: "gemma4:e2b" } */
export function splitModelId(id: string): { backend: string; name: string } {
  const cut = id.indexOf('/');
  if (cut < 0) return { backend: '', name: id };
  return { backend: id.slice(0, cut), name: id.slice(cut + 1) };
}
