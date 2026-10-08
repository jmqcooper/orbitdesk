'use client';

import clsx from 'clsx';
import {
  CalendarDays,
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  FolderOpen,
  Info,
  Keyboard,
  ListChecks,
  LogOut,
  Mail,
  Moon,
  Settings2,
  Sparkles,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { needsAttention } from '@/lib/accounts';
import { api, googleAuthUrl, toApiError } from '@/lib/api';
import { initials } from '@/lib/format';
import { isTyping, routePath, useHashRoute, useResource, useShortcuts } from '@/lib/hooks';
import type { AuthConfig, Bootstrap, Id } from '@/lib/types';
import { AgentPanel } from './agent/AgentPanel';
import {
  AccountDot,
  AppProvider,
  useApp,
  type AppContextValue,
  type AssistantSeed,
  type ComposeRequest,
  type SettingsSection,
  type ToastInput,
} from './AppContext';
import { BootFailure, BootScreen, type AuthNotice } from './Boot';
import { CommandPalette } from './CommandPalette';
import { Composer, type ComposerHandle } from './mail/Composer';
import { Onboarding } from './Onboarding';
import { Settings } from './Settings';
import { Dialog, EmptyState, Kbd, Menu, OrbitMark, Popover } from './ui';
import { CalendarView } from './views/CalendarView';
import { FilesView } from './views/FilesView';
import { MailView } from './views/MailView';
import { TasksView } from './views/TasksView';

interface ShellProps {
  auth: AuthConfig;
  flash: AuthNotice | null;
  onFlashShown: () => void;
  onSignedOut: (message?: string) => void;
}

export function Shell({ auth, flash, onFlashShown, onSignedOut }: ShellProps) {
  const boot = useResource('bootstrap', (signal) => api.bootstrap({ signal }), { refreshMs: 60_000 });

  const signOut = useCallback(async () => {
    try {
      await api.logout();
      onSignedOut();
    } catch (err) {
      onSignedOut(`Sign-out did not complete: ${toApiError(err).message}`);
    }
  }, [onSignedOut]);

  if (boot.loading) return <BootScreen label="Opening your desk" />;
  if (!boot.data) {
    return boot.error ? (
      <BootFailure
        error={boot.error}
        explanation="Your workspace could not be loaded, so nothing is shown."
        onRetry={boot.reload}
        onSignOut={signOut}
      />
    ) : (
      <BootScreen label="Opening your desk" />
    );
  }

  if (!boot.data.settings.onboardedAt) {
    return (
      <Onboarding
        boot={boot.data}
        notice={flash}
        onNoticeShown={onFlashShown}
        onDone={(settings) => boot.mutate((current) => ({ ...current, settings }))}
        refreshBoot={boot.reload}
        signOut={signOut}
      />
    );
  }

  return (
    <Workspace
      boot={boot.data}
      bootStale={boot.error ? boot.error.message : null}
      auth={auth}
      refreshBoot={boot.reload}
      patchBoot={boot.mutate}
      flash={flash}
      onFlashShown={onFlashShown}
      signOut={signOut}
    />
  );
}

/* ---------------- Theme ---------------- */

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('orbitdesk:theme', next);
  } catch {
    // Private mode: the choice simply lasts for this page.
  }
}

/* ---------------- Account filter ---------------- */

/** Narrows every view to some accounts. Lives in each view's bar; the choice is shared. */
export function AccountFilter() {
  const { boot, scope, setScope, account, openSettings } = useApp();
  const [open, setOpen] = useState(false);
  if (boot.connections.length < 2) return null;
  const shown = scope.length ? scope.map((id) => account(id)).filter((c) => c !== undefined) : boot.connections;
  const label =
    scope.length === 0 ? 'All accounts' : scope.length === 1 ? (account(scope[0])?.label ?? '1 account') : `${scope.length} accounts`;

  return (
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      align="end"
      panelClassName="acctlist"
      trigger={
        <button
          type="button"
          className="acctfilter"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Filter by account"
          onClick={() => setOpen((value) => !value)}
        >
          <span className="acctfilter__dots" aria-hidden="true">
            {shown.slice(0, 4).map((connection) => (
              <AccountDot key={connection.id} account={connection} size={8} />
            ))}
          </span>
          <span>{label}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      }
    >
      <div role="menu" aria-label="Accounts">
        <button type="button" role="menuitemradio" aria-checked={scope.length === 0} className="menu__item" onClick={() => setScope([])}>
          <span className="menu__icon">{scope.length === 0 && <Check size={14} />}</span>
          <span className="menu__label">All accounts</span>
          <span className="menu__hint">{boot.connections.length}</span>
        </button>
        <div className="menu__divider" role="separator" />
        {boot.connections.map((connection) => {
          const on = scope.includes(connection.id);
          const unread = boot.counts.unreadByAccount[connection.id] ?? 0;
          return (
            <button
              key={connection.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              className={clsx('menu__item', scope.length > 0 && !on && 'is-off')}
              title={connection.email}
              // Click picks one account; shift- or ⌘-click builds a set.
              onClick={(event) => {
                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                  setScope(on ? scope.filter((id) => id !== connection.id) : [...scope, connection.id]);
                } else {
                  setScope(on && scope.length === 1 ? [] : [connection.id]);
                  setOpen(false);
                }
              }}
            >
              <span className="menu__icon">
                <AccountDot account={connection} size={8} />
              </span>
              <span className="acctlist__text">
                <span className="acctlist__label">{connection.label}</span>
                <span className="acctlist__email">{connection.email}</span>
              </span>
              {needsAttention(connection) ? (
                <TriangleAlert size={13} className="acct-badge__warn" aria-label="Needs attention" />
              ) : unread ? (
                <span className="menu__hint num">{unread}</span>
              ) : null}
            </button>
          );
        })}
        <div className="menu__divider" role="separator" />
        <button
          type="button"
          role="menuitem"
          className="menu__item"
          onClick={() => {
            setOpen(false);
            openSettings('accounts');
          }}
        >
          <span className="menu__icon">
            <Settings2 size={14} />
          </span>
          <span className="menu__label">Manage accounts</span>
        </button>
      </div>
    </Popover>
  );
}

/* ---------------- Shortcuts ---------------- */

const SHORTCUTS: Array<{ head: string; rows: Array<[string, string[]]> }> = [
  {
    head: 'Anywhere',
    rows: [
      ['Command menu', ['⌘', 'K']],
      ['Agent', ['⌘', 'J']],
      ['Compose', ['C']],
      ['Mail, calendar, tasks, files', ['G', 'M/C/T/F']],
    ],
  },
  {
    head: 'Mail list',
    rows: [
      ['Move', ['J', 'K']],
      ['Open', ['↵']],
      ['Next lane', ['Tab']],
      ['Search', ['/']],
      ['Archive', ['E']],
      ['Trash', ['#']],
    ],
  },
  {
    head: 'Conversation',
    rows: [
      ['Send', ['⌘', '↵']],
      ['Reply, reply all, forward', ['R', 'A', 'F']],
      ['Have the agent draft', ['D']],
      ['Star, mark unread', ['S', 'U']],
      ['Back', ['Esc']],
    ],
  },
];

function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" size="lg" onClose={onClose}>
      <div className="keys">
        {SHORTCUTS.map((group) => (
          <div key={group.head} style={{ display: 'contents' }}>
            <p className="keys__head">{group.head}</p>
            {group.rows.map(([label, keys]) => (
              <div key={label} className="keys__row">
                <span>{label}</span>
                <span className="keys__keys">
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

/* ---------------- Workspace ---------------- */

interface ToastItem extends ToastInput {
  id: number;
}

interface WorkspaceProps {
  boot: Bootstrap;
  bootStale: string | null;
  auth: AuthConfig;
  refreshBoot: () => void;
  patchBoot: (updater: (boot: Bootstrap) => Bootstrap) => void;
  flash: AuthNotice | null;
  onFlashShown: () => void;
  signOut: () => void;
}

const VIEWS: Array<{ view: string; label: string; icon: LucideIcon; key: string }> = [
  { view: 'mail', label: 'Mail', icon: Mail, key: 'm' },
  { view: 'calendar', label: 'Calendar', icon: CalendarDays, key: 'c' },
  { view: 'tasks', label: 'Tasks', icon: ListChecks, key: 't' },
  { view: 'files', label: 'Files', icon: FolderOpen, key: 'f' },
];

function Workspace({ boot, bootStale, auth, refreshBoot, patchBoot, flash, onFlashShown, signOut }: WorkspaceProps) {
  const { route, navigate } = useHashRoute();
  const [scopeRaw, setScopeRaw] = useState<Id[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [composer, setComposer] = useState<(ComposeRequest & { key: number }) | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<AssistantSeed | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const toastId = useRef(0);
  const composerKey = useRef(0);
  const chord = useRef(0);

  const byId = useMemo(() => new Map(boot.connections.map((c) => [c.id, c])), [boot.connections]);
  // A removed connection silently drops out of the filter.
  const scope = useMemo(() => scopeRaw.filter((id) => byId.has(id)), [scopeRaw, byId]);
  const scopeKey = scope.length ? [...scope].sort().join(',') : 'all';

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((list) => [...list.slice(-2), { ...input, id }]);
      window.setTimeout(() => dismissToast(id), input.durationMs ?? (input.tone === 'error' ? 9000 : 4800));
    },
    [dismissToast],
  );

  const reportError = useCallback(
    (error: unknown, what: string) => {
      toast({ tone: 'error', message: `${what}: ${toApiError(error).message}` });
    },
    [toast],
  );

  const compose = useCallback(
    async (request: ComposeRequest) => {
      // Never drop an open message: save it first, and keep it open if that fails.
      if (composerRef.current) {
        const saved = await composerRef.current.saveBeforeReplace();
        if (!saved) {
          toast({ tone: 'error', message: 'The open message could not be saved, so it was kept open.' });
          return;
        }
      }
      composerKey.current += 1;
      setComposer({ ...request, key: composerKey.current });
    },
    [toast],
  );

  const ask = useCallback((seed?: AssistantSeed) => {
    if (seed) setAssistantSeed(seed);
    setAgentOpen(true);
  }, []);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const openSettings = useCallback((section?: SettingsSection) => setSettings(section ?? 'accounts'), []);

  useEffect(() => {
    if (!route.view) navigate('#/mail', true);
  }, [route.view, navigate]);

  useEffect(() => {
    if (!flash) return;
    toast({ tone: flash.tone === 'danger' ? 'error' : flash.tone === 'ok' ? 'ok' : 'info', message: flash.message, durationMs: 9000 });
    if (flash.tone !== 'info') setSettings('accounts');
    if (flash.tone === 'ok') refreshBoot();
    onFlashShown();
  }, [flash, toast, refreshBoot, onFlashShown]);

  // While the agent still has mail to sort, pick its work up quickly.
  const sorting = boot.capabilities.triage.available && boot.counts.agentQueue.sort + boot.counts.agentQueue.draft > 0;
  useEffect(() => {
    if (!sorting) return;
    const timer = setInterval(refreshBoot, 8000);
    return () => clearInterval(timer);
  }, [sorting, refreshBoot]);

  // Modifier shortcuts work even while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === 'j') {
        event.preventDefault();
        setAgentOpen((open) => !open);
      } else if (key === ',') {
        event.preventDefault();
        setSettings((current) => (current ? null : 'accounts'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // "G then M/C/T/F" is caught in the capture phase so the second key never reaches a view's own shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      if (Date.now() - chord.current < 1200) {
        chord.current = 0;
        const target = VIEWS.find((item) => item.key === key);
        if (target) {
          event.preventDefault();
          event.stopImmediatePropagation();
          navigate(routePath(target.view));
        }
      } else if (key === 'g') {
        chord.current = Date.now();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate]);

  useShortcuts((event) => {
    const key = event.key.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      void compose({ mode: 'new' });
    } else if (event.key === '?') {
      event.preventDefault();
      setShortcutsOpen(true);
    } else if (event.key === '/' && route.view !== 'mail') {
      event.preventDefault();
      setPaletteOpen(true);
    }
  });

  const value = useMemo<AppContextValue>(
    () => ({
      boot,
      auth,
      refreshBoot,
      patchBoot,
      account: (id) => (id ? byId.get(id) : undefined),
      scope,
      setScope: setScopeRaw,
      scopeParam: scope.length ? scope : undefined,
      scopeKey,
      route,
      navigate,
      toast,
      reportError,
      compose: (request) => void compose(request),
      ask,
      assistantSeed,
      setAssistantSeed,
      agentOpen,
      setAgentOpen,
      openPalette,
      openSettings,
      signOut,
    }),
    [boot, auth, refreshBoot, patchBoot, byId, scope, scopeKey, route, navigate, toast, reportError, compose, ask, assistantSeed, agentOpen, openPalette, openSettings, signOut],
  );

  const demo = boot.session.mode === 'demo';
  const counts = boot.counts;
  const user = boot.session.user;
  const attention = boot.connections.filter(needsAttention).length;
  const badges: Record<string, number> = { mail: counts.lanes.reply, tasks: counts.tasksDue };

  let view: ReactNode;
  if (boot.connections.length === 0) {
    const connect = boot.capabilities.googleConnect;
    view = (
      <div className="scroll">
        <EmptyState
          icon={<Mail size={24} />}
          title="Connect a Google account"
          action={
            connect.available ? (
              <a className="btn btn--primary" href={googleAuthUrl('connect', { features: ['mail', 'calendar', 'tasks'] })}>
                <span>Connect Google</span>
              </a>
            ) : undefined
          }
        >
          {connect.available
            ? 'Nothing is read until you connect an account. You can add the rest afterwards.'
            : (connect.reason ?? 'Google sign-in is not configured on this deployment.')}
        </EmptyState>
      </div>
    );
  } else {
    switch (route.view) {
      case '':
      case 'mail':
        view = <MailView view={route.args[0]} threadId={route.args[1]} />;
        break;
      case 'calendar':
        view = <CalendarView />;
        break;
      case 'tasks':
        view = <TasksView listId={route.args[0]} />;
        break;
      case 'files':
        view = <FilesView />;
        break;
      default:
        view = (
          <div className="scroll">
            <EmptyState title="Nothing here">
              Press <Kbd>⌘K</Kbd> to jump somewhere.
            </EmptyState>
          </div>
        );
    }
  }

  return (
    <AppProvider value={value}>
      <div className={clsx('app', agentOpen && 'app--agent')}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <nav className="rail" aria-label="Orbitdesk">
          <a className="rail__mark" href="#/mail" aria-label="Orbitdesk">
            <OrbitMark size={24} />
          </a>
          {demo && (
            <span className="rail__demo" title="Sandbox: accounts and mail are simulated. Nothing reaches Google or a real recipient.">
              demo
            </span>
          )}
          {VIEWS.map((item) => {
            const Icon = item.icon;
            const active = route.view === item.view || (item.view === 'mail' && route.view === '');
            const badge = badges[item.view] ?? 0;
            return (
              <a
                key={item.view}
                href={routePath(item.view)}
                className={clsx('rail__link', active && 'is-active')}
                aria-current={active ? 'page' : undefined}
                aria-label={badge ? `${item.label}, ${badge}` : item.label}
                title={`${item.label}  ·  G then ${item.key.toUpperCase()}`}
              >
                <Icon size={18} aria-hidden="true" />
                {badge > 0 && <span className="rail__badge">{badge > 99 ? '99+' : badge}</span>}
              </a>
            );
          })}
          <span className="rail__gap" />
          <button
            type="button"
            className={clsx('rail__link rail__link--agent', agentOpen && 'is-active')}
            aria-pressed={agentOpen}
            aria-label={counts.pendingActions ? `Agent, ${counts.pendingActions} waiting for you` : 'Agent'}
            title="Agent  ·  ⌘J"
            onClick={() => setAgentOpen(!agentOpen)}
          >
            <Sparkles size={18} aria-hidden="true" />
            {counts.pendingActions > 0 && <span className="rail__badge rail__badge--agent">{counts.pendingActions}</span>}
          </button>
          <Menu
            label="Account and settings"
            side="top"
            align="start"
            buttonClassName="rail__link"
            button={
              <>
                <span className="avatar" aria-hidden="true">
                  {initials(user.name || user.email)}
                </span>
                {attention > 0 && <span className="rail__badge rail__badge--warn">{attention}</span>}
              </>
            }
            items={[
              { label: 'Settings', hint: '⌘,', icon: <Settings2 size={15} />, onSelect: () => setSettings('accounts') },
              { label: 'Keyboard shortcuts', hint: '?', icon: <Keyboard size={15} />, onSelect: () => setShortcutsOpen(true) },
              { label: 'Switch theme', icon: <Moon size={15} />, onSelect: toggleTheme },
              'divider',
              { label: demo ? 'Leave the sandbox' : 'Sign out', icon: <LogOut size={15} />, onSelect: signOut },
            ]}
          />
        </nav>

        <main id="main" className="main" tabIndex={-1}>
          {bootStale && (
            <div className="notice notice--warn" role="status" style={{ borderRadius: 0 }}>
              <TriangleAlert size={14} aria-hidden="true" />
              <span className="notice__text">Counts may be out of date. {bootStale}</span>
              <button type="button" className="link-btn" onClick={refreshBoot}>
                Retry
              </button>
            </div>
          )}
          {view}
        </main>

        {agentOpen && <AgentPanel />}

        {composer && <Composer key={composer.key} ref={composerRef} request={composer} onClose={() => setComposer(null)} />}
        {paletteOpen && (
          <CommandPalette
            onClose={() => setPaletteOpen(false)}
            onShortcuts={() => setShortcutsOpen(true)}
            onToggleTheme={toggleTheme}
          />
        )}
        {settings && <Settings section={settings} onSection={setSettings} onClose={() => setSettings(null)} />}
        {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}

        <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
          {toasts.map((item) => (
            <div key={item.id} className={clsx('toast', `toast--${item.tone ?? 'info'}`)}>
              {item.tone === 'error' ? (
                <CircleX size={15} aria-hidden="true" />
              ) : item.tone === 'ok' ? (
                <CircleCheck size={15} aria-hidden="true" />
              ) : (
                <Info size={15} aria-hidden="true" />
              )}
              <span className="toast__msg">{item.message}</span>
              {item.action && (
                <button
                  type="button"
                  className="toast__action"
                  onClick={() => {
                    item.action?.run();
                    dismissToast(item.id);
                  }}
                >
                  {item.action.label}
                </button>
              )}
              <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </AppProvider>
  );
}

