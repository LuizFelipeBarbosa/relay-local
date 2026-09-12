import React, { useEffect, useMemo, useState } from 'react';
import { Prices, api, backendTitle, errorMessage, kindName } from '../api';
import { eventsSince, formatCompact, isPriced, percentChange, requestEvents, startOfDay, sumRevenue, tokensOf, usd } from '../stats';
import { Kpi, PageHead, ViewProps } from './shared';

export function Finance({ data, refresh, setError }: ViewProps) {
  const { backends, config, offers } = data;
  const [draft, setDraft] = useState<Prices>(data.prices);
  const [savedModel, setSavedModel] = useState('');
  // Adopt server prices for any model the user has not started editing.
  useEffect(() => { setDraft(current => ({ ...data.prices, ...current })); }, [data.prices]);

  const events = useMemo(() => requestEvents(data.events), [data.events]);
  const now = new Date();
  const todayEvents = eventsSince(events, startOfDay(now));
  const revenueToday = sumRevenue(todayEvents, data.prices);
  const revenueYesterday = sumRevenue(eventsSince(events, startOfDay(now, 1), startOfDay(now)), data.prices);
  const revenueMonth = sumRevenue(eventsSince(events, new Date(now.getFullYear(), now.getMonth(), 1)), data.prices);
  const pricedTokens = todayEvents.filter(e => e.model && isPriced(data.prices, e.model)).reduce((n, e) => n + tokensOf(e), 0);
  const blended = pricedTokens > 0 ? (revenueToday / pricedTokens) * 1e6 : null;

  const models = backends.flatMap(b => b.models.map(m => ({ ...m, backend: b })));
  const unpriced = models.filter(m => !isPriced(data.prices, m.id));
  const unpricedOffered = unpriced.filter(m => offers[m.backend.id]?.[m.name]);
  const unpricedTokens = todayEvents.filter(e => unpriced.some(m => m.id === e.model)).reduce((n, e) => n + tokensOf(e), 0);
  const revenueByModel = (id: string) => sumRevenue(todayEvents.filter(e => e.model === id), data.prices);

  const save = async (model: string) => {
    const price = draft[model] || {};
    try {
      await api('/prices', { method: 'POST', body: JSON.stringify({ model, input_per_million: price.input_per_million || '', output_per_million: price.output_per_million || '' }) });
      setSavedModel(model);
      setTimeout(() => setSavedModel(current => current === model ? '' : current), 1800);
      await refresh();
    } catch (e) { setError(errorMessage(e, 'Could not save price')); }
  };
  const edit = (model: string, field: 'input_per_million' | 'output_per_million', value: string) => setDraft({ ...draft, [model]: { ...(draft[model] || {}), [field]: value } });

  return <>
    <PageHead title="Finance" note="rates stored locally · estimates need reported token usage" />
    <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
      <Kpi label="today" value={usd(revenueToday)} delta={percentChange(revenueToday, revenueYesterday)} sub="vs yesterday" />
      <Kpi label="month to date" value={usd(revenueMonth)} sub="from recorded requests" />
      <Kpi label="blended rate" value={blended === null ? '—' : usd(blended)} sub="per 1M priced tokens today" />
      <Kpi label="unpriced volume" value={formatCompact(unpricedTokens)} sub={`tokens on ${unpricedOffered.length} offered ${unpricedOffered.length === 1 ? 'model' : 'models'}`} />
    </div>
    <section>
      <div className="section-head">
        <h2>Asking prices <span className="sub">USD per 1M tokens</span></h2>
        <span className="note" style={{ color: unpriced.length ? 'var(--accent-ink)' : undefined }}>{unpriced.length} unpriced</span>
      </div>
      {models.length === 0 && <div className="empty">No models discovered yet. Connect a runtime before setting prices.</div>}
      {models.length > 0 && <div className="scroll"><div className="book">
        <div className="table head"><span>model</span><span>input</span><span>output</span><span className="right">est. today</span><span /></div>
        {models.map(m => {
          const price = draft[m.id] || {};
          const priced = isPriced(data.prices, m.id);
          return <div className="table" key={m.id}>
            <div className="model">
              <span className={priced ? 'flag' : 'flag unpriced'} />
              <div style={{ minWidth: 0 }}><div className="model-name">{m.name}</div><div className="model-provider">{providerLine(m.backend, config)}</div></div>
            </div>
            <div className="money"><span>$</span><input aria-label={`${m.name} input price`} placeholder="0.00" value={price.input_per_million || ''} onChange={e => edit(m.id, 'input_per_million', e.target.value)} onKeyDown={e => e.key === 'Enter' && save(m.id)} /></div>
            <div className="money"><span>$</span><input aria-label={`${m.name} output price`} placeholder="0.00" value={price.output_per_million || ''} onChange={e => edit(m.id, 'output_per_million', e.target.value)} onKeyDown={e => e.key === 'Enter' && save(m.id)} /></div>
            <span className="revenue">{priced ? usd(revenueByModel(m.id)) : '—'}</span>
            <button className="btn outline" onClick={() => save(m.id)}>{savedModel === m.id ? 'Saved' : 'Save'}</button>
          </div>;
        })}
      </div></div>}
      <div className="footnote"><i />Unpriced: tokens are served and counted, but earn nothing until both rates are set.</div>
    </section>
  </>;
}

/** "Ollama" when the runtime has no label of its own, "Ollama · Studio box" when it does. */
function providerLine(backend: { id: string; kind: string }, config: ViewProps['data']['config']) {
  const product = kindName(backend.kind);
  const title = backendTitle(backend, config);
  return title === product ? product : `${product} · ${title}`;
}
