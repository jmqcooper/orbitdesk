'use client';

import clsx from 'clsx';
import { TriangleAlert } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { safeColor } from '@/lib/format';
import type { Route } from '@/lib/hooks';
import type { ComposeFields } from '@/lib/mail';
import type { AuthConfig, Bootstrap, Connection, Draft, DraftMode, Id, SourceGap, SourceRef } from '@/lib/types';

export interface ToastInput {
  message: string;
  tone?: 'info' | 'ok' | 'error';
  action?: { label: string; run: () => void };
  durationMs?: number;
}

/** What the composer needs to open. Either an existing draft, or fields for a new one. */
export interface ComposeRequest {
  mode: DraftMode;
  draft?: Draft;
  accountId?: Id;
  threadId?: Id | null;
  inReplyToMessageId?: Id | null;
  fields?: Partial<ComposeFields>;
}

export interface AssistantSeed {
  text?: string;
  context?: SourceRef[];
  /** Send immediately instead of only filling the input. */
  send?: boolean;
}

export type SettingsSection = 'accounts' | 'voice' | 'agent' | 'preferences' | 'data';

export interface AppContextValue {
  boot: Bootstrap;
  auth: AuthConfig;
  /** Refetch /api/bootstrap in the background (counts, connection status). */
  refreshBoot: () => void;
  patchBoot: (updater: (boot: Bootstrap) => Bootstrap) => void;
  account: (id: Id | null | undefined) => Connection | undefined;
  /** Accounts the views are filtered to. Empty means all. */
  scope: Id[];
  setScope: (ids: Id[]) => void;
  /** `accountId` query value for list requests: undefined when every account is selected. */
  scopeParam: Id[] | undefined;
  /** Stable string form of the scope for resource keys. */
  scopeKey: string;
  route: Route;
  navigate: (path: string, replace?: boolean) => void;
  toast: (toast: ToastInput) => void;
  /** Toast a failed mutation with its server message. */
  reportError: (error: unknown, what: string) => void;
  compose: (request: ComposeRequest) => void;
  /** Open the agent panel, optionally handing it a question. */
  ask: (seed?: AssistantSeed) => void;
  assistantSeed: AssistantSeed | null;
  setAssistantSeed: (seed: AssistantSeed | null) => void;
  agentOpen: boolean;
  setAgentOpen: (open: boolean) => void;
  openPalette: () => void;
  openSettings: (section?: SettingsSection) => void;
  signOut: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ value, children }: { value: AppContextValue; children: ReactNode }) {
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside the signed-in shell.');
  return value;
}

/* ---------------- Account identity ---------------- */

export function AccountDot({ account, size = 8 }: { account: Connection | undefined; size?: number }) {
  return (
    <span
      className="acct-dot"
      style={{ width: size, height: size, background: safeColor(account?.color, account?.id ?? 'unknown') }}
      aria-hidden="true"
    />
  );
}

/**
 * The source-account marker that travels with every mail row, event, task and
 * action. It always resolves from the server's connection list.
 */
export function AccountBadge({
  accountId,
  showEmail,
  className,
}: {
  accountId: Id | null | undefined;
  showEmail?: boolean;
  className?: string;
}) {
  const { account } = useApp();
  const found = account(accountId);
  if (!found) {
    return (
      <span className={clsx('acct-badge', className)} title="This account is no longer connected">
        <span className="acct-dot acct-dot--hollow" aria-hidden="true" />
        <span className="acct-badge__label">{accountId ? 'Removed account' : 'No account'}</span>
      </span>
    );
  }
  const needsAttention = found.status === 'reconnect_required' || found.status === 'error';
  return (
    <span
      className={clsx('acct-badge', className)}
      title={`${found.email}${found.demo ? ' · simulated account' : ''}${needsAttention && found.statusDetail ? ` · ${found.statusDetail}` : ''}`}
    >
      <AccountDot account={found} />
      <span className="acct-badge__label">{showEmail ? found.email : found.label}</span>
      {needsAttention && <TriangleAlert size={12} className="acct-badge__warn" aria-label="Needs attention" />}
    </span>
  );
}

/**
 * Lists the sources a result could not read, so a partial list never looks complete.
 * `onLeave` runs before opening account settings (for example to close a dialog).
 */
export function GapNotice({ gaps, onLeave }: { gaps: SourceGap[]; onLeave?: () => void }) {
  const { account, openSettings } = useApp();
  if (!gaps.length) return null;
  const names = Array.from(new Set(gaps.map((gap) => account(gap.accountId)?.label ?? 'an account')));
  return (
    <div className="notice notice--warn gap-notice" role="status" title={gaps.map((gap) => gap.message).join('\n')}>
      <TriangleAlert size={14} aria-hidden="true" />
      <span className="notice__text">
        Incomplete: {names.slice(0, 3).join(', ')}
        {names.length > 3 ? ` and ${names.length - 3} more` : ''} could not be read.
      </span>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          onLeave?.();
          openSettings('accounts');
        }}
      >
        Fix
      </button>
    </div>
  );
}
