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
  /** Short context line shown in the composer header, e.g. the thread subject. */
  contextLabel?: string;
}

export interface AssistantSeed {
  text?: string;
  context?: SourceRef[];
  /** Send immediately instead of only filling the input. */
  send?: boolean;
}

export interface AppContextValue {
  boot: Bootstrap;
  auth: AuthConfig;
  /** Refetch /api/bootstrap in the background (counts, connection status). */
  refreshBoot: () => void;
  patchBoot: (updater: (boot: Bootstrap) => Bootstrap) => void;
  account: (id: Id | null | undefined) => Connection | undefined;
  /** Accounts selected in the rail. Empty means all. */
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
  assistantSeed: AssistantSeed | null;
  setAssistantSeed: (seed: AssistantSeed | null) => void;
  openPalette: () => void;
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
      <span className={clsx('acct-badge acct-badge--unknown', className)} title="This account is no longer connected">
        <span className="acct-dot acct-dot--hollow" aria-hidden="true" />
        <span className="acct-badge__label">{accountId ? 'Removed account' : 'No account'}</span>
      </span>
    );
  }
  const needsAttention = found.status === 'reconnect_required' || found.status === 'error';
  return (
    <span
      className={clsx('acct-badge', className)}
      title={`${found.email}${found.demo ? ' · simulated demo account' : ''}${needsAttention && found.statusDetail ? ` · ${found.statusDetail}` : ''}`}
    >
      <AccountDot account={found} />
      <span className="acct-badge__label">{found.label}</span>
      {showEmail && <span className="acct-badge__email">{found.email}</span>}
      {found.demo && <span className="acct-badge__demo">demo</span>}
      {needsAttention && <TriangleAlert size={12} className="acct-badge__warn" aria-label="Needs attention" />}
    </span>
  );
}

const RESOURCE_NOUN: Record<SourceGap['resource'], string> = {
  mail: 'mail',
  calendar: 'calendar',
  tasks: 'tasks',
  contacts: 'contacts',
  files: 'files',
};

/**
 * Lists the sources a result could not read, so a partial list never looks complete.
 * `onLeave` runs before navigating to Connections (for example to close a dialog).
 */
export function GapNotice({ gaps, onLeave }: { gaps: SourceGap[]; onLeave?: () => void }) {
  const { account, navigate } = useApp();
  if (!gaps.length) return null;
  return (
    <div className="notice notice--warn gap-notice" role="status">
      <TriangleAlert size={15} aria-hidden="true" />
      <div className="notice__text">
        <strong>
          {gaps.length === 1 ? 'One source could not be read' : `${gaps.length} sources could not be read`} — these results are incomplete.
        </strong>
        <ul className="gap-notice__list">
          {gaps.map((gap, index) => {
            const found = account(gap.accountId);
            return (
              <li key={`${gap.accountId ?? 'none'}-${gap.resourceId ?? gap.resource}-${index}`}>
                <span className="gap-notice__who">
                  {found ? found.label : 'Unknown account'} · {RESOURCE_NOUN[gap.resource] ?? gap.resource}
                </span>{' '}
                {gap.message}
              </li>
            );
          })}
        </ul>
      </div>
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          onLeave?.();
          navigate('#/connections');
        }}
      >
        Review accounts
      </button>
    </div>
  );
}
