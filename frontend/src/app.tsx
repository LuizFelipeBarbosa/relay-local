// App shell: navigation, polling, sharing controls, routing, and the unlock gate.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from './api';
import { summarizeSharing } from './derive';
import { usePolled, useAction, useHashRoute } from './hooks';
import { PaperTexture, Wordmark } from './art/art';
import { Button, ConfirmButton, Notice, StatusDot } from './components/ui';
import { Overview } from './screens/overview';
import { Activity } from './screens/activity';
import { Models } from './screens/models';
import { Settings } from './screens/settings';
import { Unlock } from './screens/unlock';
import './app.css';

const ROUTES = ['Overview', 'Models', 'Activity', 'Settings'] as const;
type Route = (typeof ROUTES)[number];

export function App() {
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenChecked, setTokenChecked] = useState(false);
  const [route, navigate] = useHashRoute('Overview');

  // A token in the URL is exchanged for the session cookie, then removed from the
  // address bar so it does not linger in history or a screenshot.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) { setTokenChecked(true); return; }
    api.authenticate(token)
      .catch(() => setAuthRequired(true))
      .finally(() => {
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
        setTokenChecked(true);
      });
  }, []);

  const enabled = tokenChecked && !authRequired;
  const status = usePolled(() => api.status(), 2000, enabled);
  const usage = usePolled(() => api.usage(), 2000, enabled);
  const history = usePolled(() => api.history(), 2000, enabled);
  const models = usePolled(() => api.models(), 10_000, enabled);
  const config = usePolled(() => api.config(), 30_000, enabled);
  const prices = usePolled(() => api.prices(), 30_000, enabled);
  const metrics = usePolled(() => api.metrics(), 5000, enabled);
  const runtimes = usePolled(() => api.runtimes(), 30_000, enabled);

  // Any endpoint can be the one to discover the session has gone.
  const errors = [status.error, usage.error, history.error, models.error, config.error, prices.error];
  useEffect(() => {
    if (errors.some(error => error?.authRequired)) setAuthRequired(true);
  }, [errors.map(e => e?.message).join('|')]);

  const refreshAll = useCallback(() => {
    void status.refresh(); void usage.refresh(); void history.refresh();
    void models.refresh(); void config.refresh(); void prices.refresh();
    void metrics.refresh(); void runtimes.refresh();
  }, [status.refresh, usage.refresh, history.refresh, models.refresh, config.refresh, prices.refresh, metrics.refresh, runtimes.refresh]);

  const onUnlocked = useCallback(() => { setAuthRequired(false); refreshAll(); }, [refreshAll]);

  const availability = useAction(
    (action: 'pause' | 'stop' | 'resume') => api.setAvailability(action),
    { onDone: () => { void status.refresh(); void history.refresh(); } },
  );

  const sharing = useMemo(() => status.data ? summarizeSharing(status.data) : null, [status.data]);

  // A dropped connection keeps the last good page and says so, rather than blanking.
  const offline = status.error && !status.error.authRequired && status.loaded;

  if (!tokenChecked) return <div className="app-boot" />;
  if (authRequired) return <><PaperTexture /><Unlock onUnlocked={onUnlocked} /></>;

  return (
    <>
      <PaperTexture />
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header-inner">
            <Wordmark />
            <nav className="app-nav" aria-label="Sections">
              {ROUTES.map(name => (
                <button
                  key={name}
                  type="button"
                  className={route === name ? 'app-nav-item app-nav-active' : 'app-nav-item'}
                  aria-current={route === name ? 'page' : undefined}
                  onClick={() => navigate(name)}
                >
                  {name}
                </button>
              ))}
            </nav>
            <div className="app-header-status">
              {sharing && (
                <span className="app-sharing" title={sharing.detail}>
                  <StatusDot tone={sharing.state === 'live' ? 'live' : sharing.state === 'starting' ? 'warn' : 'idle'} />
                  {sharing.label}
                </span>
              )}
              {status.data && <span className="app-host mono">{status.data.host_id}</span>}
            </div>
          </div>
        </header>

        <main className="app-main">
          {offline && (
            <div className="app-offline">
              <Notice tone="warn">Lost contact with the Relay agent on this machine. Showing the last data received; retrying every two seconds.</Notice>
            </div>
          )}
          {availability.error && (
            <div className="app-offline">
              <Notice tone="error" onDismiss={availability.reset}>{availability.error}</Notice>
            </div>
          )}

          {route === 'Models' ? (
            <Models models={models} config={config.data} prices={prices} onChanged={() => { void models.refresh(); void config.refresh(); }} />
          ) : route === 'Activity' ? (
            <Activity history={history} prices={prices.data} usage={usage.data} />
          ) : route === 'Settings' ? (
            <Settings config={config} runtimes={runtimes.data} status={status.data} onSaved={refreshAll} />
          ) : (
            <Overview
              status={status.data}
              sharing={sharing}
              usage={usage.data}
              history={history.data}
              models={models.data}
              config={config.data}
              prices={prices.data}
              metrics={metrics.data}
              availability={availability}
              onNavigate={navigate}
            />
          )}
        </main>

        <footer className="app-footer">
          <span>
            Served at <span className="mono">http://127.0.0.1:7331</span>, reachable only from this machine.
          </span>
          {config.data && <span className="mono">{config.data.coordinator_url}</span>}
        </footer>
      </div>
    </>
  );
}

/** Pause, Stop now and Resume. Stop cancels work in flight, so it confirms first. */
export function SharingControls({
  sharingState, action,
}: {
  sharingState: 'live' | 'starting' | 'paused';
  action: ReturnType<typeof useAction<['pause' | 'stop' | 'resume']>>;
}) {
  const pending = action.state === 'pending';
  if (sharingState === 'paused') {
    return (
      <div className="app-controls">
        <Button variant="primary" pending={pending} onClick={() => void action.run('resume')}>Resume sharing</Button>
        <p className="app-controls-note">Start accepting requests from the coordinator again.</p>
      </div>
    );
  }
  return (
    <div className="app-controls">
      <div className="app-controls-row">
        <Button pending={pending} onClick={() => void action.run('pause')}>Pause</Button>
        <ConfirmButton
          variant="danger"
          pending={pending}
          question="Cancel work in flight?"
          confirmLabel="Stop now"
          onConfirm={() => void action.run('stop')}
        >
          Stop now
        </ConfirmButton>
      </div>
      <p className="app-controls-note">
        Pause takes no new requests and lets anything in flight finish. Stop now also cancels what is running.
      </p>
    </div>
  );
}

export type { Route };
export { ApiError };
