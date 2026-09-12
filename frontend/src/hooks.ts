// Shared React hooks: polling, hash routing, and async action state.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api';

export interface Polled<T> {
  data: T | null;
  /** Set only when the most recent attempt failed; the last good `data` is kept. */
  error: ApiError | null;
  loading: boolean;
  /** True once a request has succeeded at least once. */
  loaded: boolean;
  refresh: () => Promise<void>;
}

/**
 * Polls `fetcher` on an interval, with three properties the previous UI lacked:
 * requests never overlap, polling stops while the tab is hidden, and a failed
 * refresh keeps the last good data on screen instead of blanking the page.
 */
export function usePolled<T>(fetcher: () => Promise<T>, intervalMs: number, enabled = true): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [loaded, setLoaded] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  // Keep the latest fetcher without making it a dependency: callers pass inline closures.
  const latest = useRef(fetcher);
  latest.current = fetcher;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await latest.current();
      if (!alive.current) return;
      setData(next);
      setError(null);
      setLoaded(true);
    } catch (caught) {
      if (!alive.current) return;
      setError(caught instanceof ApiError ? caught : new ApiError(String(caught), 0));
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    if (!enabled) {
      setLoading(false);
      return () => { alive.current = false; };
    }
    void refresh();
    let timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, intervalMs);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, intervalMs, enabled]);

  return { data, error, loading, loaded, refresh };
}

export type ActionState = 'idle' | 'pending' | 'done' | 'error';

export interface AsyncAction<Args extends unknown[]> {
  run: (...args: Args) => Promise<boolean>;
  state: ActionState;
  error: string | null;
  reset: () => void;
}

/**
 * Wraps a write so the UI can disable the control while it is in flight and show
 * the server's own message when it fails.
 */
export function useAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>,
  options: { onDone?: () => void; resetAfterMs?: number } = {},
): AsyncAction<Args> {
  const [state, setState] = useState<ActionState>('idle');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const latest = useRef(action);
  latest.current = action;
  const { onDone, resetAfterMs = 2000 } = options;
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => () => { alive.current = false; }, []);

  const run = useCallback(async (...args: Args) => {
    setState('pending');
    setError(null);
    try {
      await latest.current(...args);
      if (!alive.current) return true;
      setState('done');
      onDoneRef.current?.();
      if (resetAfterMs > 0) {
        window.setTimeout(() => { if (alive.current) setState('idle'); }, resetAfterMs);
      }
      return true;
    } catch (caught) {
      if (!alive.current) return false;
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setState('error');
      return false;
    }
  }, [resetAfterMs]);

  const reset = useCallback(() => { setState('idle'); setError(null); }, []);
  return { run, state, error, reset };
}

/** Hash routing keeps the dashboard a single static file with no router dependency. */
export function useHashRoute(fallback: string): [string, (route: string) => void] {
  const read = () => window.location.hash.replace(/^#\/?/, '') || fallback;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((next: string) => {
    window.location.hash = '/' + next;
    setRoute(next);
  }, []);
  return [route, navigate];
}

/** A value that stays true for `ms` after being set, for transient "Saved" states. */
export function useTransient(ms = 1800): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const trigger = useCallback(() => {
    setActive(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(false), ms);
  }, [ms]);
  return [active, trigger];
}
