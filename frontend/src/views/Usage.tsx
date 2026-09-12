import React, { useMemo } from 'react';
import type { UsageSummary } from '../api';
import { formatNumber, pad, requestEvents, tokensPerDay } from '../stats';
import { Kpi, PageHead, ViewProps } from './shared';

const DAYS_SHOWN = 14;

export function Usage({ data }: ViewProps) {
  const { today, lifetime } = data.usage;
  const live = data.usage.live;
  const days = useMemo(() => tokensPerDay(requestEvents(data.events), DAYS_SHOWN), [data.events, data.refreshedAt]);
  const max = Math.max(...days.map(d => d.input + d.output), 0);
  const tokens = (s: UsageSummary) => s.usage_reported ? formatNumber(s.total_tokens) : '—';

  return <>
    <PageHead title="Usage" note="refreshes every 2 seconds · in-flight output is estimated until final usage arrives" />
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <Kpi label="today" value={tokens(today)} sub={`${today.requests} requests${today.complete ? '' : ' · usage missing on some'}`} />
      <Kpi label="lifetime" value={tokens(lifetime)} sub={`${formatNumber(lifetime.requests)} requests`} />
      <Kpi label="input · lifetime" value={lifetime.usage_reported ? formatNumber(lifetime.input_tokens) : '—'} sub="prompt tokens" />
      <Kpi label="output · lifetime" value={lifetime.usage_reported ? formatNumber(lifetime.output_tokens) : '—'} sub="completion tokens" />
      <Kpi label="live · in flight" value={formatNumber(live?.requests || 0)} sub={`${formatNumber(live?.output_tokens_estimate || 0)} estimated output tokens`} />
    </div>
    <section>
      <div className="section-head">
        <h2>Tokens per day <span className="sub">last {DAYS_SHOWN} days · from the last {data.events.length} recorded events</span></h2>
        <div className="legend"><span><i className="box ink" />input</span><span><i className="box accent" />output</span></div>
      </div>
      <div className="days">
        {days.map(d => <div className="day" key={d.date.getTime()} title={`${formatNumber(d.input)} in · ${formatNumber(d.output)} out`}>
          <div className="in" style={{ height: `${max ? (d.input / max) * 100 : 0}%` }} />
          <div className="out" style={{ height: `${max ? (d.output / max) * 100 : 0}%` }} />
        </div>)}
      </div>
      <div className="day-labels">{days.map(d => <span key={d.date.getTime()}>{pad(d.date.getDate())}</span>)}</div>
      {max === 0 && <div className="empty">No token usage recorded in this window yet.</div>}
    </section>
  </>;
}
