import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { AUTH_REQUIRED, api, emptyStatus, emptyUsage, errorMessage } from './api';
import { AuthGate } from './views/AuthGate';
import { Overview } from './views/Overview';
import { Runtimes } from './views/Runtimes';
import { Models } from './views/Models';
import { Performance } from './views/Performance';
import { Usage } from './views/Usage';
import { Finance } from './views/Finance';
import { Schedule } from './views/Schedule';
import { Settings } from './views/Settings';
import { Data, TABS, Tab, ViewProps } from './views/shared';

const POLL_MS = 2000;
const NAV_ORDER_KEY = 'relay-nav-order';
const SIDEBAR_KEY = 'relay-sidebar';

const emptyData: Data = { status: emptyStatus, backends: [], offers: {}, usage: emptyUsage, events: [], prices: {}, config: null, refreshedAt: 0 };

function App() {
  const [data, setData] = useState<Data>(emptyData);
  const [tab, setTab] = useState<Tab>('Overview');
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const [status, models, usage, history, prices, config] = await Promise.all([
        api('/status'), api('/models'), api('/usage'), api('/history'), api('/prices'), api('/config'),
      ]);
      setData({ status, backends: models.backends || [], offers: models.offers || {}, usage: usage || emptyUsage, events: history.events || [], prices: prices || {}, config, refreshedAt: Date.now() });
      setError('');
      setAuthRequired(false);
    } catch (e) {
      const message = errorMessage(e, 'Dashboard unavailable');
      setError(message);
      if (message === AUTH_REQUIRED) setAuthRequired(true);
    }
  };

  const authenticate = async (token: string) => {
    try {
      await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
      history.replaceState({}, '', location.pathname);
      setError('');
      setAuthRequired(false);
      await refresh();
    } catch { setError('That dashboard token was not accepted. Run relay dashboard to get a new access link.'); }
  };

  useEffect(() => {
    (async () => {
      const token = new URLSearchParams(location.search).get('token');
      if (token) {
        try {
          await api('/session', { method: 'POST', body: JSON.stringify({ token }) });
          history.replaceState({}, '', location.pathname);
        } catch { setError('The dashboard link has expired. Run relay dashboard to get a new link.'); }
      }
      await refresh();
    })();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const availability = async (action: 'pause' | 'resume' | 'stop') => {
    setBusy(true);
    try {
      await api('/availability', { method: 'POST', body: JSON.stringify({ action }) });
      await refresh();
    } catch (e) { setError(errorMessage(e, 'Action failed')); } finally { setBusy(false); }
  };

  const { status, backends } = data;
  const capacity = backends.reduce((n, b) => n + b.capacity, 0);
  const busySlots = backends.reduce((n, b) => n + (b.capacity - b.available), 0);
  const viewProps: ViewProps = { data, goTo: setTab, refresh, setError };

  return <div className="shell">
    <Sidebar tab={tab} onSelect={setTab} status={status} />
    <main className="main">
      <header className="topbar">
        <span className={status.sharing ? 'state live' : 'state'}><i />{status.sharing ? 'accepting work' : 'sharing paused'}</span>
        <span className="detail">{status.running ? 'agent running' : 'agent stopped'} · {status.host_id} · {busySlots} of {capacity} slots busy</span>
        <div className="actions">
          {status.sharing
            ? <button className="btn" disabled={busy || authRequired} onClick={() => availability('pause')}>Pause</button>
            : <button className="btn" disabled={busy || authRequired} onClick={() => availability('resume')}>Resume</button>}
          <button className="btn solid" disabled={busy || authRequired || !status.running} onClick={() => availability('stop')}>Stop now</button>
        </div>
      </header>
      <div className="content">
        {error && !authRequired && <div className="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss">×</button></div>}
        {authRequired ? <AuthGate onAuthenticate={authenticate} /> : <View tab={tab} {...viewProps} />}
      </div>
    </main>
  </div>;
}

function View({ tab, ...props }: ViewProps & { tab: Tab }) {
  switch (tab) {
    case 'Overview': return <Overview {...props} />;
    case 'Runtimes': return <Runtimes {...props} />;
    case 'Models': return <Models {...props} />;
    case 'Performance': return <Performance {...props} />;
    case 'Usage': return <Usage {...props} />;
    case 'Finance': return <Finance {...props} />;
    case 'Schedule': return <Schedule />;
    case 'Settings': return <Settings {...props} />;
  }
}

function loadNavOrder(): Tab[] {
  try {
    const stored = JSON.parse(localStorage.getItem(NAV_ORDER_KEY) || 'null');
    if (Array.isArray(stored) && stored.length === TABS.length && TABS.every(t => stored.includes(t))) return stored;
  } catch { /* fall back to the default order */ }
  return [...TABS];
}

function Sidebar({ tab, onSelect, status }: { tab: Tab; onSelect: (tab: Tab) => void; status: Data['status'] }) {
  const [order, setOrder] = useState<Tab[]>(loadNavOrder);
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(SIDEBAR_KEY) !== 'collapsed'; } catch { return true; } });
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const dragIndex = useRef<number | null>(null);

  const toggleSidebar = () => {
    const next = !expanded;
    setExpanded(next);
    try { localStorage.setItem(SIDEBAR_KEY, next ? 'expanded' : 'collapsed'); } catch { /* storage unavailable */ }
  };
  const reorder = (to: number) => {
    const from = dragIndex.current;
    setDragging(null); setOver(null); dragIndex.current = null;
    if (from === null || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  };

  return <aside className={expanded ? 'sidebar' : 'sidebar collapsed'}>
    <div className="brand"><span className="mark" />{expanded && <><span className="name">RELAY</span><span className="version">0.1</span></>}</div>
    <nav className="nav">
      {order.map((name, i) => {
        const active = tab === name;
        const classes = ['nav-item', active && 'active', dragging === i && 'dragging', over === i && dragging !== null && dragging !== i && 'drop-target'].filter(Boolean).join(' ');
        return <button key={name} className={classes} title={name} draggable onClick={() => onSelect(name)}
          onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; dragIndex.current = i; setDragging(i); }}
          onDragOver={e => { e.preventDefault(); if (over !== i) setOver(i); }}
          onDrop={e => { e.preventDefault(); reorder(i); }}
          onDragEnd={() => { setDragging(null); setOver(null); dragIndex.current = null; }}>
          <span className="num">{active ? '■' : String(i + 1).padStart(2, '0')}</span>
          {expanded && <><span className="text">{name}</span><span className="grip">::</span></>}
        </button>;
      })}
      {expanded && <div className="nav-hint">drag to reorder</div>}
    </nav>
    <div className="sidebar-foot">
      {expanded && <>
        <div className="row"><span>Agent</span><span>{status.running ? 'online' : 'stopped'}</span></div>
        <div className="row"><span>Host</span><span title={status.host_id}>{status.host_id}</span></div>
      </>}
      <button className="collapse" title={expanded ? 'Collapse menu' : 'Expand menu'} onClick={toggleSidebar}>{expanded ? '«' : '»'}{expanded && <span>collapse</span>}</button>
    </div>
  </aside>;
}

createRoot(document.getElementById('root')!).render(<App />);
