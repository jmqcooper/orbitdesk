'use client';

import type { ApiRequestError } from '@/lib/api';
import { Button, ErrorState, OrbitMark } from './ui';

/** A message carried across a sign-in, sign-out or OAuth round trip. */
export interface AuthNotice {
  tone: 'ok' | 'danger' | 'info';
  message: string;
  /** Connection to highlight after a successful link. */
  accountId?: string;
}

export function BootScreen({ label }: { label: string }) {
  return (
    <div className="boot" role="status" aria-live="polite">
      <OrbitMark size={40} className="boot__mark" />
      <p className="boot__label">{label}</p>
    </div>
  );
}

export function BootFailure({
  error,
  explanation,
  onRetry,
  onSignOut,
}: {
  error: ApiRequestError;
  explanation: string;
  onRetry: () => void;
  onSignOut?: () => void;
}) {
  return (
    <div className="boot">
      <OrbitMark size={36} />
      <div className="boot__error">
        <ErrorState error={error} onRetry={onRetry}>
          <p className="errstate__msg">{explanation}</p>
        </ErrorState>
        {onSignOut && (
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            Sign out
          </Button>
        )}
      </div>
    </div>
  );
}
