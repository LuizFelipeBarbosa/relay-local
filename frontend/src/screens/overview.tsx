// Overview: sharing state, the topology, host facts, runtimes, models, activity, earnings.
import React, { useMemo } from 'react';
import { SharingControls } from '../app';
import { RelayDiagram, RuntimeGlyph, EmptyActivity } from '../art/art';
import { Button, Caption, Meter, NotReported, Section, StatusDot, TableScroll } from '../components/ui';
import {
  estimateEarnings, hostSummary, runtimeViews, sessionSeconds, usageView, type SharingSummary,
} from '../derive';
import {
  formatBytes, formatCount, formatDuration, formatElapsed, formatMoney,
  formatPercent, formatTime, formatTokens,
} from '../format';
import type {
  AgentConfig, HistoryResponse, Metrics, ModelsResponse, Prices, Status, UsageResponse,
} from '../types';
import { useNewRows } from '../useNewRows';
import './overview.css';

export function Overview({
  status, sharing, usage, history, models, config, prices, metrics, availability, onNavigate,
}: {
  status: Status | null;
  sharing: SharingSummary | null;
  usage: UsageResponse | null;
  history: HistoryResponse | null;
  models: ModelsResponse | null;
  config: AgentConfig | null;
  prices: Prices | null;
  metrics: Metrics | null;
  availability: Parameters<typeof SharingControls>[0]['action'];
  onNavigate: (route: string) => void;
}) {
  const runtimes = useMemo(
    () => models ? runtimeViews(models.backends, models.offers, config) : [],
    [models, config],
  );
  const events = history?.events ?? [];
  const requests = useMemo(() => events.filter(e => e.kind === 'request'), [events]);
  const today = usage ? usageView(usage.today) : null;
  const earnings = useMemo(
    () => estimateEarnings(events, prices ?? {}, usage?.today),
    [events, prices, usage],
  );
  // Requests in the last hour drive how fast the topology animates.
  const recentRequests = useMemo(() => {
    const hourAgo = Date.now() - 3_600_000;
    return requests.filter(event => new Date(event.time).getTime() >= hourAgo).length;
  }, [requests]);
  const isNew = useNewRows(requests.slice(0, 6).map(event => event.time));
  const host = metrics ? hostSummary(metrics) : null;
  const session = status ? sessionSeconds(status) : null;

  const coordinatorHost = useMemo(() => {
    if (!config) return '—';
    try { return new URL(config.coordinator_url).host; } catch { return config.coordinator_url; }
  }, [config]);

  if (!status || !sharing) {
    return <p className="ov-loading">Reading the agent on this machine…</p>;
  }

  const offeredCount = runtimes.reduce((n, r) => n + r.offered, 0);
  const installedCount = runtimes.reduce((n, r) => n + r.installed, 0);
  const unreachable = runtimes.filter(r => !r.ready);

  return (
    <div className="ov-page app-reveal" key="overview">
      <div className="ov-lede">
        <div className="ov-lede-text">
          <p className="ov-state">
            <StatusDot tone={sharing.state === 'live' ? 'live' : sharing.state === 'starting' ? 'warn' : 'idle'} />
            {sharing.label}
          </p>
          <h1 className="ov-headline">
            {sharing.state === 'live' ? 'Taking requests' : sharing.state === 'paused' ? 'Not taking requests' : 'Agent is not running'}
          </h1>
          <p className="ov-sub">
            {sharing.state === 'live' && session !== null
              ? <>Running for {formatElapsed(session)}. {offeredCount === 0
                  ? 'No model is offered yet, so nothing can be answered.'
                  : `${offeredCount} of ${installedCount} installed models offered.`}</>
              : sharing.detail.replace('${token_env}', config?.token_env ?? 'the host token variable')}
          </p>
        </div>
        <SharingControls sharingState={sharing.state} action={availability} />
      </div>

      <Section title="Topology" note="Everything left of the boundary runs on this machine.">
        <TableScroll label="Relay topology diagram">
          <RelayDiagram
            nodes={runtimes.map(r => ({ id: r.id, label: r.label, kind: r.kind, ready: r.ready, models: r.installed }))}
            sharing={sharing.state}
            hostId={status.host_id}
            coordinatorHost={coordinatorHost}
            recentRequests={recentRequests}
          />
        </TableScroll>
      </Section>

      <Section
        title="Runtimes"
        note={`${runtimes.length} configured, ${runtimes.filter(r => r.ready).length} answering.`}
        aside={<Button variant="quiet" onClick={() => onNavigate('Settings')}>Edit connections</Button>}
      >
        <TableScroll label="Runtimes">
          <table className="ov-table">
            <thead>
              <tr>
                <th>Runtime</th><th className="ov-address">Address</th><th>State</th>
                <th className="ov-right">At once</th><th className="ov-right">Installed</th><th className="ov-right">Offered</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.map(runtime => (
                <tr key={runtime.id}>
                  <td>
                    <span className="ov-runtime">
                      <span className="ov-glyph"><RuntimeGlyph kind={runtime.kind} /></span>
                      <span>
                        <span className="ov-runtime-name">{runtime.label}</span>
                        <span className="ov-runtime-id mono">{runtime.id}</span>
                        {runtime.url && <span className="ov-runtime-url mono">{runtime.url}</span>}
                      </span>
                    </span>
                  </td>
                  <td className="mono ov-dim ov-address">{runtime.url ?? '—'}</td>
                  <td>
                    <span className="ov-status">
                      <StatusDot tone={runtime.ready ? 'ok' : 'down'} />
                      {runtime.ready ? 'Ready' : 'Not reachable'}
                    </span>
                  </td>
                  <td className="ov-right num">{runtime.concurrency}</td>
                  <td className="ov-right num">{runtime.ready ? runtime.installed : '—'}</td>
                  <td className="ov-right num">{runtime.offered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <Caption>
          “At once” is the concurrency you configured, not live usage — the agent does not report how many
          requests are running right now.
          {unreachable.length > 0 && ` ${unreachable.map(r => r.label).join(' and ')} did not answer the last check, so its models cannot be listed.`}
        </Caption>
      </Section>

      <Section
        title="Offered models"
        note="Only models on the allowlist reach the coordinator."
        aside={<Button variant="quiet" onClick={() => onNavigate('Models')}>Change what you offer</Button>}
      >
        {installedCount === 0 ? (
          <p className="ov-empty-text">No runtime reported an installed model. Install one from the Models page.</p>
        ) : (
          <TableScroll label="Offered models">
            <table className="ov-table">
              <thead>
                <tr>
                  <th>Model</th><th>Runtime</th>
                  <th className="ov-right">Input / 1M</th><th className="ov-right">Output / 1M</th><th className="ov-right">Requests</th>
                </tr>
              </thead>
              <tbody>
                {runtimes.flatMap(runtime => runtime.models
                  .filter(model => models?.offers[runtime.id]?.[model.name])
                  .map(model => {
                    const price = prices?.[model.id];
                    const count = requests.filter(event => event.model === model.id).length;
                    return (
                      <tr key={model.id}>
                        <td className="mono">{model.name}</td>
                        <td className="ov-dim">{runtime.label}</td>
                        <td className="ov-right num">{price?.input_per_million ? `$${price.input_per_million}` : <NotReported>not set</NotReported>}</td>
                        <td className="ov-right num">{price?.output_per_million ? `$${price.output_per_million}` : <NotReported>not set</NotReported>}</td>
                        <td className="ov-right num">{count}</td>
                      </tr>
                    );
                  }))}
                {offeredCount === 0 && (
                  <tr><td colSpan={5} className="ov-dim">Nothing is offered. {installedCount} model{installedCount === 1 ? ' is' : 's are'} installed and private.</td></tr>
                )}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section
        title="Recent activity"
        note={`${requests.length} request${requests.length === 1 ? '' : 's'} in the agent's log.`}
        aside={<Button variant="quiet" onClick={() => onNavigate('Activity')}>Full activity</Button>}
      >
        {requests.length === 0 ? (
          <div className="ov-empty"><EmptyActivity /><p>Requests will appear here as buyers use your models.</p></div>
        ) : (
          <TableScroll label="Recent requests">
            <table className="ov-table">
              <thead>
                <tr>
                  <th>Time</th><th>Model</th><th>Outcome</th>
                  <th className="ov-right">Duration</th><th className="ov-right">In</th><th className="ov-right">Out</th>
                </tr>
              </thead>
              <tbody>
                {requests.slice(0, 6).map((event, i) => {
                  const duration = formatDuration(event.duration_ms);
                  return (
                    <tr key={`${event.time}-${i}`} className={isNew(event.time) ? 'ui-enter' : undefined}>
                      <td className="mono ov-dim">{formatTime(event.time)}</td>
                      <td className="mono">{event.model}</td>
                      <td className={event.status === 'completed' ? '' : 'ov-failed'}>
                        {event.status === 'completed' ? 'Completed' : 'Failed'}
                      </td>
                      <td className="ov-right num">{duration ?? <NotReported>—</NotReported>}</td>
                      <td className="ov-right num">{event.usage_reported ? formatCount(event.input_tokens ?? 0) : <NotReported>—</NotReported>}</td>
                      <td className="ov-right num">{event.usage_reported ? formatCount(event.output_tokens ?? 0) : <NotReported>—</NotReported>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Section>

      <Section title="Today" note="Counted by the agent since local midnight.">
        <div className="ov-split">
          <table className="ov-facts">
            <tbody>
              <tr><th>Requests</th><td className="num">{today ? formatCount(today.requests) : '—'}</td></tr>
              <tr><th>Completed</th><td className="num">{today ? formatCount(today.successful) : '—'}</td></tr>
              <tr><th>Failed</th><td className="num">{today ? formatCount(today.failed) : '—'}</td></tr>
              <tr>
                <th>Tokens</th>
                <td className="num">{today?.displayTotal !== null && today ? formatTokens(today.displayTotal!) : <NotReported />}</td>
              </tr>
            </tbody>
          </table>
          <div className="ov-earnings">
            <p className="ov-earnings-label">Estimated at your prices</p>
            <p className="ov-earnings-value num">{formatMoney(earnings.amount)}</p>
            <p className="ov-earnings-note">
              {!earnings.anyPriced
                ? 'No model with traffic has a price set yet.'
                : `Your asking price for ${earnings.countedRequests} recorded request${earnings.countedRequests === 1 ? '' : 's'}, not money received.`}
              {earnings.truncated && ` The log keeps the last 100 events, so ${earnings.reportedRequests} requests today are not all counted here.`}
              {earnings.unpricedModels.length > 0 && ` Unpriced: ${earnings.unpricedModels.join(', ')}.`}
            </p>
            <Button variant="quiet" onClick={() => onNavigate('Models')}>Edit prices</Button>
          </div>
        </div>
        {today?.note && <Caption>{today.note}</Caption>}
      </Section>

      <Section title="This machine" note="Measured across the whole Mac, not just Relay.">
        <table className="ov-facts ov-facts-wide">
          <tbody>
            <tr>
              <th>Host id</th><td className="mono">{status.host_id}</td>
              <th>Platform</th><td className="mono">{status.os}/{status.arch}{host ? `, ${host.cpus} cores` : ''}</td>
            </tr>
            <tr>
              <th>CPU in use</th>
              <td className="num">{host ? <><Meter value={host.cpuPercent} label={`CPU ${formatPercent(host.cpuPercent)}`} /> {formatPercent(host.cpuPercent)}</> : '—'}</td>
              <th>Memory in use</th>
              <td className="num">{host ? <>{formatBytes(host.memoryUsed)} of {formatBytes(host.memoryTotal)}</> : '—'}</td>
            </tr>
            <tr>
              <th>Machine up</th><td className="num">{host ? formatElapsed(host.uptimeSeconds) : '—'}</td>
              <th>Host token</th><td className="mono">{config?.token_env ?? '—'}{status.token_present ? '' : ' (missing)'}</td>
            </tr>
          </tbody>
        </table>
      </Section>
    </div>
  );
}
