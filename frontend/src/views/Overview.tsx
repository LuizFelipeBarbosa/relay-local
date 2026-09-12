import React, { useMemo, useState } from 'react';
import { backendTitle } from '../api';
import { RANGES, Range, eventsSince, formatCompact, isPriced, linePath, percentChange, requestEvents, series, startOfDay, sumRevenue, tokensOf, usd } from '../stats';
import { Delta, ViewProps } from './shared';

export function Overview({ data, goTo }: ViewProps) {
  const [range, setRange] = useState<Range>('24h');
  const { backends, config, prices, usage } = data;
  const events = useMemo(() => requestEvents(data.events), [data.events]);

  const now = new Date();
  const todayEvents = eventsSince(events, startOfDay(now));
  const revenueToday = sumRevenue(todayEvents, prices);
  const revenueYesterday = sumRevenue(eventsSince(events, startOfDay(now, 1), startOfDay(now)), prices);
  const revenueMonth = sumRevenue(eventsSince(events, new Date(now.getFullYear(), now.getMonth(), 1)), prices);
  const chart = useMemo(() => series(events, prices, range, now), [events, prices, range, data.refreshedAt]);

  const unpriced = backends.flatMap(b => b.models.filter(m => data.offers[b.id]?.[m.name] && !isPriced(prices, m.id)));
  const unpricedTokens = todayEvents.filter(e => unpriced.some(m => m.id === e.model)).reduce((n, e) => n + tokensOf(e), 0);

  return <>
    <div className="hero">
      <div className="label">Estimated revenue today</div>
      <div className="value">{usd(revenueToday)}</div>
      <div className="facts">
        <span><Delta value={percentChange(revenueToday, revenueYesterday)} /> vs yesterday</span>
        <span>{usd(revenueMonth)} month to date</span>
        <span>{usage.today.requests} requests · {usage.today.usage_reported ? formatCompact(usage.today.total_tokens) : '0'} tokens</span>
      </div>
    </div>

    <div className="overview-grid">
      <section>
        <div className="section-head">
          <h2>Revenue and throughput</h2>
          <div className="legend"><span><i className="line" />USD / h</span><span><i className="dash" />tokens / s</span>{(usage.live?.requests || 0) > 0 && <span><i className="live-dot" />live output</span>}</div>
          <div className="ranges">{RANGES.map(r => <button key={r} className={r === range ? 'active' : ''} onClick={() => setRange(r)}>{r}</button>)}</div>
        </div>
        <Chart chart={chart} live={usage.live} />
      </section>

      <section>
        <div className="section-head"><h2>Runtimes</h2><a href="#" onClick={e => { e.preventDefault(); goTo('Runtimes'); }}>Manage</a></div>
        {backends.length === 0 && <div className="empty">No runtimes configured. Add Ollama or CLIProxyAPI in Settings.</div>}
        {backends.map(b => <div className="runtime-row" key={b.id}>
          <div className="title">{backendTitle(b, config)} <span>{b.models.length} models</span></div>
          <div className="slots">{b.capacity - b.available}/{b.capacity} <span className="muted">busy</span></div>
        </div>)}
        <Attention unpriced={unpriced.map(m => m.name)} tokens={unpricedTokens} anyReady={backends.some(b => b.ready)} hasBackends={backends.length > 0} goTo={goTo} />
      </section>
    </div>
  </>;
}

function Chart({ chart, live }: { chart: ReturnType<typeof series>; live?: { requests: number; bytes: number; output_tokens_estimate: number } }) {
  const maxRevenue = Math.max(...chart.revenue, 0) * 1.1;
  const maxThroughput = Math.max(...chart.throughput, 0) * 1.1;
  const last = chart.revenue.length - 1;
  const lastY = 210 - (maxRevenue > 0 ? chart.revenue[last] / maxRevenue : 0) * 200;
  const decimals = maxRevenue === 0 ? 2 : maxRevenue < 0.1 ? 3 : maxRevenue < 2 ? 2 : 0;
  const axis = (v: number) => '$' + v.toFixed(decimals);
  const liveRequests = live?.requests || 0;
  const liveTokens = live?.output_tokens_estimate || 0;
  return <div className="chart">
    <svg viewBox="0 0 720 220" preserveAspectRatio="none">
      <g stroke="#d0d8d3" strokeWidth="1"><line x1="0" y1="10" x2="720" y2="10" /><line x1="0" y1="110" x2="720" y2="110" /></g>
      <line x1="0" y1="210" x2="720" y2="210" stroke="#14231f" strokeWidth="1" />
      <path d={linePath(chart.throughput, maxThroughput, 720, 10, 210)} fill="none" stroke="#14231f" strokeWidth="1.25" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <path d={linePath(chart.revenue, maxRevenue, 720, 10, 210)} fill="none" stroke="#b8432c" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {chart.hasData && <circle cx="720" cy={lastY.toFixed(1)} r="3.5" fill="#b8432c" />}
    </svg>
    <div className="y"><span>{axis(maxRevenue)}</span><span>{axis(maxRevenue / 2)}</span><span>0</span></div>
    <div className="x"><span>{chart.start}</span><span>{chart.mid}</span><span>now</span></div>
    {liveRequests > 0 && <div className="chart-live" role="status">
      <span className="chart-live-label"><i className="live-dot" />live output</span>
      <div className="chart-live-track"><span style={{ width: `${Math.min(100, Math.max(8, liveTokens / 1000))}%` }} /></div>
      <span className="chart-live-value">{formatCompact(liveTokens)} tokens · {liveRequests} {liveRequests === 1 ? 'request' : 'requests'}</span>
    </div>}
    {!chart.hasData && <div className="placeholder">Revenue and throughput appear after the first completed request with reported usage.</div>}
  </div>;
}

function Attention({ unpriced, tokens, anyReady, hasBackends, goTo }: { unpriced: string[]; tokens: number; anyReady: boolean; hasBackends: boolean; goTo: ViewProps['goTo'] }) {
  if (hasBackends && !anyReady) {
    return <div className="attention">
      <div className="label">Needs attention</div>
      <div className="title">No runtime is ready</div>
      <div className="body">Requests cannot be served until Ollama or CLIProxyAPI answers on its loopback endpoint.</div>
      <a href="#" onClick={e => { e.preventDefault(); goTo('Runtimes'); }}>Check runtimes →</a>
    </div>;
  }
  if (unpriced.length > 0) {
    const names = unpriced.length <= 3 ? joinNames(unpriced) : `${joinNames(unpriced.slice(0, 2))} and ${unpriced.length - 2} more`;
    return <div className="attention">
      <div className="label">Needs attention</div>
      <div className="title">{unpriced.length} offered {unpriced.length === 1 ? 'model has' : 'models have'} no price</div>
      <div className="body">{names} served {formatCompact(tokens)} tokens today and earned nothing.</div>
      <a href="#" onClick={e => { e.preventDefault(); goTo('Finance'); }}>Set prices in Finance →</a>
    </div>;
  }
  return <div className="attention calm">
    <div className="label">All clear</div>
    <div className="title">{hasBackends ? 'Every offered model has a price' : 'Connect a runtime to start'}</div>
    <div className="body">{hasBackends ? 'Revenue estimates use the asking rates in Finance.' : 'Ollama and CLIProxyAPI endpoints are added from Settings.'}</div>
    <a href="#" onClick={e => { e.preventDefault(); goTo(hasBackends ? 'Models' : 'Settings'); }}>{hasBackends ? 'Review offers →' : 'Open settings →'}</a>
  </div>;
}

function joinNames(names: string[]) {
  if (names.length <= 1) return names.join('');
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}
