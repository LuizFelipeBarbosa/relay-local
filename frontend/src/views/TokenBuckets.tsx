import React from 'react';
import { formatCompact, series } from '../stats';

type ChartData = ReturnType<typeof series>;
type LiveUsage = { requests: number; bytes: number; output_tokens_estimate: number };

export function TokenBuckets({ chart, live }: { chart: ChartData; live?: LiveUsage }) {
  const liveTokens = live?.output_tokens_estimate || 0;
  const values = chart.tokens.map((value, index) => value + (index === chart.tokens.length - 1 ? liveTokens : 0));
  const max = Math.max(...values, 0);
  const liveActive = (live?.requests || 0) > 0;
  return <div className="token-buckets">
    <div className="token-buckets-head">
      <h3>Tokens by {chart.bucket === 'hour' ? 'hour' : chart.bucket === '15m' ? '15-minute interval' : chart.bucket === 'month' ? 'month' : 'day'}</h3>
      <span className="note">{liveActive ? `${formatCompact(liveTokens)} live estimated` : 'completed usage'}</span>
    </div>
    <div className="token-bars" aria-label="Token usage by time bucket">
      {values.map((value, index) => {
        const completed = chart.tokens[index];
        const liveValue = index === values.length - 1 ? liveTokens : 0;
        const showLabel = chart.bucket === 'hour' || (chart.bucket === '15m' && (index % 4 === 0 || index === values.length - 1));
        const label = showLabel ? chart.bucketLabels[index] : '';
        return <div className="token-bar" key={index} title={`${chart.bucketLabels[index]}: ${formatCompact(value)} tokens`}>
          <div className="token-bar-stack" style={{ height: `${max ? (value / max) * 100 : 0}%` }}>
            <span className="token-bar-complete" style={{ height: `${value ? (completed / value) * 100 : 0}%` }} />
            {liveValue > 0 && <span className="token-bar-live" style={{ height: `${(liveValue / value) * 100}%` }} />}
          </div>
          {label && <span className="token-bar-label">{label}</span>}
        </div>;
      })}
    </div>
    {max === 0 && <div className="empty">Token usage will appear after the first completed request.</div>}
  </div>;
}
