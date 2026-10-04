'use client';

import clsx from 'clsx';
import { format } from 'date-fns';
import {
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  FolderOpen,
  ListChecks,
  Mail,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Unplug,
  Users,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { canAct, canWriteCalendar, hasPermission, needsAttention } from '@/lib/accounts';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import { browserTimezone, formatBytes, parseDate, plural, relativeTime, safeColor, sameEmail, titleCase } from '@/lib/format';
import { invalidate, routePath, useResource } from '@/lib/hooks';
import type {
  Connection,
  ConnectionGroup,
  ConnectionPermission,
  ConnectionUpdateRequest,
  PermissionState,
  ResourceKind,
  Settings,
} from '@/lib/types';
import { useApp } from '../AppContext';
import {
  Button,
  ConfirmDialog,
  DayPicker,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  LoadingBlock,
  Notice,
  Pill,
  Spinner,
  Tabs,
  Toggle,
  ViewHeader,
  type Tone,
} from '../ui';

type TabId = 'accounts' | 'preferences' | 'data';

const RESOURCE_META: Record<ResourceKind, { label: string; icon: LucideIcon; what: string }> = {
  mail: { label: 'Gmail', icon: Mail, what: 'Read, draft, send, label and archive mail' },
  calendar: { label: 'Calendar', icon: CalendarDays, what: 'Read and manage events, check availability' },
  tasks: { label: 'Tasks', icon: ListChecks, what: 'Read and manage task lists and tasks' },
  contacts: { label: 'Contacts', icon: Users, what: 'Suggest recipients from your contacts (read only)' },
  files: { label: 'Drive files', icon: FolderOpen, what: 'Open files you choose and create new ones' },
};
const RESOURCE_ORDER: ResourceKind[] = ['mail', 'calendar', 'tasks', 'contacts', 'files'];

const PERMISSION_META: Record<PermissionState, { label: string; tone: Tone }> = {
  granted: { label: 'Granted', tone: 'ok' },
  denied: { label: 'Denied', tone: 'danger' },
  not_requested: { label: 'Not requested', tone: 'neutral' },
  admin_restricted: { label: 'Blocked by admin', tone: 'warn' },
};

const STATUS_META: Record<Connection['status'], { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'ok' },
  syncing: { label: 'Syncing', tone: 'info' },
  reconnect_required: { label: 'Reconnect required', tone: 'danger' },
  error: { label: 'Error', tone: 'danger' },
  paused: { label: 'Paused', tone: 'warn' },
};

const GROUPS: ConnectionGroup[] = ['personal', 'company', 'client', 'other'];
const SWATCHES = ['#2f7f79', '#3d6aa8', '#b0762a', '#8a4f6d', '#5d7a3a', '#a2543e', '#52618c', '#7a6a4f', '#c2553a', '#3f8a5c'];

export function ConnectionsView({ tab }: { tab?: string }) {
  const { navigate, boot } = useApp();
  const active: TabId = tab === 'preferences' || tab === 'data' ? tab : 'accounts';
  const attention = boot.connections.filter(needsAttention).length;

  return (
    <div className="view view--narrow">
      <ViewHeader
        kicker="Connections & settings"
        title={active === 'accounts' ? 'Google accounts' : active === 'preferences' ? 'Preferences' : 'Data & privacy'}
      >
        {active === 'accounts' &&
          'Each account is linked through its own Google consent screen. One failing account never blocks the others.'}
        {active === 'preferences' && 'Defaults for time, scheduling and where new mail, events and tasks go.'}
        {active === 'data' && 'What Orbitdesk keeps, how the service is doing, and how to remove everything.'}
      </ViewHeader>

      <Tabs
        label="Settings sections"
        value={active}
        onChange={(id) => navigate(id === 'accounts' ? '#/connections' : routePath('settings', id))}
        tabs={[
          { id: 'accounts', label: 'Accounts', count: attention || null },
          { id: 'preferences', label: 'Preferences' },
          { id: 'data', label: 'Data & privacy' },
        ]}
      />

      {active === 'accounts' && <AccountsTab />}
      {active === 'preferences' && <PreferencesTab />}
      {active === 'data' && <DataTab />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

function AccountsTab() {
  const { boot, patchBoot } = useApp();
  const anySyncing = boot.connections.some((c) => c.status === 'syncing');
  const live = useResource('connections', (signal) => api.connections({ signal }), {
    refreshMs: anySyncing ? 4_000 : 60_000,
  });
  const [adding, setAdding] = useState(false);
  const connect = boot.capabilities.googleConnect;
  const max = boot.capabilities.limits.maxAccounts;

  // The list endpoint is the freshest view of sync state; keep the rest of the app in step with it.
  useEffect(() => {
    const items = live.data?.items;
    if (items) patchBoot((current) => ({ ...current, connections: items }));
  }, [live.data, patchBoot]);

  const connections = live.data?.items ?? boot.connections;
  const atLimit = max !== null && connections.length >= max;

  return (
    <div className="conns">
      <div className="conns__bar">
        <p className="conns__count">
          {plural(connections.length, 'account')} connected{max !== null ? ` of ${max} allowed` : ''}
          {live.refreshing && <Spinner size={13} label="Refreshing" />}
        </p>
        <Button
          variant="primary"
          icon={<Plus size={15} />}
          disabled={!connect.available || atLimit}
          onClick={() => setAdding(true)}
        >
          Add Google account
        </Button>
      </div>

      {!connect.available && (
        <Notice tone={boot.session.mode === 'demo' ? 'info' : 'warn'}>
          <strong>Linking Google accounts is unavailable.</strong>{' '}
          {connect.reason ??
            (boot.session.mode === 'demo'
              ? 'The sandbox uses simulated accounts. Sign in with Google to link real ones.'
              : 'The Google OAuth client is not configured on this deployment.')}
        </Notice>
      )}
      {connect.available && atLimit && (
        <Notice tone="info">This workspace has reached its limit of {max} connected accounts.</Notice>
      )}
      {connect.available && connect.reason && <Notice tone="info">{connect.reason}</Notice>}
      {live.error && (
        <Notice tone="warn" action={<button type="button" className="link-btn" onClick={live.reload}>Retry</button>}>
          Account status could not be refreshed, so it may be out of date. {live.error.message}
        </Notice>
      )}

      {connections.length === 0 ? (
        <EmptyState icon={<Unplug size={22} />} title="No Google accounts connected">
          Add an account to bring its mail, calendar and tasks into Orbitdesk.
        </EmptyState>
      ) : (
        connections.map((connection) => (
          <ConnectionCard
            key={connection.id}
            connection={connection}
            startOpen={needsAttention(connection) || connections.length <= 2}
            onUpdated={(updated) => {
              live.mutate((current) => ({ ...current, items: current.items.map((c) => (c.id === updated.id ? updated : c)) }));
              patchBoot((current) => ({ ...current, connections: current.connections.map((c) => (c.id === updated.id ? updated : c)) }));
            }}
            onRemoved={(id) => {
              live.mutate((current) => ({ ...current, items: current.items.filter((c) => c.id !== id) }));
              patchBoot((current) => ({ ...current, connections: current.connections.filter((c) => c.id !== id) }));
            }}
          />
        ))
      )}

      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const [features, setFeatures] = useState<ResourceKind[]>(['mail', 'calendar', 'tasks']);
  const [leaving, setLeaving] = useState(false);
  const toggle = (resource: ResourceKind) =>
    setFeatures((current) => (current.includes(resource) ? current.filter((r) => r !== resource) : [...current, resource]));

  return (
    <Dialog
      title="Add a Google account"
      onClose={onClose}
      kicker="You will be sent to Google to choose the account and approve access."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <a
            className={clsx('btn btn--primary', (features.length === 0 || leaving) && 'is-disabled')}
            aria-disabled={features.length === 0 || leaving}
            href={features.length ? googleAuthUrl('connect', { features }) : undefined}
            onClick={() => setLeaving(true)}
          >
            {leaving && <Spinner size={14} />}
            <span>Continue to Google</span>
          </a>
        </>
      }
    >
      <div className="form">
        <p className="prose-sm">
          Linking another account does not change who you are signed in as. Choose what Orbitdesk may ask this account
          for — you can add or remove areas later.
        </p>
        <fieldset className="featurelist">
          <legend className="field__label">Ask for access to</legend>
          {RESOURCE_ORDER.map((resource) => {
            const meta = RESOURCE_META[resource];
            const Icon = meta.icon;
            return (
              <label key={resource} className="featurelist__item">
                <input type="checkbox" checked={features.includes(resource)} onChange={() => toggle(resource)} />
                <Icon size={15} aria-hidden="true" />
                <span>
                  <strong>{meta.label}</strong>
                  <span className="featurelist__what">{meta.what}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <Notice tone="info">
          While Orbitdesk is in Google’s testing mode, access expires after seven days and the account has to be
          reconnected. Scheduled actions for that account pause until then.
        </Notice>
      </div>
    </Dialog>
  );
}

function ConnectionCard({
  connection,
  startOpen,
  onUpdated,
  onRemoved,
}: {
  connection: Connection;
  startOpen: boolean;
  onUpdated: (connection: Connection) => void;
  onRemoved: (id: string) => void;
}) {
  const { boot, toast, reportError, refreshBoot } = useApp();
  const [open, setOpen] = useState(startOpen);
  const [label, setLabel] = useState(connection.label);
  const [signature, setSignature] = useState(connection.signature ?? '');
  const [writing, setWriting] = useState(connection.writingPreferences ?? '');
  const [busy, setBusy] = useState<null | 'sync' | 'save' | 'toggle' | 'remove'>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const status = STATUS_META[connection.status] ?? { label: connection.status, tone: 'neutral' as Tone };
  const connect = boot.capabilities.googleConnect;
  const granted = connection.permissions.filter((p) => p.state === 'granted').map((p) => p.resource);
  const textDirty =
    label.trim() !== connection.label ||
    signature !== (connection.signature ?? '') ||
    writing !== (connection.writingPreferences ?? '');

  const patch = async (body: ConnectionUpdateRequest, kind: 'save' | 'toggle') => {
    setBusy(kind);
    setError(null);
    try {
      const updated = await api.updateConnection(connection.id, body);
      onUpdated(updated);
      if (kind === 'save') toast({ tone: 'ok', message: `${updated.label} saved.` });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      onUpdated(await api.syncConnection(connection.id));
      invalidate('connections');
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      const result = await api.deleteConnection(connection.id);
      onRemoved(result.id);
      invalidate('threads', 'events', 'tasks', 'actions', 'brief', 'drafts', 'files');
      refreshBoot();
      toast({
        message: `${connection.email} disconnected.${result.canceledActions ? ` ${plural(result.canceledActions, 'pending action')} cancelled.` : ''}`,
      });
    } catch (err) {
      reportError(err, 'Could not disconnect the account');
      setBusy(null);
      setConfirming(false);
    }
  };

  const permissionFor = (resource: ResourceKind): ConnectionPermission =>
    connection.permissions.find((p) => p.resource === resource) ?? {
      resource,
      state: 'not_requested',
      scopes: [],
      detail: null,
    };

  return (
    <article className={clsx('conn', needsAttention(connection) && 'conn--attention')} aria-label={connection.email}>
      <header className="conn__head">
        <span className="conn__dot" style={{ background: safeColor(connection.color, connection.id) }} aria-hidden="true" />
        <button type="button" className="conn__titlebtn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="conn__label">{connection.label}</span>
          <span className="conn__email">{connection.email}</span>
        </button>
        <span className="conn__pills">
          {connection.demo && <Pill tone="warn">Demo</Pill>}
          {connection.isLogin && <Pill>Sign-in identity</Pill>}
          <Pill>{connection.kind === 'workspace' ? 'Workspace' : 'Personal'}</Pill>
          <Pill tone={status.tone}>{status.label}</Pill>
        </span>
        <button type="button" className="icon-btn" onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
        </button>
      </header>

      <div className="conn__summary">
        <span>
          Last synced {connection.lastSyncAt ? relativeTime(connection.lastSyncAt) : 'never'}
          {parseDate(connection.lastSyncAt) ? ` · ${format(parseDate(connection.lastSyncAt)!, 'MMM d, HH:mm')}` : ''}
        </span>
        <span className="conn__perms" aria-label="Permissions">
          {RESOURCE_ORDER.map((resource) => {
            const permission = permissionFor(resource);
            const Icon = RESOURCE_META[resource].icon;
            return (
              <span
                key={resource}
                className={clsx('conn__perm', `conn__perm--${permission.state}`)}
                title={`${RESOURCE_META[resource].label}: ${PERMISSION_META[permission.state]?.label ?? permission.state}`}
              >
                <Icon size={13} aria-hidden="true" />
              </span>
            );
          })}
        </span>
        <span className="conn__buttons">
          {connection.status === 'reconnect_required' &&
            (connect.available ? (
              <a className="btn btn--accent btn--sm" href={googleAuthUrl('connect', { accountId: connection.id, features: granted.length ? granted : undefined })}>
                <RefreshCw size={14} aria-hidden="true" />
                <span>Reconnect</span>
              </a>
            ) : (
              <span className="conn__muted">Reconnecting is unavailable here</span>
            ))}
          <Button
            size="sm"
            icon={<RotateCw size={14} />}
            busy={busy === 'sync' || connection.status === 'syncing'}
            disabled={busy !== null || connection.status === 'reconnect_required'}
            onClick={sync}
          >
            {connection.status === 'syncing' ? 'Syncing' : 'Sync now'}
          </Button>
        </span>
      </div>

      {connection.statusDetail && connection.status !== 'active' && (
        <Notice tone={connection.status === 'syncing' ? 'info' : 'warn'} icon={<TriangleAlert size={15} aria-hidden="true" />}>
          {connection.statusDetail}
        </Notice>
      )}
      {error && (
        <Notice tone="danger">
          {error.message} <span className="mono-note">({error.code})</span>
        </Notice>
      )}

      {open && (
        <div className="conn__body">
          <section className="conn__block">
            <h3 className="conn__h">Permissions</h3>
            <table className="ptable">
              <tbody>
                {RESOURCE_ORDER.map((resource) => {
                  const permission = permissionFor(resource);
                  const meta = RESOURCE_META[resource];
                  const state = PERMISSION_META[permission.state] ?? { label: permission.state, tone: 'neutral' as Tone };
                  const Icon = meta.icon;
                  return (
                    <tr key={resource}>
                      <th scope="row">
                        <Icon size={14} aria-hidden="true" /> {meta.label}
                      </th>
                      <td>
                        <Pill tone={state.tone}>{state.label}</Pill>
                      </td>
                      <td className="ptable__detail">
                        {permission.detail ?? meta.what}
                        {permission.scopes.length > 0 && (
                          <details className="ptable__scopes">
                            <summary>{plural(permission.scopes.length, 'scope')}</summary>
                            <ul>
                              {permission.scopes.map((scope) => (
                                <li key={scope}>
                                  <code>{scope}</code>
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                      <td className="ptable__action">
                        {permission.state !== 'granted' &&
                          permission.state !== 'admin_restricted' &&
                          connect.available && (
                            <a
                              className="link-btn"
                              href={googleAuthUrl('connect', {
                                accountId: connection.id,
                                features: Array.from(new Set([...granted, resource])),
                              })}
                            >
                              Grant
                            </a>
                          )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="conn__block">
            <h3 className="conn__h">Sync</h3>
            <table className="ptable">
              <tbody>
                {connection.sync.map((entry) => {
                  const Icon = entry.status === 'ok' ? CircleCheck : entry.status === 'error' ? CircleX : CircleDashed;
                  return (
                    <tr key={entry.resource} className={clsx(entry.status === 'error' && 'ptable__row--error')}>
                      <th scope="row">{RESOURCE_META[entry.resource].label}</th>
                      <td>
                        <span className={clsx('syncstate', `syncstate--${entry.status}`)}>
                          <Icon size={13} aria-hidden="true" />{' '}
                          {entry.status === 'ok' ? 'Up to date' : entry.status === 'never' ? 'Not synced yet' : titleCase(entry.status)}
                        </span>
                      </td>
                      <td className="ptable__detail">
                        {entry.lastSuccessAt ? `Last success ${relativeTime(entry.lastSuccessAt)}` : 'No successful sync yet'}
                        {entry.error && <span className="ptable__error"> — {entry.error}</span>}
                      </td>
                    </tr>
                  );
                })}
                {connection.sync.length === 0 && (
                  <tr>
                    <td className="ptable__detail">The server reported no sync state for this account.</td>
                  </tr>
                )}
              </tbody>
            </table>
            <p className="conn__note">
              Mail from the last {boot.capabilities.limits.mailCacheDays} days is cached for speed. Older mail is fetched
              from Google when you search or open it.
            </p>
          </section>

          <section className="conn__block conn__block--form">
            <h3 className="conn__h">Identity in Orbitdesk</h3>
            <div className="form__row">
              <Field label="Label">
                <input className="input" type="text" value={label} maxLength={40} onChange={(e) => setLabel(e.target.value)} />
              </Field>
              <Field label="Group">
                <select
                  className="input"
                  value={connection.group}
                  disabled={busy !== null}
                  onChange={(e) => void patch({ group: e.target.value as ConnectionGroup }, 'toggle')}
                >
                  {GROUPS.map((group) => (
                    <option key={group} value={group}>
                      {titleCase(group)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="field">
              <span className="field__label">Color</span>
              <div className="swatches" role="group" aria-label="Account color">
                {SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={clsx('swatch', connection.color.toLowerCase() === color && 'is-on')}
                    style={{ background: color }}
                    aria-label={`Use color ${color}`}
                    aria-pressed={connection.color.toLowerCase() === color}
                    disabled={busy !== null}
                    onClick={() => void patch({ color }, 'toggle')}
                  />
                ))}
              </div>
            </div>
            {connection.sendAs.length > 0 && (
              <div className="field">
                <span className="field__label">Send-as identities</span>
                <ul className="conn__sendas">
                  {connection.sendAs.map((identity) => (
                    <li key={identity.email}>
                      {identity.name ? `${identity.name} <${identity.email}>` : identity.email}
                      {identity.isDefault && <Pill>Default</Pill>}
                      {sameEmail(identity.email, connection.email) ? '' : <span className="conn__muted"> alias</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="conn__block conn__block--form">
            <h3 className="conn__h">
              <Sparkles size={14} aria-hidden="true" /> Assistant
            </h3>
            <div className="toggle-row">
              <Toggle
                checked={connection.assistantAccess}
                label={`Let the assistant read ${connection.label}`}
                disabled={busy !== null}
                onChange={(next) => void patch({ assistantAccess: next }, 'toggle')}
              />
              <span>
                Let the assistant read this account
                <span className="toggle-row__note">
                  {connection.assistantAccess
                    ? 'It can be selected for questions and automations. Outgoing actions still need approval.'
                    : 'The assistant and automations cannot read or act on this account.'}
                </span>
              </span>
            </div>
            <Field label="Writing preferences" hint="Tone and habits for drafts from this account, e.g. “brief, first names, British spelling”.">
              <textarea className="input input--area" rows={2} value={writing} onChange={(e) => setWriting(e.target.value)} />
            </Field>
            <Field label="Signature" hint="Added to new messages and replies written from this account.">
              <textarea className="input input--area" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} />
            </Field>
          </section>

          <footer className="conn__foot">
            <Button variant="ghost" icon={<Unplug size={15} />} disabled={busy !== null} onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
            <span className="conn__foot-gap" />
            <Button
              variant="primary"
              busy={busy === 'save'}
              disabled={busy !== null || !textDirty || !label.trim()}
              onClick={() =>
                void patch(
                  { label: label.trim(), signature: signature.trim() ? signature : null, writingPreferences: writing.trim() ? writing : null },
                  'save',
                )
              }
            >
              Save changes
            </Button>
          </footer>
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Disconnect ${connection.email}?`}
          confirmLabel="Disconnect account"
          danger
          busy={busy === 'remove'}
          onClose={() => setConfirming(false)}
          onConfirm={remove}
        >
          <p>Orbitdesk will:</p>
          <ul>
            <li>revoke its access to this Google account where Google allows it,</li>
            <li>cancel every pending or scheduled action for this account,</li>
            <li>remove this account’s cached mail, events and tasks from Orbitdesk.</li>
          </ul>
          <p>Nothing in Gmail, Calendar or Tasks is deleted. You can connect the account again at any time.</p>
          {connection.isLogin && (
            <p>
              <strong>This is the account you sign in with.</strong> If it is your only connection, delete your Orbitdesk
              account from Data &amp; privacy instead.
            </p>
          )}
        </ConfirmDialog>
      )}
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Preferences                                                         */
/* ------------------------------------------------------------------ */

function timezones(current: string): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

function PreferencesTab() {
  const { boot, account, patchBoot, toast } = useApp();
  const [form, setForm] = useState<Settings>(boot.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const dirty = JSON.stringify(form) !== JSON.stringify(boot.settings);
  const zone = browserTimezone();

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const save = async () => {
    if (form.workingHours.start >= form.workingHours.end) {
      setError(new ApiRequestError('validation_failed', 'Working hours have to end after they start.', 0, ''));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateSettings(form);
      patchBoot((current) => ({ ...current, settings: result.settings, calendars: result.calendars }));
      setForm(result.settings);
      invalidate('brief', 'events');
      toast({ tone: 'ok', message: 'Preferences saved.' });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const mailAccounts = boot.connections.filter((c) => hasPermission(c, 'mail'));
  const calendars = boot.calendars.filter(canWriteCalendar);
  const contactsGranted = boot.connections.filter((c) => canAct(c, 'contacts')).length;

  return (
    <form
      className="prefs"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <section className="prefs__block">
        <h2 className="prefs__h">Time</h2>
        <div className="form__row">
          <Field
            label="Time zone"
            hint={
              form.timezone !== zone ? (
                <>
                  Your browser is in {zone}.{' '}
                  <button type="button" className="link-btn" onClick={() => set('timezone', zone)}>
                    Use it
                  </button>
                </>
              ) : (
                'Used for the daily brief, schedules and availability.'
              )
            }
          >
            <select className="input" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {timezones(form.timezone).map((tz) => (
                <option key={tz} value={tz}>
                  {tz.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Week starts on">
            <select className="input" value={form.weekStartsOn} onChange={(e) => set('weekStartsOn', Number(e.target.value) === 0 ? 0 : 1)}>
              <option value={1}>Monday</option>
              <option value={0}>Sunday</option>
            </select>
          </Field>
        </div>
      </section>

      <section className="prefs__block">
        <h2 className="prefs__h">Scheduling</h2>
        <div className="field">
          <span className="field__label">Working days</span>
          <DayPicker label="Working days" value={form.workingHours.days} onChange={(days) => set('workingHours', { ...form.workingHours, days })} />
        </div>
        <div className="form__row form__row--4">
          <Field label="From">
            <input className="input" type="time" value={form.workingHours.start} onChange={(e) => set('workingHours', { ...form.workingHours, start: e.target.value })} />
          </Field>
          <Field label="Until">
            <input className="input" type="time" value={form.workingHours.end} onChange={(e) => set('workingHours', { ...form.workingHours, end: e.target.value })} />
          </Field>
          <Field label="Buffer around meetings" hint="Minutes">
            <input
              className="input"
              type="number"
              min={0}
              max={120}
              step={5}
              value={form.meetingBufferMinutes}
              onChange={(e) => set('meetingBufferMinutes', Math.max(0, Math.min(120, Number(e.target.value) || 0)))}
            />
          </Field>
          <Field label="Default meeting length">
            <select className="input" value={form.defaultMeetingMinutes} onChange={(e) => set('defaultMeetingMinutes', Number(e.target.value))}>
              {Array.from(new Set([15, 30, 45, 60, 90, form.defaultMeetingMinutes]))
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {m} minutes
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <p className="prefs__note">
          Which calendars count toward availability is set per calendar, under Calendars in the calendar view.
        </p>
      </section>

      <section className="prefs__block">
        <h2 className="prefs__h">Where new things go</h2>
        <div className="form__row form__row--3">
          <Field label="New mail is sent from">
            <select className="input" value={form.defaultAccountId ?? ''} onChange={(e) => set('defaultAccountId', e.target.value || null)}>
              <option value="">Ask each time (first account)</option>
              {mailAccounts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} — {c.email}
                </option>
              ))}
            </select>
          </Field>
          <Field label="New events go to">
            <select className="input" value={form.defaultCalendarId ?? ''} onChange={(e) => set('defaultCalendarId', e.target.value || null)}>
              <option value="">First primary calendar</option>
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {account(c.accountId)?.label ?? 'account'}
                </option>
              ))}
            </select>
          </Field>
          <Field label="New tasks go to">
            <select className="input" value={form.defaultTaskListId ?? ''} onChange={(e) => set('defaultTaskListId', e.target.value || null)}>
              <option value="">First default list</option>
              {boot.taskLists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} — {account(l.accountId)?.label ?? 'account'}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="prefs__block">
        <h2 className="prefs__h">Mail</h2>
        <div className="toggle-row">
          <Toggle checked={form.loadRemoteImages} onChange={(next) => set('loadRemoteImages', next)} label="Load remote images automatically" />
          <span>
            Load remote images automatically
            <span className="toggle-row__note">
              Off by default: senders can use images to see when and where you opened a message. You can still show
              them per message.
            </span>
          </span>
        </div>
        <div className="toggle-row">
          <Toggle checked={form.contactLookup} onChange={(next) => set('contactLookup', next)} label="Suggest recipients from Google Contacts" />
          <span>
            Suggest recipients from Google Contacts
            <span className="toggle-row__note">
              {contactsGranted > 0
                ? `${plural(contactsGranted, 'account')} granted contacts access. Suggestions stay within the sending account.`
                : 'No account has granted contacts access yet. Until one does, suggestions come from people in recent mail.'}
            </span>
          </span>
        </div>
      </section>

      {error && (
        <Notice tone="danger">
          {error.message} <span className="mono-note">({error.code})</span>
        </Notice>
      )}
      <div className="prefs__foot">
        <span className="prefs__state">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</span>
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => setForm(boot.settings)}>
          Reset
        </Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
          Save preferences
        </Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Data & privacy                                                      */
/* ------------------------------------------------------------------ */

function DataTab() {
  const { boot } = useApp();
  const health = useResource('health', (signal) => api.health({ signal }), { refreshMs: 60_000 });
  const [deleting, setDeleting] = useState(false);
  const session = boot.session;
  const caps = boot.capabilities;

  const check = (ok: boolean, okText: string, badText: string) => (
    <span className={clsx('syncstate', ok ? 'syncstate--ok' : 'syncstate--error')}>
      {ok ? <CircleCheck size={13} aria-hidden="true" /> : <CircleX size={13} aria-hidden="true" />} {ok ? okText : badText}
    </span>
  );

  return (
    <div className="prefs">
      <section className="prefs__block">
        <h2 className="prefs__h">
          System status
          <button type="button" className="link-btn" onClick={health.reload}>
            Check again
          </button>
        </h2>
        {health.loading && <LoadingBlock label="Checking the service" />}
        {health.error && !health.data && <ErrorState compact error={health.error} onRetry={health.reload} />}
        {health.data && (
          <table className="ptable">
            <tbody>
              <tr>
                <th scope="row">Overall</th>
                <td>
                  <Pill tone={health.data.status === 'ok' ? 'ok' : health.data.status === 'degraded' ? 'warn' : 'danger'}>
                    {titleCase(health.data.status)}
                  </Pill>
                </td>
                <td className="ptable__detail">
                  Version {health.data.version} · checked {relativeTime(health.data.time)}
                </td>
              </tr>
              <tr>
                <th scope="row">Database</th>
                <td>{check(health.data.checks.database === 'ok', 'Reachable', 'Down')}</td>
                <td className="ptable__detail">Stores connections, the mail cache and action history.</td>
              </tr>
              <tr>
                <th scope="row">Background worker</th>
                <td>
                  {health.data.checks.worker === 'unknown' ? (
                    <span className="syncstate">
                      <CircleDashed size={13} aria-hidden="true" /> Unknown
                    </span>
                  ) : (
                    check(health.data.checks.worker === 'ok', 'Running', 'Heartbeat is stale')
                  )}
                </td>
                <td className="ptable__detail">Runs sync, scheduled sends and automations.</td>
              </tr>
              <tr>
                <th scope="row">Google sign-in</th>
                <td>{check(health.data.checks.googleOAuth === 'configured', 'Configured', 'Not configured')}</td>
                <td className="ptable__detail">Needed to sign in and to link real Google accounts.</td>
              </tr>
              <tr>
                <th scope="row">Model provider</th>
                <td>{check(health.data.checks.model === 'configured', 'Configured', 'Not configured')}</td>
                <td className="ptable__detail">
                  {caps.agentModel ? `The assistant uses ${caps.agentModel}.` : 'Needed for the assistant and written briefs.'}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <section className="prefs__block">
        <h2 className="prefs__h">This session</h2>
        <table className="ptable">
          <tbody>
            <tr>
              <th scope="row">Mode</th>
              <td>
                <Pill tone={session.mode === 'demo' ? 'warn' : 'ok'}>{session.mode === 'demo' ? 'Sandbox demo' : 'Live'}</Pill>
              </td>
              <td className="ptable__detail">
                {session.mode === 'demo'
                  ? 'Simulated accounts and data. Nothing reaches Google or a real recipient.'
                  : 'Connected to your real Google accounts.'}
              </td>
            </tr>
            <tr>
              <th scope="row">Signed in as</th>
              <td colSpan={2}>
                {session.user.name} · {session.user.email}
              </td>
            </tr>
            {session.expiresAt && (
              <tr>
                <th scope="row">Expires</th>
                <td colSpan={2}>{format(parseDate(session.expiresAt) ?? new Date(), 'MMM d, yyyy, HH:mm')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="prefs__block">
        <h2 className="prefs__h">What Orbitdesk keeps</h2>
        <ul className="prefs__list">
          <li>
            A cache of the last <strong>{caps.limits.mailCacheDays} days</strong> of mail, plus events and tasks, so lists
            open quickly. Google remains the source of truth.
          </li>
          <li>
            Attachments stay in Gmail drafts; uploads are limited to <strong>{formatBytes(caps.limits.attachmentBytesPerMessage)}</strong>{' '}
            per message.
          </li>
          <li>A redacted activity log of actions and approvals — never message bodies.</li>
          <li>Encrypted access tokens for each connected account, removed when you disconnect.</li>
          <li>
            {caps.agent.available
              ? 'The parts of threads and events needed to answer a question are sent to the configured model provider for that request.'
              : 'No model provider is configured, so no content is sent to one.'}
          </li>
        </ul>
        <p className="prefs__note">
          Details are in the <Link href="/privacy">privacy policy</Link> and <Link href="/terms">terms</Link>.
        </p>
      </section>

      <section className="prefs__block prefs__block--danger">
        <h2 className="prefs__h">
          <ShieldAlert size={16} aria-hidden="true" /> Delete account and data
        </h2>
        <p className="prose-sm">
          Disconnects every Google account, cancels scheduled actions and deletes Orbitdesk’s cache, history and settings.
          Your mail, calendars and tasks in Google are not touched.
        </p>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          {session.mode === 'demo' ? 'Discard this sandbox…' : 'Delete my Orbitdesk account…'}
        </Button>
      </section>

      {deleting && <DeleteAccountDialog onClose={() => setDeleting(false)} />}
    </div>
  );
}

function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const { boot } = useApp();
  const email = boot.session.user.email;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const matches = sameEmail(typed, email);

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      // The typed text only has to match ignoring case; the canonical address is what is sent.
      await api.deleteAccount({ confirmEmail: email });
      // The session is gone; start again from the sign-in page.
      window.location.assign('/');
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={boot.session.mode === 'demo' ? 'Discard this sandbox?' : 'Delete your Orbitdesk account?'}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" busy={busy} disabled={!matches} onClick={submit}>
            Delete everything
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="prose-sm">
          This removes {plural(boot.connections.length, 'connected account')}, all cached data, drafts of pending
          approvals and your settings from Orbitdesk. It cannot be undone. Google data is unaffected.
        </p>
        <Field label={`Type ${email} to confirm`}>
          <input
            className="input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-autofocus
          />
        </Field>
        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
