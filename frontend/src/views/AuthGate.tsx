import React, { useState } from 'react';

export function AuthGate({ onAuthenticate }: { onAuthenticate: (token: string) => void }) {
  const [token, setToken] = useState('');
  const submit = () => token.trim() && onAuthenticate(token.trim());
  return <div className="auth">
    <h1>Unlock the dashboard</h1>
    <p>Paste the token printed by <code>relay dashboard</code>. It is exchanged for a browser session and never stored in the page.</p>
    <label className="field">Access token
      <input className="input xl" type="password" autoFocus placeholder="rly_…" value={token} onChange={e => setToken(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
    </label>
    <button className="btn solid xl" disabled={!token.trim()} onClick={submit}>Unlock</button>
  </div>;
}
