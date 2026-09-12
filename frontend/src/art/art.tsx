// Hand-drawn SVG artwork. Everything here is line work on the cream ground, using
// theme tokens so both schemes are correct. No raster images, no icon fonts.
import React from 'react';
import './art.css';

/**
 * One lockup, not a mark beside a word: the hand-off happens between two posts and
 * the baton carries straight on into the R, so the name is the far end of the pass.
 */
export function Wordmark({ height = 30 }: { height?: number }) {
  return (
    <svg
      className="art-lockup"
      height={height}
      viewBox="0 0 132 30"
      fill="none"
      role="img"
      aria-label="Relay"
    >
      <circle cx="7" cy="15" r="5.2" stroke="currentColor" strokeWidth="1.7" />
      {/* The pass: out of the first post, through the second, into the word. */}
      <path d="M12.2 15h20.6" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="24" cy="15" r="5.2" stroke="currentColor" strokeWidth="1.7" fill="var(--ground)" />
      <path d="M27.6 11.4 31.2 15l-3.6 3.6" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <text className="art-lockup-text" x="37" y="21.5">Relay</text>
    </svg>
  );
}

/** Models resident on this machine: a stack of local weights. */
function LocalGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 2.5 17 6l-7 3.5L3 6l7-3.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M3 10l7 3.5L17 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13.75 10 17.25l7-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" opacity=".55" />
    </svg>
  );
}

/** A gateway to an account elsewhere: a doorway with the route beyond it. */
function ProviderGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 16.5V5.5A1.5 1.5 0 0 1 5.5 4h5A1.5 1.5 0 0 1 12 5.5v11" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M2.5 16.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="9.5" cy="10.5" r="0.9" fill="currentColor" />
      <path d="M15 7.5h3M15 10.5h3M15 13.5h3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}

export function RuntimeGlyph({ kind, size = 20 }: { kind: 'ollama' | 'cliproxyapi'; size?: number }) {
  return kind === 'ollama' ? <LocalGlyph size={size} /> : <ProviderGlyph size={size} />;
}

export interface DiagramNode {
  id: string;
  label: string;
  kind: 'ollama' | 'cliproxyapi';
  ready: boolean;
  models: number;
}

/**
 * A drafted schematic of this host's real topology: each configured runtime, the
 * agent on this machine, the coordinator, and the buyers beyond it. Node states and
 * labels come from live data, so it is a diagram of what is actually true right now.
 */
export function RelayDiagram({
  nodes, sharing, hostId, coordinatorHost, recentRequests = 0,
}: {
  nodes: DiagramNode[];
  sharing: 'live' | 'starting' | 'paused';
  hostId: string;
  coordinatorHost: string;
  /** Requests in the last hour; sets how fast the flow animation runs. */
  recentRequests?: number;
}) {
  const rowHeight = 54;
  const top = 26;
  const height = Math.max(180, top + nodes.length * rowHeight + 34);
  const agentX = 300;
  const agentY = top + (nodes.length * rowHeight) / 2 - 6;
  const linkClass = sharing === 'live' ? 'art-link art-link-live' : 'art-link';
  // Each runtime's lead line turns at its own column so the runs never overlap.
  const busX = (i: number) => 196 + i * 12;
  // Busier hosts animate faster, so the diagram reads as a rate at a glance.
  // Clamped either side: always visible, never frantic.
  const flowSeconds = Math.max(1.1, 3.4 - Math.min(recentRequests, 40) * 0.055);
  const flowing = sharing === 'live';
  const uplink = `M${agentX + 132} ${agentY + 19} H 520`;

  return (
    <figure className="art-figure">
      <svg
        className="art-diagram"
        viewBox={`0 0 700 ${height}`}
        role="img"
        aria-label={`Topology: ${nodes.length} local runtimes connect through the Relay agent on ${hostId} to the coordinator at ${coordinatorHost}.`}
      >
        {/* Local runtimes */}
        {nodes.map((node, i) => {
          const y = top + i * rowHeight;
          return (
            <g key={node.id} className={node.ready ? 'art-node' : 'art-node art-node-down'}>
              <rect x="1" y={y} width="168" height="38" rx="3" />
              <text className="art-node-label" x="14" y={y + 16}>{node.label}</text>
              <text className="art-node-sub" x="14" y={y + 29}>
                {node.ready ? `${node.models} model${node.models === 1 ? '' : 's'}` : 'not reachable'}
              </text>
              <circle className="art-dot" cx="158" cy={y + 19} r="3" />
              {/* Lead line into the agent, each on its own turn column */}
              <path
                className={node.ready ? linkClass : 'art-link art-link-down'}
                d={`M169 ${y + 19} H ${busX(i)} V ${agentY + 19} H ${agentX - 2}`}
              />
              {/* Answers travelling back out to the agent while work is flowing */}
              {flowing && node.ready && (
                <path
                  className="art-flow"
                  style={{ animationDuration: `${flowSeconds}s`, animationDelay: `${i * 0.35}s` }}
                  d={`M169 ${y + 19} H ${busX(i)} V ${agentY + 19} H ${agentX - 2}`}
                />
              )}
            </g>
          );
        })}

        {/* The agent on this machine */}
        <g className="art-agent">
          <rect x={agentX} y={agentY} width="132" height="38" rx="3" />
          <text className="art-node-label" x={agentX + 14} y={agentY + 16}>Relay agent</text>
          <text className="art-node-sub art-mono" x={agentX + 14} y={agentY + 29}>{hostId}</text>
        </g>

        {/* Outbound link to the coordinator, with a request travelling in on it */}
        <path className={linkClass} d={uplink} />
        {flowing && (
          <>
            <path className="art-flow art-flow-in" style={{ animationDuration: `${flowSeconds}s` }} d={uplink} />
            <circle className="art-packet" r="2.5">
              <animateMotion dur={`${flowSeconds}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear" path={uplink} />
            </circle>
          </>
        )}
        <g className="art-remote">
          <rect x="520" y={agentY} width="118" height="38" rx="3" />
          <text className="art-node-label" x="534" y={agentY + 16}>Coordinator</text>
          <text className="art-node-sub art-mono" x="534" y={agentY + 29}>{coordinatorHost}</text>
        </g>

        {/* Buyers beyond the coordinator: a receding rank of request sources */}
        <g className="art-buyers">
          <path className={linkClass} d={`M638 ${agentY + 19} H 654`} />
          <path d={`M658 ${agentY + 6} h 14 M658 ${agentY + 19} h 20 M658 ${agentY + 32} h 14`} />
          <text className="art-node-sub" x="658" y={agentY - 6}>buyers</text>
        </g>

        {/* Boundary: everything left of this line stays on this machine */}
        <g className="art-boundary">
          <path d={`M486 8 V ${height - 20}`} />
          <text x="478" y={height - 8} textAnchor="end">this machine</text>
          <text x="494" y={height - 8}>network</text>
        </g>
      </svg>
      <figcaption className="art-caption">
        {sharing === 'live'
          ? 'Requests arrive from the coordinator and are answered by the runtimes on the left.'
          : sharing === 'paused'
            ? 'Sharing is off: the agent holds no session with the coordinator.'
            : 'Sharing is on, but the agent loop is not running, so no session is open.'}
      </figcaption>
    </figure>
  );
}

/** Hourly request volume: hairline axis, accent for completed, clay for failed. */
export function HourlyChart({
  buckets, height = 96,
}: {
  buckets: { time: Date; requests: number; successful: number; failed: number }[];
  height?: number;
}) {
  const peak = Math.max(1, ...buckets.map(b => b.requests));
  const width = 640;
  const gutter = 26; // room for the scale figure at the left
  const gap = 4;
  const plotWidth = width - gutter;
  const barWidth = Math.max(4, (plotWidth - gap * (buckets.length - 1)) / buckets.length);
  const plot = height - 18;
  // Label every third hour at full width, every sixth when the bars get narrow.
  const tickEvery = barWidth < 24 ? 6 : 3;

  return (
    // Uniform scaling only: preserveAspectRatio="none" would stretch the tick text.
    <svg className="art-chart" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`Requests per hour over the last ${buckets.length} hours, peak ${peak}.`}>
      {/* The scale, so a lone bar is readable as a count rather than just "full height". */}
      <text className="art-tick" x="0" y="10">{peak}</text>
      <text className="art-tick" x="0" y={plot}>0</text>
      {buckets.map((bucket, i) => {
        const x = gutter + i * (barWidth + gap);
        const total = (bucket.requests / peak) * plot;
        const failed = (bucket.failed / peak) * plot;
        return (
          <g key={bucket.time.toISOString()}>
            {bucket.requests > 0 && (
              <>
                <rect className="art-bar" x={x} y={plot - total} width={barWidth} height={total - failed} />
                {failed > 0 && <rect className="art-bar-failed" x={x} y={plot - failed} width={barWidth} height={failed} />}
              </>
            )}
            {i % tickEvery === 0 && (
              <text className="art-tick" x={x} y={height - 4}>
                {bucket.time.toLocaleTimeString('en-US', { hour: 'numeric', hour12: false })}
              </text>
            )}
          </g>
        );
      })}
      <path className="art-axis" d={`M${gutter} ${plot + 0.5} H ${width}`} />
    </svg>
  );
}

/** Nothing has happened yet: a plotted baseline with no series on it. */
export function EmptyActivity() {
  return (
    <svg className="art-empty" viewBox="0 0 220 72" role="img" aria-label="No requests recorded yet.">
      <path className="art-axis" d="M8 56.5 H 212" />
      <path className="art-axis" d="M8.5 8 V 56" />
      {[0, 1, 2, 3, 4, 5].map(i => (
        <path key={i} className="art-tick-mark" d={`M${40 + i * 34} 56 v4`} />
      ))}
      <path className="art-empty-line" d="M8 56 H 212" />
      <text className="art-tick" x="110" y="24" textAnchor="middle">no requests recorded</text>
    </svg>
  );
}

/** A whisper of tooth in the paper so the cream reads as a material, not a fill. */
export function PaperTexture() {
  return (
    <svg className="art-texture" aria-hidden="true" focusable="false">
      <filter id="relay-grain">
        <feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="3" stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#relay-grain)" />
    </svg>
  );
}
