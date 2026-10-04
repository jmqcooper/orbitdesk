'use client';

import clsx from 'clsx';
import {
  CalendarDays,
  CircleCheck,
  CircleX,
  FlaskConical,
  FolderOpen,
  Inbox,
  Info,
  ListChecks,
  LogOut,
  Menu as MenuIcon,
  MoreHorizontal,
  Plus,
  Repeat,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sun,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, googleAuthUrl, toApiError } from '@/lib/api';
import { initials } from '@/lib/format';
import { routePath, useHashRoute, useResource } from '@/lib/hooks';
import type { AuthConfig, Bootstrap, Id } from '@/lib/types';
import {
  AccountDot,
  AppProvider,
  type AppContextValue,
  type AssistantSeed,
  type ComposeRequest,
  type ToastInput,
} from './AppContext';
import { CommandPalette } from './CommandPalette';
import { Composer, type ComposerHandle } from './mail/Composer';
import { BootFailure, BootScreen, type AuthNotice } from './Boot';
import { EmptyState, Kbd, Menu, OrbitMark } from './ui';
import { ApprovalsView } from './views/ApprovalsView';
import { AssistantView } from './views/AssistantView';
import { AutomationsView } from './views/AutomationsView';
import { CalendarView } from './views/CalendarView';
import { ConnectionsView } from './views/ConnectionsView';
import { FilesView } from './views/FilesView';
import { InboxView } from './views/InboxView';
import { TasksView } from './views/TasksView';
import { TodayView } from './views/TodayView';

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

  if (boot.loading) return <BootScreen label="Loading your workspace" />;
  if (!boot.data) {
    return boot.error ? (
      <BootFailure
        error={boot.error}
        explanation="Your workspace could not be loaded. Nothing is shown rather than guessing."
        onRetry={boot.reload}
        onSignOut={signOut}
      />
    ) : (
      <BootScreen label="Loading your workspace" />
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

interface NavItem {
  view: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  countTone?: 'accent' | 'muted';
}

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

function Workspace({ boot, bootStale, auth, refreshBoot, patchBoot, flash, onFlashShown, signOut }: WorkspaceProps) {
  const { route, navigate } = useHashRoute();
  const [scopeRaw, setScopeRaw] = useState<Id[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [composer, setComposer] = useState<(ComposeRequest & { key: number }) | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [assistantSeed, setAssistantSeed] = useState<AssistantSeed | null>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const toastId = useRef(0);
  const composerKey = useRef(0);

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
      setToasts((list) => [...list.slice(-3), { ...input, id }]);
      window.setTimeout(() => dismissToast(id), input.durationMs ?? (input.tone === 'error' ? 9000 : 5200));
    },
    [dismissToast],
  );

  const reportError = useCallback(
    (error: unknown, what: string) => {
      const apiError = toApiError(error);
      toast({ tone: 'error', message: `${what}: ${apiError.message}` });
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

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  useEffect(() => {
    if (!route.view) navigate('#/today', true);
  }, [route.view, navigate]);

  useEffect(() => {
    setRailOpen(false);
  }, [route]);

  useEffect(() => {
    if (!flash) return;
    toast({ tone: flash.tone === 'danger' ? 'error' : flash.tone === 'ok' ? 'ok' : 'info', message: flash.message, durationMs: 9000 });
    if (flash.tone !== 'info') navigate('#/connections');
    if (flash.tone === 'ok') refreshBoot();
    onFlashShown();
  }, [flash, toast, navigate, refreshBoot, onFlashShown]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        if (document.querySelector('dialog[open]')) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
      assistantSeed,
      setAssistantSeed,
      openPalette,
      signOut,
    }),
    [boot, auth, refreshBoot, patchBoot, byId, scope, scopeKey, route, navigate, toast, reportError, compose, assistantSeed, openPalette, signOut],
  );

  const demo = boot.session.mode === 'demo';
  const counts = boot.counts;
  const nav: NavItem[] = [
    { view: 'today', label: 'Today', icon: Sun },
    { view: 'inbox', label: 'Inbox', icon: Inbox, count: counts.inboxUnread },
    { view: 'calendar', label: 'Calendar', icon: CalendarDays, count: counts.eventsToday, countTone: 'muted' },
    { view: 'tasks', label: 'Tasks', icon: ListChecks, count: counts.tasksDue, countTone: 'muted' },
    { view: 'assistant', label: 'Assistant', icon: Sparkles },
    { view: 'files', label: 'Files', icon: FolderOpen },
    { view: 'approvals', label: 'Approvals', icon: ShieldCheck, count: counts.pendingActions, countTone: 'accent' },
    { view: 'automations', label: 'Automations', icon: Repeat },
  ];
  const activeView = route.view === 'settings' ? 'connections' : route.view;

  const toggleAccount = (id: Id) => {
    if (scope.includes(id)) setScopeRaw(scope.filter((item) => item !== id));
    else setScopeRaw([...scope, id]);
  };

  const attention = boot.connections.filter((c) => c.status === 'reconnect_required' || c.status === 'error');
  const user = boot.session.user;

  let view: React.ReactNode;
  switch (route.view) {
    case '':
    case 'today':
      view = <TodayView />;
      break;
    case 'inbox':
      view = <InboxView folder={route.args[0]} threadId={route.args[1]} />;
      break;
    case 'calendar':
      view = <CalendarView />;
      break;
    case 'tasks':
      view = <TasksView listId={route.args[0]} />;
      break;
    case 'assistant':
      view = <AssistantView conversationId={route.args[0]} />;
      break;
    case 'files':
      view = <FilesView />;
      break;
    case 'approvals':
      view = <ApprovalsView tab={route.args[0]} />;
      break;
    case 'automations':
      view = <AutomationsView />;
      break;
    case 'connections':
    case 'settings':
      view = <ConnectionsView tab={route.view === 'settings' ? (route.args[0] ?? 'preferences') : route.args[0]} />;
      break;
    default:
      view = (
        <div className="view view--narrow">
          <EmptyState title="There’s nothing at this address">
            The link may be out of date. Use the navigation, or press <Kbd>⌘K</Kbd> to jump somewhere.
          </EmptyState>
        </div>
      );
  }

  return (
    <AppProvider value={value}>
      <div className={clsx('shell', railOpen && 'shell--rail-open', demo && 'shell--demo')}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>

        <aside className="rail" aria-label="Workspace">
          <div className="rail__head">
            <a className="wordmark wordmark--rail" href="#/today">
              <OrbitMark size={24} />
              <span>Orbitdesk</span>
            </a>
            <button type="button" className="icon-btn rail__close" aria-label="Close navigation" onClick={() => setRailOpen(false)}>
              <X size={18} />
            </button>
          </div>

          <div className={clsx('mode', demo ? 'mode--demo' : 'mode--real')}>
            {demo ? <FlaskConical size={13} aria-hidden="true" /> : <span className="mode__dot" aria-hidden="true" />}
            <span>{demo ? 'Sandbox demo · simulated data' : 'Live · your Google accounts'}</span>
          </div>

          <nav className="rail__nav" aria-label="Views">
            {nav.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.view || (item.view === 'today' && activeView === '');
              return (
                <a
                  key={item.view}
                  href={routePath(item.view)}
                  className={clsx('rail__link', active && 'is-active')}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span className="rail__link-label">{item.label}</span>
                  {item.count ? (
                    <span className={clsx('rail__count', item.countTone && `rail__count--${item.countTone}`)}>
                      {item.count > 999 ? '999+' : item.count}
                    </span>
                  ) : null}
                </a>
              );
            })}
          </nav>

          <div className="rail__section">
            <div className="rail__section-head">
              <span>Accounts</span>
              {scope.length > 0 && (
                <button type="button" className="rail__reset" onClick={() => setScopeRaw([])}>
                  Show all
                </button>
              )}
            </div>
            {boot.connections.length === 0 ? (
              <p className="rail__empty">No Google accounts are connected yet.</p>
            ) : (
              <ul className="rail__accounts" aria-label="Filter by account">
                {boot.connections.map((connection) => {
                  const selected = scope.length === 0 || scope.includes(connection.id);
                  const pressed = scope.includes(connection.id);
                  const unread = counts.unreadByAccount[connection.id] ?? 0;
                  const bad = connection.status === 'reconnect_required' || connection.status === 'error';
                  return (
                    <li key={connection.id}>
                      <button
                        type="button"
                        className={clsx('rail__account', !selected && 'is-dim', pressed && 'is-pressed')}
                        aria-pressed={pressed}
                        title={`${connection.email}${bad && connection.statusDetail ? ` — ${connection.statusDetail}` : ''}`}
                        onClick={() => toggleAccount(connection.id)}
                      >
                        <AccountDot account={connection} size={9} />
                        <span className="rail__account-text">
                          <span className="rail__account-label">{connection.label}</span>
                          <span className="rail__account-email">{connection.email}</span>
                        </span>
                        {bad ? (
                          <TriangleAlert size={14} className="rail__account-warn" aria-label="Needs attention" />
                        ) : unread ? (
                          <span className="rail__count rail__count--muted">{unread}</span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <a className="rail__add" href="#/connections">
              <Plus size={15} aria-hidden="true" />
              <span>Add or manage accounts</span>
            </a>
          </div>

          <div className="rail__foot">
            <a
              href="#/connections"
              className={clsx('rail__link', activeView === 'connections' && 'is-active')}
              aria-current={activeView === 'connections' ? 'page' : undefined}
            >
              <Settings2 size={17} aria-hidden="true" />
              <span className="rail__link-label">Connections &amp; settings</span>
              {attention.length > 0 && <span className="rail__count rail__count--warn">{attention.length}</span>}
            </a>
            <div className="rail__user">
              <span className="avatar avatar--rail" aria-hidden="true">
                {initials(user.name || user.email)}
              </span>
              <span className="rail__user-text">
                <span className="rail__user-name">{user.name || user.email}</span>
                <span className="rail__user-email">{demo ? 'Demo session' : user.email}</span>
              </span>
              <Menu
                label="Account menu"
                side="top"
                align="end"
                buttonClassName="icon-btn icon-btn--rail"
                button={<MoreHorizontal size={17} />}
                items={[
                  { label: 'Preferences', icon: <Settings2 size={15} />, onSelect: () => navigate('#/settings') },
                  { label: 'Privacy policy', icon: <Info size={15} />, onSelect: () => window.open('/privacy', '_blank', 'noopener') },
                  { label: 'Terms', icon: <Info size={15} />, onSelect: () => window.open('/terms', '_blank', 'noopener') },
                  'divider',
                  { label: demo ? 'Leave the sandbox' : 'Sign out', icon: <LogOut size={15} />, onSelect: signOut },
                ]}
              />
            </div>
          </div>
        </aside>
        <div className="rail-scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />

        <div className="work">
          {demo && (
            <div className="demo-strip" role="note">
              <FlaskConical size={14} aria-hidden="true" />
              <span>
                <strong>Sandbox demo.</strong> Accounts, mail and calendars here are simulated. Nothing reaches Google
                or a real recipient.
              </span>
              {auth.google.available && (
                <a className="demo-strip__link" href={googleAuthUrl('login')}>
                  Sign in with Google
                </a>
              )}
            </div>
          )}

          <header className="topbar">
            <button type="button" className="icon-btn topbar__menu" aria-label="Open navigation" onClick={() => setRailOpen(true)}>
              <MenuIcon size={19} />
            </button>
            <button type="button" className="searchbar" onClick={openPalette} aria-label="Search or run a command">
              <Search size={16} aria-hidden="true" />
              <span className="searchbar__text">Search mail, tasks and files, or jump to…</span>
              <Kbd>⌘K</Kbd>
            </button>
            <div className="topbar__scope" title="Set with the account list in the sidebar">
              {scope.length === 0
                ? boot.connections.length === 1
                  ? '1 account'
                  : `All ${boot.connections.length} accounts`
                : `${scope.length} of ${boot.connections.length} accounts`}
            </div>
            {counts.pendingActions > 0 && (
              <a className="topbar__approvals" href="#/approvals">
                <ShieldCheck size={15} aria-hidden="true" />
                <span>
                  {counts.pendingActions} to approve
                </span>
              </a>
            )}
            <button type="button" className="btn btn--accent topbar__compose" onClick={() => void compose({ mode: 'new' })}>
              <SquarePen size={15} aria-hidden="true" />
              <span>Compose</span>
            </button>
          </header>

          {bootStale && (
            <div className="notice notice--warn notice--flush" role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">Counts and account status may be out of date. {bootStale}</span>
              <button type="button" className="link-btn" onClick={refreshBoot}>
                Retry
              </button>
            </div>
          )}

          <main id="main" className="work__main" tabIndex={-1}>
            {view}
          </main>
        </div>

        <nav className="tabbar" aria-label="Primary">
          {nav.slice(0, 5).map((item) => {
            const Icon = item.icon;
            const active = activeView === item.view;
            return (
              <a key={item.view} href={routePath(item.view)} className={clsx('tabbar__item', active && 'is-active')} aria-current={active ? 'page' : undefined}>
                <Icon size={19} aria-hidden="true" />
                <span>{item.label}</span>
                {item.count && item.view === 'inbox' ? <span className="tabbar__dot" aria-label={`${item.count} unread`} /> : null}
              </a>
            );
          })}
          <button type="button" className="tabbar__item" onClick={() => setRailOpen(true)}>
            <MenuIcon size={19} aria-hidden="true" />
            <span>More</span>
          </button>
        </nav>

        {composer && (
          <Composer key={composer.key} ref={composerRef} request={composer} onClose={() => setComposer(null)} />
        )}

        {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}

        <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
          {toasts.map((item) => (
            <div key={item.id} className={clsx('toast', `toast--${item.tone ?? 'info'}`)}>
              {item.tone === 'error' ? (
                <CircleX size={16} aria-hidden="true" />
              ) : item.tone === 'ok' ? (
                <CircleCheck size={16} aria-hidden="true" />
              ) : (
                <Info size={16} aria-hidden="true" />
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
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </AppProvider>
  );
}
