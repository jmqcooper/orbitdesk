'use client';

import clsx from 'clsx';
import { Check, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import { browserTimezone, safeColor } from '@/lib/format';
import type { Bootstrap, Settings } from '@/lib/types';
import type { AuthNotice } from './Boot';
import { GoogleG } from './Landing';
import { Button, OrbitMark, Spinner } from './ui';
import { VoiceFields, type Voice } from './VoiceFields';

/**
 * Two screens between signing in and the inbox: which accounts, and how you
 * sound. Finishing starts the agent's first pass over the mail.
 */
export function Onboarding({
  boot,
  notice,
  onNoticeShown,
  onDone,
  refreshBoot,
  signOut,
}: {
  boot: Bootstrap;
  notice: AuthNotice | null;
  onNoticeShown: () => void;
  onDone: (settings: Settings) => void;
  refreshBoot: () => void;
  signOut: () => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [message, setMessage] = useState<AuthNotice | null>(null);
  const [voice, setVoice] = useState<Voice>({ voice: boot.settings.voice ?? '', about: boot.settings.about ?? '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const accounts = boot.connections;
  const connect = boot.capabilities.googleConnect;
  const syncing = accounts.some((c) => c.status === 'syncing' || !c.lastSyncAt);

  // The result of a Google round trip arrives once; keep it on this screen.
  useEffect(() => {
    if (!notice) return;
    setMessage(notice);
    setStep(1);
    onNoticeShown();
  }, [notice, onNoticeShown]);

  // A freshly connected account is still importing; show it settle.
  useEffect(() => {
    if (!syncing || step !== 1) return;
    const timer = setInterval(refreshBoot, 5000);
    return () => clearInterval(timer);
  }, [syncing, step, refreshBoot]);

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateSettings({ voice: voice.voice.trim() || null, about: voice.about.trim() || null, timezone: browserTimezone(), onboarded: true });
      onDone(result.settings);
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  const written = Boolean(voice.voice.trim() || voice.about.trim());

  return (
    <div className="onb">
      <header className="onb__bar">
        <span className="wordmark">
          <OrbitMark size={24} />
          <span>Orbitdesk</span>
        </span>
        <ol className="onb__steps" aria-label="Setup progress">
          <li className={clsx(step === 1 && 'is-current', step > 1 && 'is-done')} aria-current={step === 1 ? 'step' : undefined}>
            <span>{step > 1 ? <Check size={11} strokeWidth={3} /> : 1}</span> Accounts
          </li>
          <li className={clsx(step === 2 && 'is-current')} aria-current={step === 2 ? 'step' : undefined}>
            <span>2</span> Voice
          </li>
        </ol>
        <button type="button" className="onb__out" onClick={signOut}>
          Sign out
        </button>
      </header>

      {step === 1 ? (
        <main className="onb__card" key="accounts">
          <h1 className="onb__title">Connect your Google accounts</h1>
          <p className="onb__lede">Add every inbox you want in one place: work, personal, clients. Each is connected on its own, and nothing is ever sent without you.</p>

          {message && (
            <div className={`notice notice--${message.tone === 'danger' ? 'danger' : message.tone === 'ok' ? 'ok' : 'info'}`} role="alert">
              <span className="notice__text">{message.message}</span>
            </div>
          )}

          <div className="onb__panel">
            <div className="onb__count">
              <strong className="num">{accounts.length}</strong>
              <span>{accounts.length === 1 ? 'account connected' : 'accounts connected'}</span>
            </div>
            {accounts.length > 0 && (
              <ul className="onb__accounts">
                {accounts.map((connection) => {
                  const pending = connection.status === 'syncing' || !connection.lastSyncAt;
                  const bad = connection.status === 'reconnect_required' || connection.status === 'error';
                  return (
                    <li key={connection.id}>
                      <span className="acct-dot" style={{ width: 9, height: 9, background: safeColor(connection.color, connection.id) }} aria-hidden="true" />
                      <span className="onb__email">{connection.email}</span>
                      <span className={clsx('onb__state', bad && 'is-bad')}>
                        {bad ? (
                          'Needs attention'
                        ) : pending ? (
                          <>
                            <Spinner size={11} /> Importing
                          </>
                        ) : (
                          <>
                            <Check size={12} strokeWidth={3} /> Ready
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {connect.available ? (
              <a className={clsx('btn btn--lg btn--block', accounts.length === 0 && 'btn--primary')} href={googleAuthUrl('connect', { features: ['mail', 'calendar', 'tasks'] })}>
                {accounts.length === 0 ? (
                  <span className="landing__g">
                    <GoogleG />
                  </span>
                ) : (
                  <Plus size={16} aria-hidden="true" />
                )}
                <span>{accounts.length === 0 ? 'Connect a Google account' : 'Connect another account'}</span>
              </a>
            ) : (
              <p className="onb__hint">{connect.reason ?? 'Google accounts cannot be connected on this deployment.'}</p>
            )}
          </div>

          <footer className="onb__foot">
            <span className="onb__hint">Mail, Calendar and Tasks are requested. Contacts and Drive can be added later.</span>
            <Button variant="primary" size="lg" disabled={accounts.length === 0} onClick={() => setStep(2)}>
              Continue
            </Button>
          </footer>
        </main>
      ) : (
        <main className="onb__card" key="voice">
          <h1 className="onb__title">Teach it how you write</h1>
          <p className="onb__lede">Every draft is written as you. Paste a voice skill or a persona prompt if you have one. Otherwise, just say a little about yourself.</p>

          <VoiceFields value={voice} onChange={setVoice} disabled={busy} />

          {error && (
            <div className="notice notice--danger" role="alert">
              <span className="notice__text">{error.message}</span>
            </div>
          )}

          <footer className="onb__foot">
            <Button variant="ghost" size="lg" disabled={busy} onClick={() => setStep(1)}>
              Back
            </Button>
            <span className="spacer" />
            <Button variant="primary" size="lg" busy={busy} onClick={finish}>
              {written ? 'Start' : 'Skip for now'}
            </Button>
          </footer>
        </main>
      )}
    </div>
  );
}
