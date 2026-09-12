// Settings: the coordinator and host identity, the runtime connections the agent
// may dial, and what Relay actually found installed on this machine.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { RuntimeGlyph } from '../art/art';
import { Button, Caption, ConfirmButton, Field, Notice, NotReported, Section, TableScroll } from '../components/ui';
import { nextBackendId, normalizeConfig, validateConcurrency, validateConfig } from '../derive';
import { useAction, useTransient, type Polled } from '../hooks';
import type { AgentConfig, BackendConfig, RuntimeInfo, Status } from '../types';
import './settings.css';

/**
 * Concurrency is held as the raw input string while the owner types — an empty or
 * half-typed field has no numeric value — and is coerced back to a number before it
 * ever reaches the server. Sending the string is what made every save fail with 400.
 */
type DraftBackend = Omit<BackendConfig, 'concurrency'> & { concurrency: string };
type Draft = Omit<AgentConfig, 'backends'> & { backends: DraftBackend[] };

/** The draft and the server payload it started from, so unsaved edits are detectable. */
interface Editing {
  draft: Draft;
  base: Draft;
}

function toDraft(config: AgentConfig): Draft {
  return { ...config, backends: config.backends.map(b => ({ ...b, concurrency: String(b.concurrency) })) };
}

function toConfig(draft: Draft): AgentConfig {
  return { ...draft, backends: draft.backends.map(b => ({ ...b, concurrency: Number(b.concurrency) })) };
}

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

export function Settings({
  config, runtimes, status, onSaved,
}: {
  config: Polled<AgentConfig>;
  runtimes: RuntimeInfo[] | null;
  status: Status | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [justSaved, markSaved] = useTransient(2500);

  const server = config.data;
  const serverKey = server ? JSON.stringify(server) : null;
  const latest = useRef<AgentConfig | null>(server);
  latest.current = server;

  // Adopt server data on first load, and on a later poll only when there is nothing
  // unsaved — a 30 s refresh must never overwrite what the owner is typing.
  useEffect(() => {
    const fresh = latest.current;
    if (!fresh) return;
    const next = toDraft(fresh);
    setEditing(current => (current === null || same(current.draft, current.base) ? { draft: next, base: next } : current));
  }, [serverKey]);

  const save = useAction(
    async (payload: AgentConfig) => {
      const saved = await api.saveConfig(payload);
      const adopted = toDraft(saved && Array.isArray(saved.backends) ? saved : payload);
      setEditing({ draft: adopted, base: adopted });
    },
    { onDone: () => { markSaved(); onSaved(); }, resetAfterMs: 0 },
  );

  const draft = editing?.draft ?? null;
  const errors = useMemo(() => (draft ? validateConfig(toConfig(draft)) : {}), [draft]);
  const errorCount = Object.keys(errors).length;

  if (!draft || !editing) {
    return (
      <p className="st-loading">
        {config.error
          ? `Could not read the configuration: ${config.error.message}`
          : 'Reading the agent’s configuration…'}
      </p>
    );
  }

  const dirty = !same(editing.draft, editing.base);
  const saving = save.state === 'pending';
  const blocked = errorCount > 0;

  const patch = (next: Partial<Draft>) =>
    setEditing(current => (current ? { ...current, draft: { ...current.draft, ...next } } : current));

  const patchBackend = (index: number, next: Partial<DraftBackend>) =>
    setEditing(current => current ? {
      ...current,
      draft: {
        ...current.draft,
        backends: current.draft.backends.map((backend, i) => (i === index ? { ...backend, ...next } : backend)),
      },
    } : current);

  const addBackend = () =>
    setEditing(current => {
      if (!current) return current;
      const added: DraftBackend = {
        id: nextBackendId(toConfig(current.draft)),
        kind: 'cliproxyapi',
        url: 'http://127.0.0.1:8317',
        key_env: 'CLIPROXYAPI_KEY',
        models: [],
        concurrency: '1',
      };
      return { ...current, draft: { ...current.draft, backends: [...current.draft.backends, added] } };
    });

  const removeBackend = (index: number) =>
    setEditing(current => current && current.draft.backends.length > 1 ? {
      ...current,
      draft: { ...current.draft, backends: current.draft.backends.filter((_, i) => i !== index) },
    } : current);

  const discard = () => setEditing(current => (current ? { ...current, draft: current.base } : current));

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blocked || saving || !dirty) return;
    void save.run(normalizeConfig(toConfig(editing.draft)));
  };

  const onlyOne = draft.backends.length === 1;
  const detected = runtimes ?? [];
  const unconfigured = detected.filter(runtime => !runtime.configured);

  return (
    <form className="st-page app-reveal" onSubmit={submit} noValidate>
      <div className="st-lede">
        <h1 className="st-title">Settings</h1>
        <p className="st-sub">
          Where this machine connects, what it calls itself, and which local runtimes the agent may send work to.
          Everything here is written to the agent&rsquo;s configuration file on this machine.
        </p>
      </div>

      <Section title="Coordinator and identity" note="Who this host connects to, and the name it connects under.">
        <div className="st-grid">
          <div className="st-cell st-cell-wide">
            <Field
              label="Coordinator address"
              mono
              autoComplete="off"
              spellCheck={false}
              value={draft.coordinator_url}
              onChange={event => patch({ coordinator_url: event.target.value })}
              error={errors.coordinator_url}
              hint="The WebSocket endpoint the agent dials, ending in /relay/v1/connect. Plain ws:// is allowed only for a coordinator on this machine."
            />
          </div>
          <div className="st-cell">
            <Field
              label="Host id"
              mono
              autoComplete="off"
              spellCheck={false}
              value={draft.host_id}
              onChange={event => patch({ host_id: event.target.value })}
              error={errors.host_id}
              hint="How this machine identifies itself to the coordinator."
            />
          </div>
          <div className="st-cell">
            <Field
              label="Host token variable"
              mono
              autoComplete="off"
              spellCheck={false}
              value={draft.token_env}
              onChange={event => patch({ token_env: event.target.value })}
              error={errors.token_env}
              hint="The name of an environment variable, not the token itself."
            />
          </div>
        </div>
        <Caption>
          Relay reads the host token from the environment that started it, so only the variable name is saved here.
          The dashboard never shows the token value and never stores it.
          {status && server && (status.token_present
            ? <> The agent found a value for <span className="mono">{server.token_env}</span> in its environment.</>
            : <> The agent found no value for <span className="mono">{server.token_env}</span>, so the agent loop cannot connect until that variable is set where Relay is started.</>)}
        </Caption>
      </Section>

      <Section
        title="Runtime connections"
        note={`${draft.backends.length} connection${draft.backends.length === 1 ? '' : 's'} the agent may dial on this machine.`}
        aside={<Button variant="quiet" onClick={addBackend}>Add a CLIProxyAPI endpoint</Button>}
      >
        <div className="st-backends">
          {draft.backends.map((backend, index) => {
            const at = (field: string) => errors[`backends.${index}.${field}`];
            const concurrencyError = validateConcurrency(backend.concurrency);
            return (
              <div className="st-backend" key={backend.id}>
                <div className="st-backend-head">
                  <span className="st-glyph"><RuntimeGlyph kind={backend.kind} /></span>
                  <span className="st-backend-name">
                    <span className="st-backend-label">{backend.label?.trim() || backend.id}</span>
                    <span className="st-backend-meta">
                      <span className="mono">{backend.id}</span>
                      <span className="st-backend-kind">
                        {backend.kind === 'ollama' ? 'Local runtime' : 'Provider gateway'}
                      </span>
                    </span>
                  </span>
                  <span className="st-backend-action">
                    <ConfirmButton
                      question="Remove this connection?"
                      confirmLabel="Remove"
                      disabled={onlyOne}
                      onConfirm={() => removeBackend(index)}
                    >
                      Remove
                    </ConfirmButton>
                  </span>
                </div>
                {at('id') && <p className="st-backend-error">{at('id')}</p>}
                <div className="st-grid">
                  <div className="st-cell">
                    <Field
                      label="Label"
                      autoComplete="off"
                      value={backend.label ?? ''}
                      onChange={event => patchBackend(index, { label: event.target.value || undefined })}
                      placeholder={backend.id}
                    />
                  </div>
                  <div className="st-cell st-cell-wide">
                    <Field
                      label="Address"
                      mono
                      autoComplete="off"
                      spellCheck={false}
                      value={backend.url}
                      onChange={event => patchBackend(index, { url: event.target.value })}
                      error={at('url')}
                    />
                  </div>
                  {backend.kind === 'cliproxyapi' && (
                    <div className="st-cell">
                      <Field
                        label="Key variable"
                        mono
                        autoComplete="off"
                        spellCheck={false}
                        value={backend.key_env ?? ''}
                        onChange={event => patchBackend(index, { key_env: event.target.value || undefined })}
                        error={at('key_env')}
                      />
                    </div>
                  )}
                  <div className="st-cell st-cell-narrow">
                    <Field
                      label="At once"
                      inputMode="numeric"
                      autoComplete="off"
                      value={backend.concurrency}
                      onChange={event => patchBackend(index, { concurrency: event.target.value })}
                      error={concurrencyError}
                      hint="1 to 64"
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {errors.backends && <p className="st-backend-error">{errors.backends}</p>}
        <Caption>
          The address is the runtime&rsquo;s root URL on this machine, with no path; the agent dials it over loopback and
          never exposes it to the network. The label is what you see elsewhere in the dashboard, and falls back to the id.
          &ldquo;At once&rdquo; is how many requests Relay sends that runtime in parallel, and it is what the coordinator
          is told your capacity is.
          {onlyOne && ' Relay needs at least one connection, so this one cannot be removed.'}
          {' '}Signing in to a provider happens in CLIProxyAPI&rsquo;s own flow; Relay reads its key from the named
          variable and imports the models it offers on the next refresh.
        </Caption>
      </Section>

      <Section title="Detected runtimes" note="What Relay found installed on this machine.">
        {runtimes === null ? (
          <p className="st-empty-text">Waiting for the agent&rsquo;s runtime scan.</p>
        ) : detected.length === 0 ? (
          <p className="st-empty-text">The agent reported no known runtime on this machine.</p>
        ) : (
          <TableScroll label="Detected runtimes">
            <table className="st-table">
              <thead>
                <tr><th>Runtime</th><th>Endpoint</th><th>Executable</th></tr>
              </thead>
              <tbody>
                {detected.map(runtime => (
                  <tr key={runtime.id || runtime.name}>
                    <td>{runtime.name}</td>
                    <td className={runtime.endpoint ? 'mono st-dim' : 'st-dim'}>
                      {runtime.endpoint ? runtime.endpoint : <NotReported>no endpoint reported</NotReported>}
                    </td>
                    <td className={runtime.binary ? 'mono st-dim' : 'st-dim'}>
                      {runtime.binary ? runtime.binary : 'not found on this machine'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <Caption>
          Relay never starts, stops, or configures these processes. It looks for them, and connects to the addresses
          set above.
          {unconfigured.length > 0 && ` ${unconfigured.map(r => r.name).join(' and ')} is installed but has no connection above, so Relay does not use it.`}
        </Caption>
      </Section>

      <div className="st-save">
        <div className="st-save-body">
          <div className="st-save-row">
            <Button
              type="submit"
              variant={dirty && !blocked ? 'primary' : 'secondary'}
              pending={saving}
              disabled={blocked || saving || !dirty}
            >
              Save changes
            </Button>
            {dirty && !saving && <Button variant="quiet" onClick={discard}>Discard changes</Button>}
            <span className="st-save-state" role="status" aria-live="polite">
              {saving ? 'Saving…'
                : justSaved ? 'Saved'
                : blocked ? `${errorCount} field${errorCount === 1 ? '' : 's'} to fix before saving`
                : dirty ? 'Unsaved changes'
                : 'No unsaved changes'}
            </span>
          </div>
          <p className="st-save-note">
            Saving rewrites the configuration file and restarts the agent loop, so sharing stops for a few seconds
            while the agent reconnects. Work already in flight is not cancelled.
          </p>
          {save.error && (
            <div className="st-save-error">
              <Notice tone="error" onDismiss={save.reset}>{save.error}</Notice>
            </div>
          )}
        </div>
      </div>
    </form>
  );
}
