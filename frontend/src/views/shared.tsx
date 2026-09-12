import React from 'react';
import type { AgentConfig, Backend, HistoryEvent, Offers, Prices, Status, Usage } from '../api';

export const TABS = ['Overview', 'Runtimes', 'Models', 'Performance', 'Usage', 'Finance', 'Schedule', 'Settings'] as const;
export type Tab = typeof TABS[number];

/** Everything the dashboard polls, handed to every view. */
export type Data = {
  status: Status;
  backends: Backend[];
  offers: Offers;
  usage: Usage;
  events: HistoryEvent[];
  prices: Prices;
  config: AgentConfig | null;
  refreshedAt: number;
};

export type ViewProps = { data: Data; goTo: (tab: Tab) => void; refresh: () => Promise<void>; setError: (message: string) => void };

export function PageHead({ title, note }: { title: string; note: React.ReactNode }) {
  return <div className="page-head"><h1>{title}</h1><span className="note">{note}</span></div>;
}

export function Kpi({ label, value, delta, sub }: { label: string; value: React.ReactNode; delta?: number | null; sub?: React.ReactNode }) {
  return <div className="kpi">
    <div className="label">{label}</div>
    <div className="value">{value}</div>
    <div className="sub">{delta !== undefined && <Delta value={delta} />}<span>{sub}</span></div>
  </div>;
}

/** Signed percentage change. A null value means there is no baseline, which renders as a dash rather than a fake zero. */
export function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="delta flat">—</span>;
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
  const text = value > 0 ? `+${value.toFixed(1)}%` : value < 0 ? `−${Math.abs(value).toFixed(1)}%` : '±0.0%';
  return <span className={`delta ${direction}`}>{text}</span>;
}

export function Bar({ fraction, tickFraction }: { fraction: number; tickFraction?: number }) {
  return <div className="track">
    <div className="bar" style={{ width: `${Math.max(0, Math.min(100, fraction * 100)).toFixed(1)}%` }} />
    {tickFraction !== undefined && <div className="tick" style={{ left: `${Math.max(0, Math.min(100, tickFraction * 100)).toFixed(1)}%` }} />}
  </div>;
}

export function modelDescription(backend: Backend, model: { digest?: string }) {
  if (backend.source === 'local') return model.digest ? `Ollama local model · ${model.digest.slice(0, 17)}` : 'Ollama local model';
  return 'CLIProxyAPI provider model';
}
