import React, { useMemo } from 'react';
import { completed, formatMs, perModel, percentile, requestEvents, throughputOf } from '../stats';
import { Bar, Kpi, PageHead, ViewProps } from './shared';

export function Performance({ data }: ViewProps) {
  const events = useMemo(() => requestEvents(data.events), [data.events]);
  const done = completed(events);
  const durations = done.map(e => e.duration_ms || 0).filter(d => d > 0);
  const throughputs = events.map(throughputOf).filter((v): v is number => v !== null);
  const models = useMemo(() => perModel(events, data.prices), [events, data.prices]);
  const failed = events.length - done.length;
  const okRate = events.length ? (done.length / events.length) * 100 : null;

  const tps = percentile(throughputs, 50);
  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const byThroughput = models.filter(m => m.throughputP50 !== null).sort((a, b) => b.throughputP50! - a.throughputP50!);
  const byDuration = models.filter(m => m.durationP50 !== null).sort((a, b) => a.durationP50! - b.durationP50!);
  const maxTps = Math.max(...byThroughput.map(m => m.throughputP50!), 0);
  const maxDuration = Math.max(...byDuration.map(m => m.durationP95 ?? m.durationP50!), 0);

  return <>
    <PageHead title="Performance" note={`completed requests from the last ${events.length} recorded · time to first token is not measured`} />
    <div className="kpis">
      <Kpi label="tokens / s · p50" value={tps === null ? '—' : tps.toFixed(1)} sub="output, all models" />
      <Kpi label="request duration" value={p50 === null ? '—' : formatMs(p50)} sub={p95 === null ? 'p50, end to end' : `p95 ${formatMs(p95)}`} />
      <Kpi label="requests" value={events.length} sub={okRate === null ? 'none recorded' : `${okRate.toFixed(1)}% ok`} />
      <Kpi label="error rate" value={events.length ? ((failed / events.length) * 100).toFixed(1) + '%' : '—'} sub={`${failed} of ${events.length} failed`} />
    </div>
    <div className="two-up">
      <section>
        <div className="section-head"><h2>Throughput by model</h2><span className="note">output tok/s · p50</span></div>
        {byThroughput.length === 0 && <div className="empty">Appears after a completed request reports output tokens.</div>}
        {byThroughput.map(m => <div className="bar-row" key={m.model}>
          <span className="name" title={m.model}>{shortName(m.model)}</span>
          <Bar fraction={maxTps ? m.throughputP50! / maxTps : 0} />
          <span className="value">{m.throughputP50!.toFixed(1)}</span>
        </div>)}
      </section>
      <section>
        <div className="section-head"><h2>Request duration</h2><span className="note">p50 bar, p95 tick</span></div>
        {byDuration.length === 0 && <div className="empty">Appears after the first completed request.</div>}
        {byDuration.map(m => <div className="bar-row wide-value" key={m.model}>
          <span className="name" title={m.model}>{shortName(m.model)}</span>
          <Bar fraction={maxDuration ? m.durationP50! / maxDuration : 0} tickFraction={m.durationP95 !== null && maxDuration ? m.durationP95 / maxDuration : undefined} />
          <span className="value">{formatMs(m.durationP50!)} <span>{m.durationP95 === null ? '' : formatMs(m.durationP95)}</span></span>
        </div>)}
      </section>
    </div>
  </>;
}

/** History keys models as backend/model; the model half is what people recognise. */
export function shortName(modelId: string) {
  const slash = modelId.indexOf('/');
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}
