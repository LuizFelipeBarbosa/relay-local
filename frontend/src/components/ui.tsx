// Shared UI primitives. Prefix: ui-
import React, { useEffect, useRef, useState } from 'react';
import './ui.css';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'quiet';

export function Button({
  variant = 'secondary', pending, children, className = '', ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; pending?: boolean }) {
  return (
    <button
      type="button"
      className={`ui-button ui-button-${variant} ${className}`}
      aria-busy={pending || undefined}
      disabled={rest.disabled || pending}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Two-step confirmation in place of a browser dialog: the button becomes its own
 * confirm/cancel pair, so a destructive action always takes a second deliberate click.
 */
export function ConfirmButton({
  onConfirm, children, confirmLabel = 'Confirm', variant = 'danger', pending, disabled, question,
}: {
  onConfirm: () => void;
  children: React.ReactNode;
  confirmLabel?: string;
  variant?: ButtonVariant;
  pending?: boolean;
  disabled?: boolean;
  question?: string;
}) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (armed) confirmRef.current?.focus(); }, [armed]);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return <Button variant={variant} onClick={() => setArmed(true)} disabled={disabled} pending={pending}>{children}</Button>;
  }
  return (
    <span className="ui-confirm" role="group">
      {question && <span className="ui-confirm-question">{question}</span>}
      <button ref={confirmRef} type="button" className="ui-button ui-button-danger" onClick={() => { setArmed(false); onConfirm(); }}>
        {confirmLabel}
      </button>
      <button type="button" className="ui-button ui-button-quiet" onClick={() => setArmed(false)}>Cancel</button>
    </span>
  );
}

export function Toggle({
  on, onChange, label, disabled, onLabel = 'Offered', offLabel = 'Private',
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={on ? 'ui-toggle ui-toggle-on' : 'ui-toggle'}
      onClick={() => onChange(!on)}
    >
      <span className="ui-toggle-track"><span className="ui-toggle-knob" /></span>
      <span className="ui-toggle-text">{on ? onLabel : offLabel}</span>
    </button>
  );
}

let fieldSeq = 0;

export function Field({
  label, hint, error, mono, children, id: providedId, ...input
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  mono?: boolean;
  children?: never;
}) {
  const [id] = useState(() => providedId || `ui-field-${++fieldSeq}`);
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(' ');
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>{label}</label>
      <input
        id={id}
        className={mono ? 'ui-input ui-input-mono' : 'ui-input'}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint && !error && <span className="ui-field-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="ui-field-error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

/** Sharing state, runtime reachability, request outcome — always a mark plus a word. */
export function StatusDot({ tone }: { tone: 'live' | 'ok' | 'warn' | 'down' | 'idle' }) {
  return <span className={`ui-dot ui-dot-${tone}`} aria-hidden="true" />;
}

export function Section({
  title, note, aside, children, id,
}: {
  title: string;
  note?: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <section className="ui-section" id={id}>
      <div className="ui-section-label">
        <h2>{title}</h2>
        {note && <p className="ui-section-note">{note}</p>}
        {aside}
      </div>
      <div className="ui-section-body">{children}</div>
    </section>
  );
}

/** The sentence under a table saying what the figures do and do not cover. */
export function Caption({ children }: { children: React.ReactNode }) {
  return <p className="ui-caption">{children}</p>;
}

export function Notice({
  tone = 'info', children, onDismiss,
}: {
  tone?: 'info' | 'warn' | 'error';
  children: React.ReactNode;
  onDismiss?: () => void;
}) {
  return (
    <div className={`ui-notice ui-notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span>{children}</span>
      {onDismiss && <button type="button" className="ui-notice-close" onClick={onDismiss} aria-label="Dismiss">×</button>}
    </div>
  );
}

/** Wraps a wide table so the page itself never scrolls sideways. */
export function TableScroll({ children, label }: { children: React.ReactNode; label: string }) {
  return <div className="ui-tablescroll" role="region" aria-label={label} tabIndex={0}>{children}</div>;
}

export function Meter({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span className="ui-meter" role="img" aria-label={label}>
      <span className="ui-meter-fill" style={{ width: `${clamped}%` }} />
    </span>
  );
}

/** Figures the agent did not report. Never render 0 in their place. */
export function NotReported({ children = 'not reported' }: { children?: React.ReactNode }) {
  return <span className="ui-unreported">{children}</span>;
}
