import React, { useMemo, useState } from 'react';
import type { UsageSummary } from '../api';
import { RANGE_LABELS, RANGES, Range, formatNumber, perModel, requestEvents, series } from '../stats';
import { Kpi, PageHead, ViewProps } from './shared';
import { TokenBuckets } from './TokenBuckets';

export function Usage({ data }: ViewProps) {
  const [range, setRange] = useState<Range>('24h');
  const { today, lifetime } = data.usage;
  const live = data.usage.live;
  const events = useMemo(() => requestEvents(data.events), [data.events]);
  const chart = useMemo(() => series(events, data.prices, range), [events, data.prices, range, data.refreshedAt]);
  const models = useMemo(() => perModel(events, data.prices).sort((a, b) => b.tokens - a.tokens), [events, data.prices]);
  const tokens = (s: UsageSummary) => s.usage_reported ? formatNumber(s.total_tokens) : '—';

  return <>
    <div className="usage-header">
      <div className="usage-header-top"><h1>Usage</h1><span className="note">refreshes every 2 seconds · in-flight output is estimated until final usage arrives</span></div>
      <div className="usage-live-label"><i className="live-dot" />live output tokens</div>
      <div className="usage-live-value">{formatNumber(live?.output_tokens_estimate || 0)}</div>
      <div className="usage-live-sub">estimated tokens currently being generated · {formatNumber(live?.requests || 0)} active {live?.requests === 1 ? 'request' : 'requests'}</div>
    </div>
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <Kpi label="today" value={tokens(today)} sub={`${today.requests} requests${today.complete ? '' : ' · usage missing on some'}`} />
      <Kpi label="lifetime" value={tokens(lifetime)} sub={`${formatNumber(lifetime.requests)} requests`} />
      <Kpi label="input · lifetime" value={lifetime.usage_reported ? formatNumber(lifetime.input_tokens) : '—'} sub="prompt tokens" />
      <Kpi label="output · lifetime" value={lifetime.usage_reported ? formatNumber(lifetime.output_tokens) : '—'} sub="completion tokens" />
    </div>
    <section>
      <div className="section-head">
        <h2>Token timeline</h2>
        <div className="ranges">{RANGES.map(r => <button key={r} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>{RANGE_LABELS[r]}</button>)}</div>
      </div>
      <TokenBuckets chart={chart} live={live} />
    </section>
    <section>
      <div className="section-head">
        <h2>Usage by model</h2>
        <span className="note">recorded requests · input and output tokens</span>
      </div>
      {models.length === 0 ? <div className="empty">No model usage recorded yet.</div> : <div className="scroll">
        <div className="usage-model-table">
          <div className="usage-model-row head"><span>model</span><span className="right">requests</span><span className="right">input</span><span className="right">output</span><span className="right">total</span></div>
          {models.map(model => <div className="usage-model-row" key={model.model}>
            <span className="model">{model.model}</span>
            <span className="right">{formatNumber(model.requests)}</span>
            <span className="right">{formatNumber(model.inputTokens)}</span>
            <span className="right">{formatNumber(model.outputTokens)}</span>
            <span className="right">{formatNumber(model.tokens)}</span>
          </div>)}
        </div>
      </div>}
    </section>
  </>;
}
