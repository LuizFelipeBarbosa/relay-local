// Activity: the per-hour distribution, the per-model rollup, and the full request log.
import React, { useMemo } from 'react';
import { EmptyActivity, HourlyChart } from '../art/art';
import { Caption, Notice, NotReported, Section, TableScroll } from '../components/ui';
import { bucketByHour, estimateEarnings, eventAmount, eventTokens, rollupByModel, usageView } from '../derive';
import {
  formatCount, formatDateTime, formatDuration, formatMoney, formatRelative, formatTime, formatTokens,
} from '../format';
import type { Polled } from '../hooks';
import type { HistoryEvent, HistoryResponse, Prices, UsageResponse } from '../types';
import { useNewRows } from '../useNewRows';
import './activity.css';

/** A stable empty list so the memos below do not re-run on every poll. */
const NO_EVENTS: HistoryEvent[] = [];

/** The agent records availability changes in the same feed; they belong in the timeline. */
function availabilityLabel(event: HistoryEvent): string {
  if (event.kind === 'resume') return 'Resumed';
  return event.status === 'stop' ? 'Stopped' : 'Paused';
}

function availabilityNote(event: HistoryEvent): string {
  if (event.kind === 'resume') return 'The agent started taking requests again.';
  if (event.status === 'stop') return 'Sharing was stopped and the requests in flight were canceled.';
  return 'Sharing was paused; the requests already in flight were allowed to finish.';
}

export function Activity({ history, prices, usage }: {
  history: Polled<HistoryResponse>;
  prices: Prices | null;
  usage: UsageResponse | null;
}) {
  const events = history.data?.events ?? NO_EVENTS;
  const rates = prices ?? {};

  const isNew = useNewRows((history.data?.events ?? []).map(event => event.time));

  const requests = useMemo(() => events.filter(event => event.kind === 'request'), [events]);
  const buckets = useMemo(() => bucketByHour(events, 12), [events]);
  const rollup = useMemo(() => rollupByModel(events, rates), [events, prices]);
  const earnings = useMemo(() => estimateEarnings(events, rates, usage?.today), [events, prices, usage]);
  const today = usage ? usageView(usage.today) : null;

  // The running column adds each estimate down the page, so the last row equals the total.
  const running = useMemo(() => {
    let sum = 0;
    return events.map(event => {
      if (event.kind === 'request') sum += eventAmount(event, rates);
      return sum;
    });
  }, [events, prices]);

  const totals = useMemo(() => {
    let inputTokens = 0, outputTokens = 0, durationMs = 0, durationSamples = 0, failed = 0, missingDuration = 0;
    for (const event of requests) {
      const tokens = eventTokens(event);
      inputTokens += tokens.input;
      outputTokens += tokens.output;
      if (event.duration_ms !== undefined) { durationMs += event.duration_ms; durationSamples++; }
      else if (event.status === 'completed') missingDuration++;
      if (event.status !== 'completed') failed++;
    }
    return { inputTokens, outputTokens, durationMs, durationSamples, failed, missingDuration };
  }, [requests]);

  if (!history.data) {
    if (history.error) {
      return (
        <div className="ac-error">
          <Notice tone="error">Could not read the request log: {history.error.message}</Notice>
        </div>
      );
    }
    return <p className="ac-loading">Reading the request log on this machine…</p>;
  }

  const priced = new Set(rollup.filter(row => row.priced).map(row => row.model));
  const peak = buckets.reduce((best, bucket) => (bucket.requests > best.requests ? bucket : best), buckets[0]);
  const otherEvents = events.length - requests.length;

  return (
    <div className="ac-page app-reveal">
      <div className="ac-lede">
        <h1 className="ac-headline">Activity</h1>
        <p className="ac-sub">
          Every request this machine answered, newest first, exactly as the agent recorded it — with the
          availability changes that interrupted them.
        </p>
      </div>

      <Section title="Distribution" note="Requests per hour, drawn from the log below.">
        {requests.length === 0 ? (
          <div className="ac-empty">
            <EmptyActivity />
            <p>No request has reached this machine yet. They will appear here as buyers use the models you offer.</p>
          </div>
        ) : (
          <>
            <HourlyChart buckets={buckets} />
            <p className="ac-chart-note">
              Twelve hours ending {formatDateTime(buckets[buckets.length - 1].time.toISOString())}; each bar is one
              hour and the last one is the current hour, still filling.{' '}
              {peak.requests > 0
                ? <>The busiest hour began {formatDateTime(peak.time.toISOString())} with {formatCount(peak.requests)}{' '}
                    request{peak.requests === 1 ? '' : 's'}{peak.failed > 0 ? `, ${formatCount(peak.failed)} of them failed` : ''}.</>
                : <>No request landed inside this window; the newest event in the log is from {formatRelative(events[0].time)}.</>}
            </p>
          </>
        )}
        {today && (requests.length > 0 || today.requests > 0) && (
          <Caption>
            Today the agent counted {formatCount(today.requests)} request{today.requests === 1 ? '' : 's'},{' '}
            {formatCount(today.successful)} completed and {formatCount(today.failed)} failed
            {today.displayTotal !== null ? `, for ${formatTokens(today.displayTotal)} tokens` : ', with no token usage reported'}.
            {' '}The log still holds {formatCount(requests.length)} of them.
          </Caption>
        )}
      </Section>

      <Section title="By model" note="Every model that answered while the log has been held.">
        {rollup.length === 0 ? (
          <p className="ac-empty-text">No model has answered a request in the events the agent still holds.</p>
        ) : (
          <>
            <TableScroll label="Requests by model">
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th className="ac-right">Requests</th>
                    <th className="ac-right">Completed</th>
                    <th className="ac-right">Failed</th>
                    <th className="ac-right">Tokens in</th>
                    <th className="ac-right">Tokens out</th>
                    <th className="ac-right">Mean duration</th>
                    <th className="ac-right">Estimated</th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.map(row => (
                    <tr key={row.model}>
                      <td className="mono">{row.model}</td>
                      <td className="ac-right num">{formatCount(row.requests)}</td>
                      <td className="ac-right num">{formatCount(row.successful)}</td>
                      <td className={row.failed > 0 ? 'ac-right num ac-failed' : 'ac-right num'}>{formatCount(row.failed)}</td>
                      <td className="ac-right num">{formatTokens(row.inputTokens)}</td>
                      <td className="ac-right num">{formatTokens(row.outputTokens)}</td>
                      <td className="ac-right num">
                        {row.durationSamples > 0 ? (
                          <>
                            {formatDuration(row.durationMs / row.durationSamples)}
                            <span className="ac-figure-note">{formatCount(row.durationSamples)} of {formatCount(row.requests)} timed</span>
                          </>
                        ) : <NotReported>—</NotReported>}
                      </td>
                      <td className="ac-right num">
                        {row.priced ? formatMoney(row.amount) : <NotReported>no price</NotReported>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            <Caption>
              Mean duration is the average over the requests that reported one, never over every request — the count
              under each figure says how many that is. Amounts are what the tokens are worth at your asking prices for
              the requests still in the log, not money received.
              {earnings.unpricedModels.length > 0 && ` No price is set for ${earnings.unpricedModels.join(', ')}, so nothing is estimated for ${earnings.unpricedModels.length === 1 ? 'it' : 'them'}.`}
            </Caption>
          </>
        )}
      </Section>

      <Section title="Request log" note="Newest first, with the running estimate beside it.">
        {events.length === 0 ? (
          <p className="ac-empty-text">The agent has recorded nothing yet, so the log is empty.</p>
        ) : (
          <>
            <TableScroll label="Request log">
              <table className="ac-table ac-log">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Model</th>
                    <th>Outcome</th>
                    <th className="ac-right">Duration</th>
                    <th className="ac-right">Tokens in</th>
                    <th className="ac-right">Tokens out</th>
                    <th className="ac-right">Estimated</th>
                    <th className="ac-right">Running</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event, i) => {
                    if (event.kind !== 'request') {
                      return (
                        <tr className="ac-event" key={`${event.time}-${i}`}>
                          <td className="mono ac-dim">{formatTime(event.time)}</td>
                          <td colSpan={7}>
                            <span className="ac-event-label">{availabilityLabel(event)}</span>
                            {availabilityNote(event)}
                          </td>
                        </tr>
                      );
                    }
                    const completed = event.status === 'completed';
                    const hasPrice = event.model ? priced.has(event.model) : false;
                    return (
                      <tr key={`${event.time}-${i}`} className={isNew(event.time) ? 'ui-enter' : undefined}>
                        <td className="mono ac-dim">{formatTime(event.time)}</td>
                        <td className="mono">{event.model ?? <NotReported>unnamed</NotReported>}</td>
                        <td className={completed ? '' : 'ac-failed'}>{completed ? 'Completed' : 'Failed'}</td>
                        <td className="ac-right num">{formatDuration(event.duration_ms) ?? <NotReported>—</NotReported>}</td>
                        <td className="ac-right num">{event.usage_reported ? formatCount(event.input_tokens ?? 0) : <NotReported>—</NotReported>}</td>
                        <td className="ac-right num">{event.usage_reported ? formatCount(event.output_tokens ?? 0) : <NotReported>—</NotReported>}</td>
                        <td className="ac-right num">
                          {!event.usage_reported
                            ? <NotReported>—</NotReported>
                            : hasPrice ? formatMoney(eventAmount(event, rates)) : <NotReported>no price</NotReported>}
                        </td>
                        <td className="ac-right num">
                          {earnings.anyPriced ? formatMoney(running[i]) : <NotReported>—</NotReported>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {requests.length > 0 && (
                  <tfoot>
                    <tr className="ac-total">
                      <th colSpan={3} scope="row">
                        Totals over {formatCount(requests.length)} request{requests.length === 1 ? '' : 's'} shown
                      </th>
                      <td className="ac-right num">
                        {totals.durationSamples > 0 ? formatDuration(totals.durationMs) : <NotReported>—</NotReported>}
                      </td>
                      <td className="ac-right num">{formatCount(totals.inputTokens)}</td>
                      <td className="ac-right num">{formatCount(totals.outputTokens)}</td>
                      <td className="ac-right num">
                        {earnings.anyPriced ? formatMoney(earnings.amount) : <NotReported>—</NotReported>}
                      </td>
                      <td className="ac-right num" />
                    </tr>
                  </tfoot>
                )}
              </table>
            </TableScroll>
            <Caption>
              The agent keeps at most the last 100 events; this log shows {formatCount(events.length)}
              {events.length === 1 ? ' event' : ' events'}
              {otherEvents > 0
                ? ` — ${formatCount(requests.length)} request${requests.length === 1 ? '' : 's'} and ${formatCount(otherEvents)} pause or resume event${otherEvents === 1 ? '' : 's'}`
                : ''}.
              {totals.missingDuration > 0
                ? ` ${formatCount(totals.missingDuration)} completed request${totals.missingDuration === 1 ? '' : 's'} reported no duration, so ${totals.missingDuration === 1 ? 'it is' : 'they are'} missing from the duration column and from every average here.`
                : ' Every completed request reported a duration.'}
              {totals.failed > 0
                ? ` Failed requests report no tokens, so the ${formatCount(totals.failed)} failure${totals.failed === 1 ? '' : 's'} add${totals.failed === 1 ? 's' : ''} nothing to the token columns or the estimate.`
                : ' No request in this log failed.'}
              {' '}Running adds each estimate down the page, so the bottom row equals the total.
              {earnings.truncated && earnings.reportedRequests !== null
                ? ` Today's totals from the agent count ${formatCount(earnings.reportedRequests)} requests — more than the log still holds — so everything above covers only the most recent ${formatCount(requests.length)}.`
                : ''}
            </Caption>
          </>
        )}
      </Section>
    </div>
  );
}
