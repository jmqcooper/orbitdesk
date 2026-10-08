'use client';

import { PenLine, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import type { AuthConfig } from '@/lib/types';
import type { AuthNotice } from './Boot';
import { Button, OrbitMark, Spinner } from './ui';

export function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
    </svg>
  );
}

// A still of the product: what the agent has already done by the time you look.
const PREVIEW: Array<{ color: string; from: string; subject: string; summary: string; draft?: boolean; time: string }> = [
  { color: '#c17b43', from: 'Lena Fischer', subject: 'Product review', summary: 'Wants 30 minutes on Thursday', draft: true, time: '9:41' },
  { color: '#7287ad', from: 'Sarah Chen', subject: 'Launch checklist', summary: 'Asks you to own the reconnect checks', draft: true, time: '9:12' },
  { color: '#6c8a77', from: 'Alex Morgan', subject: 'The proposal', summary: 'Second nudge; offers a call next week', draft: true, time: 'Mon' },
];

export function Landing({
  auth,
  notice,
  onDismissNotice,
  onSignedIn,
}: {
  auth: AuthConfig;
  notice: AuthNotice | null;
  onDismissNotice: () => void;
  onSignedIn: () => void;
}) {
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState<ApiRequestError | null>(null);
  const [googleBusy, setGoogleBusy] = useState(false);

  const startDemo = async () => {
    setDemoBusy(true);
    setDemoError(null);
    try {
      await api.startDemo();
      onSignedIn();
    } catch (err) {
      setDemoError(toApiError(err));
      setDemoBusy(false);
    }
  };

  return (
    <div className="landing">
      <header className="landing__bar">
        <Link href="/" className="wordmark" aria-label="Orbitdesk home">
          <OrbitMark size={24} />
          <span>Orbitdesk</span>
        </Link>
      </header>

      <main className="landing__main">
        <h1 className="landing__title">
          Your inbox,
          <br />
          already handled.
        </h1>
        <p className="landing__lede">
          Orbitdesk sorts the mail from every Google account you have and writes the replies in your voice. Calendars and tasks sit right beside it. You read, tweak, send.
        </p>

        {notice && (
          <div className={`notice notice--${notice.tone === 'danger' ? 'danger' : notice.tone === 'ok' ? 'ok' : 'info'} landing__notice`} role="alert">
            <span className="notice__text">{notice.message}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={onDismissNotice}>
              <X size={14} />
            </button>
          </div>
        )}

        <div className="landing__cta">
          {auth.google.available ? (
            <a className="btn btn--primary btn--lg" href={googleAuthUrl('login')} aria-busy={googleBusy || undefined} onClick={() => setGoogleBusy(true)}>
              {googleBusy ? (
                <Spinner size={16} />
              ) : (
                <span className="landing__g">
                  <GoogleG />
                </span>
              )}
              <span>Continue with Google</span>
            </a>
          ) : (
            <button type="button" className="btn btn--primary btn--lg" disabled title={auth.google.reason ?? undefined}>
              <span className="landing__g">
                <GoogleG />
              </span>
              <span>Continue with Google</span>
            </button>
          )}
          {auth.demo.available && (
            <Button size="lg" busy={demoBusy} onClick={startDemo}>
              Try the sandbox
            </Button>
          )}
        </div>
        <p className="landing__fine">
          {!auth.google.available
            ? (auth.google.reason ?? 'Google sign-in is not configured here.')
            : auth.inviteOnly
              ? 'Invite-only beta. The sandbox needs no account and touches nothing real.'
              : 'The sandbox needs no account and touches nothing real.'}
        </p>
        {demoError && (
          <p className="field__error" role="alert">
            The sandbox could not start: {demoError.message}
          </p>
        )}

        <div className="preview" aria-hidden="true">
          <div className="preview__tabs">
            <span className="is-active">
              Reply <i>3</i>
            </span>
            <span>
              FYI <i>4</i>
            </span>
            <span>
              Other <i>12</i>
            </span>
          </div>
          {PREVIEW.map((row) => (
            <div key={row.from} className="preview__row">
              <span className="acct-dot" style={{ width: 7, height: 7, background: row.color }} />
              <span className="preview__from">{row.from}</span>
              <span className="preview__text">
                <b>{row.subject}</b>
                <span>{row.summary}</span>
              </span>
              {row.draft && (
                <span className="mark mark--agent">
                  <PenLine size={11} /> Draft ready
                </span>
              )}
              <span className="preview__time">{row.time}</span>
            </div>
          ))}
        </div>
      </main>

      <footer className="landing__foot">
        <span>Open source · nothing is sent without you</span>
        <span className="landing__links">
          <Link href="/privacy">Privacy</Link>
          <Link href="/terms">Terms</Link>
        </span>
      </footer>
    </div>
  );
}
