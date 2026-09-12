import React, { useEffect, useState } from 'react';
import { Backend, ModelJob, api, backendTitle, errorMessage, kindName } from '../api';
import { PageHead, ViewProps, modelDescription } from './shared';

export function Models({ data, refresh, setError }: ViewProps) {
  const { backends, offers, config } = data;
  const total = backends.reduce((n, b) => n + b.models.length, 0);
  const offered = backends.reduce((n, b) => n + b.models.filter(m => offers[b.id]?.[m.name]).length, 0);

  const toggle = async (backend: Backend, model: string, offer: boolean) => {
    try {
      await api('/models', { method: 'POST', body: JSON.stringify({ backend_id: backend.id, model, offer }) });
      await refresh();
    } catch (e) { setError(errorMessage(e, 'Could not save model offer')); }
  };
  const remove = async (model: string) => {
    try {
      await api('/models/remove', { method: 'POST', body: JSON.stringify({ model }) });
      await refresh();
    } catch (e) { setError(errorMessage(e, 'Could not remove model')); }
  };

  return <>
    <PageHead title="Models" note={`${offered} of ${total} offered · private models stay on this machine`} />
    {backends.length === 0 && <div className="empty">No local runtimes connected. Add Ollama or CLIProxyAPI in Settings, then return here to discover their models.</div>}
    {backends.map(b => <section className="model-group" key={b.id}>
      <div className="group-head">
        <h2>{backendTitle(b, config)} <span className="note" style={{ marginLeft: 8 }}>{b.models.length} discovered</span></h2>
        {b.source === 'local' && <Installer onDone={refresh} />}
      </div>
      <div className="scroll"><div className="models-table">
        <div className="table head"><span>model</span><span>description</span><span className="right">offer</span></div>
        {b.models.length === 0 && <div className="empty">{b.ready ? 'No models installed on this runtime.' : 'Runtime is offline; models appear when it answers.'}</div>}
        {b.models.map(m => {
          const on = !!offers[b.id]?.[m.name];
          return <div className="table" key={m.id}>
            <div style={{ minWidth: 0 }}><div className="model-name">{m.name}</div><div className="model-provider">{kindName(b.kind)}</div></div>
            <span className="model-desc">{modelDescription(b, m)}</span>
            <div className="offer-cell">
              {b.source === 'local' && <a href="#" onClick={e => { e.preventDefault(); remove(m.name); }}>Remove</a>}
              <button className={on ? 'toggle on' : 'toggle'} title="Click to toggle" aria-label={`${on ? 'Disable' : 'Enable'} ${m.name}`} onClick={() => toggle(b, m.name, !on)}><i />{on ? 'Offering' : 'Private'}</button>
            </div>
          </div>;
        })}
      </div></div>
    </section>)}
  </>;
}

function Installer({ onDone }: { onDone: () => Promise<void> }) {
  const [model, setModel] = useState('');
  const [job, setJob] = useState<ModelJob | null>(null);

  const install = async () => {
    if (!model.trim()) return;
    try {
      setJob(await api<ModelJob>('/models/install', { method: 'POST', body: JSON.stringify({ model: model.trim() }) }));
      setModel('');
    } catch (e) { setJob({ id: '', model, status: errorMessage(e, 'Install failed'), progress: 0 }); }
  };

  useEffect(() => {
    if (!job?.id || job.status === 'complete' || job.status === 'failed') return;
    const timer = setInterval(() => api<ModelJob[]>('/models/jobs').then(jobs => {
      const current = jobs.find(j => j.id === job.id);
      if (current) setJob(current);
      if (current?.status === 'complete') onDone();
    }).catch(() => {}), 1000);
    return () => clearInterval(timer);
  }, [job]);

  return <div className="install" style={{ flexDirection: 'column', alignItems: 'flex-end' }}>
    <div style={{ display: 'flex' }}>
      <input value={model} placeholder="pull by exact name, e.g. llama3.2:3b" onChange={e => setModel(e.target.value)} onKeyDown={e => e.key === 'Enter' && install()} />
      <button className="btn solid" onClick={install}>Install</button>
    </div>
    {job && <div className="job">{job.model && `${job.model} · `}{job.status}{job.progress ? ` · ${job.progress}%` : ''}{job.error ? ` · ${job.error}` : ''}</div>}
  </div>;
}
