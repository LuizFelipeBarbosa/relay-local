import React, { useMemo } from 'react';
import { backendRole, backendTitle } from '../api';
import { formatMs, percentile, requestEvents, throughputOf } from '../stats';
import { PageHead, ViewProps } from './shared';

export function Runtimes({ data }: ViewProps) {
  const { backends, config } = data;
  const events = useMemo(() => requestEvents(data.events), [data.events]);
  const checkedAgo = Math.max(0, Math.round((Date.now() - data.refreshedAt) / 1000));

  return <>
    <PageHead title="Runtimes" note={`${backends.length} ${backends.length === 1 ? 'endpoint' : 'endpoints'} on this machine · checked every 2 s`} />
    {backends.length === 0 && <div className="empty">No local services configured. Add Ollama or CLIProxyAPI from Settings.</div>}
    {backends.map(b => {
      const own = events.filter(e => e.model?.startsWith(b.id + '/'));
      const p50 = percentile(own.filter(e => e.status === 'completed').map(e => e.duration_ms || 0).filter(d => d > 0), 50);
      const tps = percentile(own.map(throughputOf).filter((v): v is number => v !== null), 50);
      const url = config?.backends.find(c => c.id === b.id)?.url || '—';
      return <section className="runtime-card" key={b.id}>
        <div>
          <h2>{backendTitle(b, config)}</h2>
          <div className="role">{backendRole(b.kind)}</div>
          <div className={b.ready ? 'status ready' : 'status'}>{b.ready ? '● ready' : '○ offline'} · checked {checkedAgo} s ago</div>
        </div>
        <div className="facts">
          <div className="wide"><div className="label">endpoint</div><div className="endpoint">{url}</div></div>
          <div><div className="label">models</div><div className="big">{b.models.length}</div></div>
          <div><div className="label">slots</div><div className="big">{b.capacity - b.available}<span>/{b.capacity}</span></div></div>
          <div><div className="label">p50 latency</div><div className="big">{p50 === null ? '—' : formatMs(p50)}</div></div>
          <div><div className="label">tokens / s</div><div className="big">{tps === null ? '—' : tps.toFixed(1)}</div></div>
        </div>
      </section>;
    })}
  </>;
}
