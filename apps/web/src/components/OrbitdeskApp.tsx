'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, SIGNED_OUT_EVENT, toApiError } from '@/lib/api';
import type { SessionResponse } from '@/lib/types';
import { BootFailure, BootScreen, type AuthNotice } from './Boot';
import { Landing } from './Landing';
import { Shell } from './Shell';

const AUTH_ERRORS: Record<string, string> = {
  access_denied: 'Google sign-in was cancelled before it finished. Nothing was connected.',
  not_invited:
    'That Google account isn’t on the beta invite list yet. Use the invited address, or look around in the sandbox demo.',
  not_configured:
    'Google sign-in isn’t configured on this deployment. An operator needs to add the OAuth client ID and secret.',
  state_mismatch: 'That sign-in attempt expired or was opened in another tab. Start again from here.',
  scope_denied:
    'Google returned without the permissions Orbitdesk needs. Try again and leave the requested boxes ticked.',
  already_linked:
    'Google returned a different account than the one expected. When reconnecting, choose the same account again; an account can also only be linked to one workspace.',
  account_mismatch:
    'That is not the account being reconnected. Start again and choose the same Google account on Google’s screen.',
  account_limit: 'This workspace has reached its limit of connected accounts.',
  admin_restricted:
    'The Google Workspace administrator for that account blocks this app or one of its permissions. Ask them to allow it, then try again.',
  session_required: 'Sign in to Orbitdesk before linking another Google account.',
  server_error: 'Sign-in failed on our side. Try again in a moment.',
};

/** Reads the result of an OAuth round trip from the URL, then removes it so a reload stays clean. */
function consumeAuthParams(): AuthNotice | null {
  const url = new URL(window.location.href);
  const error = url.searchParams.get('auth_error');
  const result = url.searchParams.get('auth');
  const email = url.searchParams.get('auth_email');
  const accountId = url.searchParams.get('accountId') ?? undefined;
  if (!error && !result) return null;

  for (const key of ['auth_error', 'auth', 'auth_email', 'accountId']) url.searchParams.delete(key);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

  if (error) {
    const base = AUTH_ERRORS[error] ?? `Google sign-in did not complete (${error}).`;
    return { tone: 'danger', message: email ? `${email}: ${base}` : base };
  }
  if (result === 'connected') {
    return { tone: 'ok', message: email ? `${email} is connected.` : 'Google account connected.', accountId };
  }
  return null;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; error: ApiRequestError }
  | { kind: 'ready'; data: SessionResponse };

export default function OrbitdeskApp() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [notice, setNotice] = useState<AuthNotice | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api.session();
      setPhase({ kind: 'ready', data });
    } catch (err) {
      setPhase({ kind: 'error', error: toApiError(err) });
    }
  }, []);

  useEffect(() => {
    const fromUrl = consumeAuthParams();
    if (fromUrl) setNotice(fromUrl);
    void load();
  }, [load]);

  useEffect(() => {
    const onSignedOut = () => {
      setNotice({ tone: 'info', message: 'Your session ended. Sign in again to pick up where you left off.' });
      void load();
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, [load]);

  const clearNotice = useCallback(() => setNotice(null), []);
  const restart = useCallback(
    (message?: string) => {
      setNotice(message ? { tone: 'info', message } : null);
      setPhase({ kind: 'loading' });
      void load();
    },
    [load],
  );

  if (phase.kind === 'loading') return <BootScreen label="Opening Orbitdesk" />;

  if (phase.kind === 'error') {
    return (
      <BootFailure
        error={phase.error}
        explanation="Orbitdesk could not check your session, so nothing is shown."
        onRetry={() => restart()}
      />
    );
  }

  const { session, auth } = phase.data;
  if (!session) {
    return <Landing auth={auth} notice={notice} onDismissNotice={clearNotice} onSignedIn={() => restart()} />;
  }

  return <Shell key={session.workspaceId} auth={auth} flash={notice} onFlashShown={clearNotice} onSignedOut={restart} />;
}
