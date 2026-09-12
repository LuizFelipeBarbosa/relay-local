import React, { useEffect, useState } from 'react';
import { AgentConfig, BackendConfig, api, errorMessage } from '../api';
import { PageHead, ViewProps } from './shared';

export function Settings({ data, refresh }: ViewProps) {
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [message, setMessage] = useState('');
  const [saved, setSaved] = useState(false);
  // The draft is taken from the first config the poller delivers and then owned by the form.
  useEffect(() => { if (!draft && data.config) setDraft(data.config); }, [data.config]);

  if (!draft) return <><PageHead title="Settings" note="relay.json" /><div className="empty">Loading configuration…</div></>;

  const update = (patch: Partial<AgentConfig>) => setDraft({ ...draft, ...patch });
  const updateBackend = (index: number, patch: Partial<BackendConfig>) => update({ backends: draft.backends.map((b, i) => i === index ? { ...b, ...patch } : b) });
  const addProxy = (e: React.MouseEvent) => {
    e.preventDefault();
    update({ backends: [...draft.backends, { id: `cliproxyapi-${draft.backends.length + 1}`, kind: 'cliproxyapi', url: 'http://127.0.0.1:8317', key_env: 'CLIPROXYAPI_KEY', models: [], concurrency: 1 }] });
  };
  const save = async () => {
    try {
      const stored = await api<AgentConfig>('/config', { method: 'PUT', body: JSON.stringify(draft) });
      setDraft(stored);
      setSaved(true);
      setMessage('Saved. Runtime discovery refreshes shortly.');
      setTimeout(() => setSaved(false), 1800);
      await refresh();
    } catch (e) { setMessage(errorMessage(e, 'Could not save configuration')); }
  };
  const concurrency = draft.backends.reduce((n, b) => n + (Number(b.concurrency) || 0), 0);

  return <>
    <PageHead title="Settings" note="relay.json · discovery refreshes within 30 s of saving" />
    <section className="settings-section first">
      <div><h2>Coordinator</h2><div className="desc">How this host reaches the network and identifies itself.</div></div>
      <div className="fields">
        <label className="field wide">Coordinator URL<input className="input" value={draft.coordinator_url} onChange={e => update({ coordinator_url: e.target.value })} /></label>
        <label className="field">Host ID<input className="input" value={draft.host_id} onChange={e => update({ host_id: e.target.value })} /></label>
        <label className="field">Host token env var<input className="input" value={draft.token_env} onChange={e => update({ token_env: e.target.value })} /></label>
        <label className="field"><span>Request concurrency <span className="hint">(sum of runtimes, read only)</span></span><input className="input" readOnly value={concurrency} /></label>
      </div>
    </section>
    {draft.backends.map((b, i) => <section className="settings-section" key={`${b.id}-${i}`}>
      <div>
        <h2>{b.label || b.id}</h2>
        <div className="desc">{b.kind === 'ollama' ? 'Models are discovered from Ollama; install more from the Models page.' : 'Sign in through CLIProxyAPI’s own flow, then refresh to import every provider model it exposes.'}</div>
      </div>
      <div className="fields">
        <label className="field">Label<input className="input" placeholder={b.id} value={b.label || ''} onChange={e => updateBackend(i, { label: e.target.value })} /></label>
        <label className="field">Loopback URL<input className="input" value={b.url} onChange={e => updateBackend(i, { url: e.target.value })} /></label>
        {b.kind === 'cliproxyapi' && <label className="field">API key env var<input className="input" placeholder="CLIPROXYAPI_KEY" value={b.key_env || ''} onChange={e => updateBackend(i, { key_env: e.target.value })} /></label>}
        <label className="field">Concurrency<input className="input" type="number" min="1" max="64" value={b.concurrency} onChange={e => updateBackend(i, { concurrency: Number(e.target.value) })} /></label>
      </div>
    </section>)}
    <div className="settings-section">
      <a href="#" className="add" onClick={addProxy}>+ Add another CLIProxyAPI endpoint</a>
      <div className="save">
        <button className="btn solid tall" onClick={save}>{saved ? 'Saved' : 'Save settings'}</button>
        <span>{message || 'Unsaved changes are kept until you leave this page.'}</span>
      </div>
    </div>
  </>;
}
