'use client';

import clsx from 'clsx';
import { Check, ChevronDown, Plus, RotateCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { canAct, canWriteCalendar, hasPermission, needsAttention } from '@/lib/accounts';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import { browserTimezone, plural, relativeTime } from '@/lib/format';
import { invalidate, useResource } from '@/lib/hooks';
import type { Automation, AutomationTemplate, Connection, ConnectionUpdateRequest, ResourceKind, Settings as SettingsData, SettingsUpdateRequest } from '@/lib/types';
import { AccountDot, useApp, type SettingsSection } from './AppContext';
import { Button, ConfirmDialog, DayPicker, Dialog, Field, Notice, Toggle } from './ui';
import { VoiceFields, type Voice } from './VoiceFields';

const SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'voice', label: 'Voice' },
  { id: 'agent', label: 'Agent' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'data', label: 'Data' },
];

const AREAS: Array<{ id: ResourceKind; label: string }> = [
  { id: 'mail', label: 'Mail' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'files', label: 'Drive' },
];

const SWATCHES = ['#c17b43', '#6c8a77', '#7287ad', '#a27594', '#b0762a', '#3f8a5c', '#52618c', '#a2543e'];

export function Settings({ section, onSection, onClose }: { section: SettingsSection; onSection: (section: SettingsSection) => void; onClose: () => void }) {
  const { boot } = useApp();
  const attention = boot.connections.filter(needsAttention).length;
  return (
    <Dialog title="Settings" bare size="xl" className="settings" onClose={onClose}>
      <nav className="settings__nav" aria-label="Settings">
        <h2 className="settings__title">Settings</h2>
        {SECTIONS.map((item) => (
          <button key={item.id} type="button" className={clsx('settings__link', section === item.id && 'is-active')} aria-current={section === item.id ? 'page' : undefined} onClick={() => onSection(item.id)}>
            {item.label}
            {item.id === 'accounts' && attention > 0 && <TriangleAlert size={13} className="acct-badge__warn" aria-label="Needs attention" />}
          </button>
        ))}
        <span className="spacer" />
        <button type="button" className="settings__link" onClick={onClose}>
          Done
        </button>
      </nav>
      <div className="settings__body" tabIndex={-1} data-autofocus>
        {section === 'accounts' && <Accounts />}
        {section === 'voice' && <VoiceSection />}
        {section === 'agent' && <AgentSection />}
        {section === 'preferences' && <Preferences />}
        {section === 'data' && <Data onClose={onClose} />}
      </div>
    </Dialog>
  );
}

function Head({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header className="settings__head">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </header>
  );
}

/* ---------------- Accounts ---------------- */

function Accounts() {
  const { boot, patchBoot, refreshBoot } = useApp();
  const connect = boot.capabilities.googleConnect;
  const [open, setOpen] = useState<string | null>(() => boot.connections.find(needsAttention)?.id ?? null);

  const replace = (updated: Connection) => {
    patchBoot((current) => ({ ...current, connections: current.connections.map((c) => (c.id === updated.id ? updated : c)) }));
  };

  return (
    <>
      <Head title={plural(boot.connections.length, 'account')}>Each Google account is connected on its own. One failing never blocks the others.</Head>
      <ul className="accts">
        {boot.connections.map((connection) => (
          <AccountRow
            key={connection.id}
            connection={connection}
            open={open === connection.id}
            onToggle={() => setOpen(open === connection.id ? null : connection.id)}
            onUpdated={replace}
            onRemoved={() => {
              patchBoot((current) => ({ ...current, connections: current.connections.filter((c) => c.id !== connection.id) }));
              refreshBoot();
            }}
          />
        ))}
      </ul>
      {connect.available ? (
        <a className="btn btn--primary settings__add" href={googleAuthUrl('connect', { features: ['mail', 'calendar', 'tasks'] })}>
          <Plus size={15} aria-hidden="true" />
          <span>Connect another account</span>
        </a>
      ) : (
        <Notice tone="info">{connect.reason ?? 'Google accounts cannot be connected on this deployment.'}</Notice>
      )}
    </>
  );
}

function AccountRow({
  connection,
  open,
  onToggle,
  onUpdated,
  onRemoved,
}: {
  connection: Connection;
  open: boolean;
  onToggle: () => void;
  onUpdated: (connection: Connection) => void;
  onRemoved: () => void;
}) {
  const { boot, toast, reportError } = useApp();
  const [label, setLabel] = useState(connection.label);
  const [signature, setSignature] = useState(connection.signature ?? '');
  const [writing, setWriting] = useState(connection.writingPreferences ?? '');
  const [busy, setBusy] = useState<null | 'sync' | 'save' | 'toggle' | 'remove'>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const connect = boot.capabilities.googleConnect;
  const granted = connection.permissions.filter((p) => p.state === 'granted').map((p) => p.resource);
  const dirty = label.trim() !== connection.label || signature !== (connection.signature ?? '') || writing !== (connection.writingPreferences ?? '');
  const bad = needsAttention(connection);

  const patch = async (body: ConnectionUpdateRequest, kind: 'save' | 'toggle') => {
    setBusy(kind);
    setError(null);
    try {
      onUpdated(await api.updateConnection(connection.id, body));
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
      toast({ message: `Syncing ${connection.label}.` });
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
      invalidate('threads', 'events', 'tasks', 'actions', 'brief', 'drafts', 'files');
      toast({ message: `${connection.email} disconnected.${result.canceledActions ? ` ${plural(result.canceledActions, 'pending action')} cancelled.` : ''}` });
      onRemoved();
    } catch (err) {
      reportError(err, 'Could not disconnect the account');
      setBusy(null);
      setConfirming(false);
    }
  };

  const status =
    connection.status === 'reconnect_required'
      ? 'Needs reconnecting'
      : connection.status === 'error'
        ? 'Sync problem'
        : connection.status === 'syncing'
          ? 'Syncing…'
          : connection.status === 'paused'
            ? 'Paused'
            : connection.lastSyncAt
              ? `Synced ${relativeTime(connection.lastSyncAt)}`
              : 'Not synced yet';

  return (
    <li className={clsx('acct', open && 'is-open')}>
      <div className="acct__row">
        <button type="button" className="acct__main" onClick={onToggle} aria-expanded={open}>
          <AccountDot account={connection} size={10} />
          <span className="acct__text">
            <span className="acct__label">{connection.label}</span>
            <span className="acct__email">{connection.email}</span>
          </span>
          <span className={clsx('acct__status', bad && 'is-bad')}>{status}</span>
          <ChevronDown size={14} aria-hidden="true" className="acct__chev" />
        </button>
        <span className="acct__agent" title="Whether the agent may read this account">
          <Toggle checked={connection.assistantAccess} disabled={busy !== null} label={`Agent can read ${connection.label}`} onChange={(next) => patch({ assistantAccess: next }, 'toggle')} />
        </span>
      </div>

      {open && (
        <div className="acct__body">
          {bad && (
            <Notice tone="warn">
              {connection.statusDetail ?? 'This account needs attention.'}{' '}
              {connect.available && (
                <a className="link-btn" href={googleAuthUrl('connect', { accountId: connection.id, features: granted.length ? granted : undefined })}>
                  Reconnect
                </a>
              )}
            </Notice>
          )}
          <div className="form__row">
            <Field label="Name">
              <input className="input" type="text" value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} />
            </Field>
            <div className="field">
              <span className="field__label">Colour</span>
              <div className="swatches" role="group" aria-label="Colour">
                {SWATCHES.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={clsx('swatch', connection.color.toLowerCase() === color && 'is-on')}
                    style={{ background: color }}
                    aria-label={color}
                    aria-pressed={connection.color.toLowerCase() === color}
                    onClick={() => patch({ color }, 'toggle')}
                  />
                ))}
              </div>
            </div>
          </div>
          <Field label="How to write from this account" hint="Added to your voice whenever the agent drafts from here.">
            <textarea className="input" rows={2} maxLength={2000} placeholder="e.g. Formal, in Dutch, always sign as M. Cooper" value={writing} onChange={(e) => setWriting(e.target.value)} />
          </Field>
          <Field label="Signature">
            <textarea className="input" rows={2} maxLength={5000} value={signature} onChange={(e) => setSignature(e.target.value)} />
          </Field>

          <div className="field">
            <span className="field__label">Access</span>
            <div className="areas">
              {AREAS.map((area) => {
                const permission = connection.permissions.find((p) => p.resource === area.id);
                const on = permission?.state === 'granted';
                if (on) {
                  return (
                    <span key={area.id} className="area is-on">
                      <Check size={12} strokeWidth={2.5} aria-hidden="true" /> {area.label}
                    </span>
                  );
                }
                if (!connect.available || permission?.state === 'admin_restricted') {
                  return (
                    <span key={area.id} className="area" title={permission?.detail ?? undefined}>
                      {area.label}
                    </span>
                  );
                }
                return (
                  <a key={area.id} className="area area--add" href={googleAuthUrl('connect', { accountId: connection.id, features: Array.from(new Set([...granted, area.id])) })} title={`Grant ${area.label} access on Google`}>
                    <Plus size={11} aria-hidden="true" /> {area.label}
                  </a>
                );
              })}
            </div>
          </div>

          {error && <Notice tone="danger">{error.message}</Notice>}

          <div className="acct__foot">
            <Button variant="primary" size="sm" busy={busy === 'save'} disabled={!dirty || !label.trim() || busy !== null} onClick={() => patch({ label: label.trim(), signature: signature.trim() ? signature : null, writingPreferences: writing.trim() ? writing : null }, 'save')}>
              Save
            </Button>
            {!connection.demo && (
              <Button variant="ghost" size="sm" icon={<RotateCw size={13} />} busy={busy === 'sync'} disabled={busy !== null} onClick={sync}>
                Sync now
              </Button>
            )}
            <span className="spacer" />
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>
              Disconnect
            </Button>
          </div>
        </div>
      )}

      {confirming && (
        <ConfirmDialog title={`Disconnect ${connection.label}?`} confirmLabel="Disconnect" danger busy={busy === 'remove'} onClose={() => setConfirming(false)} onConfirm={remove}>
          <p>
            Orbitdesk forgets {connection.email}: its cached mail, events and tasks are removed here and access is revoked at Google. Nothing in the Google account itself is deleted.
          </p>
        </ConfirmDialog>
      )}
    </li>
  );
}

/* ---------------- Voice ---------------- */

function useSettingsSave() {
  const { patchBoot } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const save = async (body: SettingsUpdateRequest): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.updateSettings(body);
      patchBoot((current) => ({ ...current, settings: result.settings, calendars: result.calendars }));
      return true;
    } catch (err) {
      setError(toApiError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, save };
}

function VoiceSection() {
  const { boot, toast } = useApp();
  const [value, setValue] = useState<Voice>({ voice: boot.settings.voice ?? '', about: boot.settings.about ?? '' });
  const { busy, error, save } = useSettingsSave();
  const dirty = value.voice !== (boot.settings.voice ?? '') || value.about !== (boot.settings.about ?? '');
  return (
    <>
      <Head title="Voice">The agent writes every draft as you. Give it your voice once; tune single accounts under Accounts.</Head>
      <VoiceFields value={value} onChange={setValue} disabled={busy} />
      {error && <Notice tone="danger">{error.message}</Notice>}
      <div className="settings__foot">
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          disabled={!dirty}
          onClick={async () => {
            if (await save({ voice: value.voice.trim() || null, about: value.about.trim() || null })) toast({ tone: 'ok', message: 'Voice saved. New drafts will use it.' });
          }}
        >
          Save
        </Button>
      </div>
    </>
  );
}

/* ---------------- Agent ---------------- */

const WEEKDAYS = [1, 2, 3, 4, 5];

function AgentSection() {
  const { boot, reportError } = useApp();
  const { busy, error, save } = useSettingsSave();
  const automations = useResource('automations', (signal) => api.automations({ signal }));
  const [pending, setPending] = useState<AutomationTemplate | null>(null);
  const caps = boot.capabilities;
  const settings = boot.settings;

  const find = (template: AutomationTemplate) => automations.data?.items.find((item) => item.template === template);
  const brief = find('daily_brief');
  const followUp = find('follow_up');

  const upsert = async (template: AutomationTemplate, existing: Automation | undefined, change: { enabled?: boolean; time?: string; days?: number }) => {
    setPending(template);
    try {
      const schedule = { time: change.time ?? existing?.schedule.time ?? (template === 'daily_brief' ? '08:00' : '09:00'), days: existing?.schedule.days ?? WEEKDAYS, timezone: settings.timezone };
      const config = template === 'follow_up' ? { followUpAfterDays: change.days ?? existing?.config.followUpAfterDays ?? 3 } : undefined;
      const saved = existing
        ? await api.updateAutomation(existing.id, { enabled: change.enabled ?? existing.enabled, schedule, config })
        : await api.createAutomation({ template, enabled: change.enabled ?? true, schedule, config });
      automations.mutate((current) => ({ ...current, items: existing ? current.items.map((item) => (item.id === saved.id ? saved : item)) : [...current.items, saved] }));
    } catch (err) {
      reportError(err, 'Could not update that');
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <Head title="Agent">What the agent does on its own. It never sends, invites or deletes without you.</Head>
      {!caps.agent.available && <Notice tone="warn">{caps.agent.reason ?? 'No model is configured.'}</Notice>}
      {caps.agent.available && !caps.triage.available && <Notice tone="warn">{caps.triage.reason ?? 'Background work is paused.'}</Notice>}

      <ul className="opts">
        <li className="opt">
          <div className="opt__text">
            <strong>Sort new mail</strong>
            <span>Into Reply, FYI and Other, with a one-line summary.</span>
          </div>
          <Toggle checked={settings.autoTriage} disabled={busy} label="Sort new mail" onChange={(next) => void save({ autoTriage: next })} />
        </li>
        <li className="opt">
          <div className="opt__text">
            <strong>Draft replies</strong>
            <span>A draft in your voice waits in every conversation that needs an answer.</span>
          </div>
          <Toggle checked={settings.autoDraft} disabled={busy || !settings.autoTriage} label="Draft replies" onChange={(next) => void save({ autoDraft: next })} />
        </li>
        <li className="opt">
          <div className="opt__text">
            <strong>Morning brief</strong>
            <span>Written on weekdays and shown in the agent panel.</span>
          </div>
          {brief?.enabled && (
            <input
              type="time"
              className="input input--sm opt__input"
              aria-label="Brief time"
              value={brief.schedule.time}
              disabled={pending !== null}
              onChange={(e) => e.target.value && void upsert('daily_brief', brief, { time: e.target.value })}
            />
          )}
          <Toggle checked={Boolean(brief?.enabled)} disabled={pending !== null || automations.loading || !caps.automations.available} label="Morning brief" onChange={(next) => void upsert('daily_brief', brief, { enabled: next })} />
        </li>
        <li className="opt">
          <div className="opt__text">
            <strong>Follow-up drafts</strong>
            <span>When mail you sent goes unanswered, a nudge is drafted for you.</span>
          </div>
          {followUp?.enabled && (
            <select
              className="input input--sm opt__input"
              aria-label="Days to wait"
              value={followUp.config.followUpAfterDays ?? 3}
              disabled={pending !== null}
              onChange={(e) => void upsert('follow_up', followUp, { days: Number(e.target.value) })}
            >
              {[2, 3, 5, 7, 14].map((days) => (
                <option key={days} value={days}>
                  after {days} days
                </option>
              ))}
            </select>
          )}
          <Toggle checked={Boolean(followUp?.enabled)} disabled={pending !== null || automations.loading || !caps.automations.available} label="Follow-up drafts" onChange={(next) => void upsert('follow_up', followUp, { enabled: next })} />
        </li>
      </ul>
      {error && <Notice tone="danger">{error.message}</Notice>}

      {caps.agent.available && (
        <dl className="facts">
          <dt>Quick decisions</dt>
          <dd>
            <code>{caps.fastModel}</code>
          </dd>
          <dt>Drafting and tasks</dt>
          <dd>
            <code>{caps.agentModel}</code>
          </dd>
          <dt>Provider</dt>
          <dd>OpenRouter</dd>
        </dl>
      )}
    </>
  );
}

/* ---------------- Preferences ---------------- */

function timezones(current: string): string[] {
  try {
    const all = Intl.supportedValuesOf('timeZone');
    return all.includes(current) ? all : [current, ...all];
  } catch {
    return [current];
  }
}

function Preferences() {
  const { boot, account, toast } = useApp();
  const [form, setForm] = useState<SettingsData>(boot.settings);
  const { busy, error, save } = useSettingsSave();
  const [problem, setProblem] = useState<string | null>(null);
  const keys: Array<keyof SettingsData> = ['timezone', 'weekStartsOn', 'workingHours', 'meetingBufferMinutes', 'defaultMeetingMinutes', 'defaultAccountId', 'defaultCalendarId', 'defaultTaskListId', 'loadRemoteImages', 'contactLookup'];
  const dirty = keys.some((key) => JSON.stringify(form[key]) !== JSON.stringify(boot.settings[key]));
  const zone = browserTimezone();

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setProblem(null);
  };

  const submit = async () => {
    if (form.workingHours.start >= form.workingHours.end) {
      setProblem('Working hours have to end after they start.');
      return;
    }
    const body = Object.fromEntries(keys.map((key) => [key, form[key]])) as SettingsUpdateRequest;
    if (await save(body)) {
      invalidate('brief', 'events');
      toast({ tone: 'ok', message: 'Saved.' });
    }
  };

  const mailAccounts = boot.connections.filter((c) => hasPermission(c, 'mail'));
  const calendars = boot.calendars.filter(canWriteCalendar);
  const contactsGranted = boot.connections.some((c) => canAct(c, 'contacts'));

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Head title="Preferences" />
      <div className="form__row">
        <Field label="Time zone" hint={form.timezone !== zone ? `This browser is in ${zone}.` : undefined}>
          <select className="input" value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
            {timezones(form.timezone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
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

      <div className="field">
        <span className="field__label">Working hours</span>
        <div className="hours">
          <DayPicker label="Working days" value={form.workingHours.days} onChange={(days) => set('workingHours', { ...form.workingHours, days })} />
          <input className="input" type="time" aria-label="Start" value={form.workingHours.start} onChange={(e) => set('workingHours', { ...form.workingHours, start: e.target.value })} />
          <input className="input" type="time" aria-label="End" value={form.workingHours.end} onChange={(e) => set('workingHours', { ...form.workingHours, end: e.target.value })} />
        </div>
      </div>

      <div className="form__row">
        <Field label="Default meeting length">
          <select className="input" value={form.defaultMeetingMinutes} onChange={(e) => set('defaultMeetingMinutes', Number(e.target.value))}>
            {[15, 20, 25, 30, 45, 50, 60, 90].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buffer around meetings">
          <select className="input" value={form.meetingBufferMinutes} onChange={(e) => set('meetingBufferMinutes', Number(e.target.value))}>
            {[0, 5, 10, 15, 30].map((m) => (
              <option key={m} value={m}>
                {m === 0 ? 'None' : `${m} minutes`}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="form__row form__row--3">
        <Field label="New mail from">
          <select className="input" value={form.defaultAccountId ?? ''} onChange={(e) => set('defaultAccountId', e.target.value || null)}>
            <option value="">First account</option>
            {mailAccounts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New events in">
          <select className="input" value={form.defaultCalendarId ?? ''} onChange={(e) => set('defaultCalendarId', e.target.value || null)}>
            <option value="">Primary calendar</option>
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {account(c.accountId)?.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="New tasks in">
          <select className="input" value={form.defaultTaskListId ?? ''} onChange={(e) => set('defaultTaskListId', e.target.value || null)}>
            <option value="">Default list</option>
            {boot.taskLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title} · {account(l.accountId)?.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <ul className="opts">
        <li className="opt">
          <div className="opt__text">
            <strong>Load remote images</strong>
            <span>Off keeps senders from seeing that you opened their mail.</span>
          </div>
          <Toggle checked={form.loadRemoteImages} label="Load remote images" onChange={(next) => set('loadRemoteImages', next)} />
        </li>
        <li className="opt">
          <div className="opt__text">
            <strong>Suggest recipients from Google Contacts</strong>
            <span>{contactsGranted ? 'Uses the accounts that granted Contacts.' : 'Grant Contacts on an account first.'}</span>
          </div>
          <Toggle checked={form.contactLookup} label="Suggest recipients from contacts" onChange={(next) => set('contactLookup', next)} />
        </li>
      </ul>

      {problem && <Notice tone="warn">{problem}</Notice>}
      {error && <Notice tone="danger">{error.message}</Notice>}
      <div className="settings__foot">
        <Button type="submit" variant="primary" size="sm" busy={busy} disabled={!dirty}>
          Save
        </Button>
      </div>
    </form>
  );
}

/* ---------------- Data ---------------- */

function Data({ onClose }: { onClose: () => void }) {
  const { boot, signOut } = useApp();
  const health = useResource('health', (signal) => api.health({ signal }), { refreshMs: 60_000 });
  const [deleting, setDeleting] = useState(false);
  const demo = boot.session.mode === 'demo';
  const checks = health.data?.checks;
  const rows: Array<[string, string, boolean]> = checks
    ? [
        ['Database', checks.database === 'ok' ? 'Running' : 'Down', checks.database === 'ok'],
        ['Background worker', checks.worker === 'ok' ? 'Running' : 'Not connected', checks.worker === 'ok'],
        ['Google sign-in', checks.googleOAuth === 'configured' ? 'Configured' : 'Not configured', checks.googleOAuth === 'configured'],
        ['Model', checks.model === 'configured' ? 'Configured' : 'No OpenRouter key', checks.model === 'configured'],
      ]
    : [];

  return (
    <>
      <Head title="Data">
        Google stays the source of truth. Orbitdesk keeps a {boot.capabilities.limits.mailCacheDays}-day cache of mail so it is fast, and sends only what a request needs to the model.
      </Head>
      <dl className="facts">
        {health.loading && <dt>Checking the service…</dt>}
        {health.error && !health.data && <dt>The service status could not be read.</dt>}
        {rows.map(([label, text, ok]) => (
          <div key={label} style={{ display: 'contents' }}>
            <dt>{label}</dt>
            <dd className={clsx(!ok && 'is-bad')}>{text}</dd>
          </div>
        ))}
        <dt>Signed in as</dt>
        <dd>{demo ? 'Sandbox visitor' : boot.session.user.email}</dd>
      </dl>
      <p className="settings__links">
        <a className="link-btn" href="/privacy" target="_blank" rel="noopener">
          Privacy
        </a>
        <a className="link-btn" href="/terms" target="_blank" rel="noopener">
          Terms
        </a>
      </p>
      <div className="settings__foot settings__foot--split">
        <Button
          size="sm"
          onClick={() => {
            onClose();
            signOut();
          }}
        >
          {demo ? 'Leave the sandbox' : 'Sign out'}
        </Button>
        {!demo && (
          <Button size="sm" variant="ghost" onClick={() => setDeleting(true)}>
            Delete my Orbitdesk data
          </Button>
        )}
      </div>
      {deleting && <DeleteAccount onClose={() => setDeleting(false)} />}
    </>
  );
}

function DeleteAccount({ onClose }: { onClose: () => void }) {
  const { boot, signOut } = useApp();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const matches = email.trim().toLowerCase() === boot.session.user.email.toLowerCase();

  const submit = async () => {
    if (!matches) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount({ confirmEmail: email.trim() });
      signOut();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Delete everything Orbitdesk holds?"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} disabled={!matches} onClick={submit}>
            Delete
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
          Every connected account is disconnected and its access revoked. Cached mail, drafts in progress, chats and settings are removed. Nothing in your Google accounts is deleted.
        </p>
        <Field label={`Type ${boot.session.user.email} to confirm`}>
          <input className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} data-autofocus />
        </Field>
        {error && <Notice tone="danger">{error.message}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
