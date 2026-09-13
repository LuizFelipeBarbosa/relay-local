import React from 'react';
import { formatCompact, formatNumber, series } from '../stats';

type ChartData = ReturnType<typeof series>;
type LiveUsage = { requests: number; bytes: number; output_tokens_estimate: number };

export function TokenBuckets({ chart, live }: { chart: ChartData; live?: LiveUsage }) {
  const liveTokens = live?.output_tokens_estimate || 0;
  const values = chart.inputTokens.map((input, index) => input + chart.outputTokens[index] + (index === chart.tokens.length - 1 ? liveTokens : 0));
  const max = Math.max(...values, 0);
  const liveActive = (live?.requests || 0) > 0;
  return <div className="token-buckets">
    <div className="token-buckets-head">
      <h3>Tokens by {chart.bucket === 'hour' ? 'hour' : chart.bucket === '15m' ? '15-minute interval' : chart.bucket === 'month' ? 'month' : 'day'}</h3>
      <div className="token-buckets-meta">
        <div className="token-buckets-legend"><span><i className="token-key input" />input</span><span><i className="token-key output" />output</span>{liveActive && <span><i className="token-key live" />live output</span>}</div>
        <span className="note">{liveActive ? `${formatCompact(liveTokens)} live estimated` : 'completed usage'}</span>
      </div>
    </div>
    <div className="token-bars" aria-label="Token usage by time bucket">
      {values.map((value, index) => {
        const input = chart.inputTokens[index] || 0;
        const output = chart.outputTokens[index] || 0;
        const liveValue = index === values.length - 1 ? liveTokens : 0;
        const labelEvery = chart.bucket === '15m' ? 2 : chart.bucket === 'hour' ? 3 : chart.bucket === 'day' ? 2 : 1;
        const showLabel = index % labelEvery === 0 || index === values.length - 1;
        const label = showLabel ? chart.bucketLabels[index] : '';
        const detail = `${chart.bucketLabels[index]} · ${formatNumber(input)} input · ${formatNumber(output)} output${liveValue > 0 ? ` · ${formatNumber(liveValue)} live output` : ''} · ${formatNumber(value)} total`;
        return <div className="token-bar" key={index} title={detail} aria-label={detail}>
          <div className="token-bar-track">
            <div className="token-bar-stack" style={{ height: `${max ? (value / max) * 100 : 0}%` }}>
              {input > 0 && <span className="token-bar-input" style={{ height: `${(input / value) * 100}%` }} />}
              {output > 0 && <span className="token-bar-output" style={{ height: `${(output / value) * 100}%` }} />}
              {liveValue > 0 && <span className="token-bar-live" style={{ height: `${(liveValue / value) * 100}%` }} />}
            </div>
          </div>
          <span className="token-bar-tooltip" role="tooltip">{detail}</span>
          {label && <span className="token-bar-label">{label}</span>}
        </div>;
      })}
    </div>
    {max === 0 && <div className="empty">Token usage will appear after the first completed request.</div>}
  </div>;
}
