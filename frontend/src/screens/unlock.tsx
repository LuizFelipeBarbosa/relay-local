// The token-exchange gate. This is the first thing a new owner sees, so it is the
// product on the cream ground — a short form, not an error page.
import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { Wordmark } from '../art/art';
import { Button, Field, Notice } from '../components/ui';
import './unlock.css';

/**
 * Read at load: the app strips `?token=` from the address bar as soon as it has tried
 * it, so by the time this screen renders the query is already gone. A token in the URL
 * plus this screen means the link itself failed.
 */
const CAME_FROM_LINK =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('token');

export function Unlock({ onUnlocked }: { onUnlocked: () => void }) {
  const [token, setToken] = useState('');
  const [pending, setPending] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = token.trim();
    if (!value || pending) return;
    setPending(true);
    setRejected(false);
    setProblem(null);
    try {
      await api.authenticate(value);
      setPending(false);
      setToken('');
      onUnlocked();
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught : null;
      if (failure && (failure.status === 401 || failure.status === 403)) setRejected(true);
      else setProblem(failure ? failure.message : 'Something went wrong.');
      setPending(false);
      setTried(true);
    }
  };

  const linkExpired = CAME_FROM_LINK && !tried;

  return (
    <main className="un-page">
      <div className="un-panel">
        <Wordmark />

        <h1 className="un-title">Unlock this dashboard</h1>
        <p className="un-sub">
          Relay prints a dashboard address and token when you run <span className="mono">relay dashboard</span> or{' '}
          <span className="mono">relay serve</span>. Paste that token to open the dashboard for this machine.
        </p>

        {linkExpired && (
          <div className="un-notice">
            <Notice tone="warn">
              The link you opened no longer matches the token this agent is using, so it did not unlock anything.
              Paste the current token below, or run <span className="mono">relay dashboard</span> for a fresh link.
            </Notice>
          </div>
        )}

        <form className="un-form" onSubmit={submit} noValidate>
          <Field
            label="Dashboard token"
            type="password"
            mono
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={event => setToken(event.target.value)}
            error={rejected ? 'That token was not accepted. Copy the value printed in the terminal exactly, with no extra spaces.' : undefined}
            hint="A long hexadecimal string, printed in the terminal that started Relay."
          />
          <Button
            type="submit"
            variant={token.trim() === '' ? 'secondary' : 'primary'}
            pending={pending}
            disabled={token.trim() === '' || pending}
          >
            Unlock
          </Button>
        </form>

        <p className={problem ? 'un-state un-state-error' : 'un-state'} role="status" aria-live="polite">
          {pending ? 'Checking the token…' : problem ? problem : ''}
        </p>

        <p className="un-foot">
          The token is exchanged once for a session cookie that stays in this browser. It is never kept in the page,
          and the dashboard answers only requests from this machine.
        </p>
      </div>
    </main>
  );
}
