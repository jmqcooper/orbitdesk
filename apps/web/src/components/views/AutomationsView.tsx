'use client';

import clsx from 'clsx';
import { BellRing, Newspaper, Tags, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { relativeTime, shortDateTime } from '@/lib/format';
import { invalidate, useResource } from '@/lib/hooks';
import type { Automation, AutomationConfig, AutomationSchedule, AutomationTemplate, Id } from '@/lib/types';
import { AccountDot, useApp } from '../AppContext';
import { Button, DayPicker, ErrorState, Field, LoadingBlock, Notice, Pill, StaleNotice, Toggle, ViewHeader } from '../ui';

interface TemplateMeta {
  template: AutomationTemplate;
  icon: LucideIcon;
  name: string;
  blurb: string;
  outcome: string;
  defaultTime: string;
  defaultDays: number[];
  defaultConfig: AutomationConfig;
}

const TEMPLATES: TemplateMeta[] = [
  {
    template: 'daily_brief',
    icon: Newspaper,
    name: 'Daily brief',
    blurb:
      'Prepares the Today page ahead of your morning: meetings, tasks due, conversations that need a reply and anything that failed to sync.',
    outcome: 'Reads only. The brief appears on Today.',
    defaultTime: '07:30',
    defaultDays: [1, 2, 3, 4, 5],
    defaultConfig: {},
  },
  {
    template: 'follow_up',
    icon: BellRing,
    name: 'Follow-up reminders',
    blurb:
      'Notices threads you sent that have had no reply and lists them under “Waiting on others”. You decide whether to write again.',
    outcome: 'Reminds inside Orbitdesk. It never sends an email.',
    defaultTime: '09:00',
    defaultDays: [1, 2, 3, 4, 5],
    defaultConfig: { followUpAfterDays: 3 },
  },
  {
    template: 'triage',
    icon: Tags,
    name: 'Inbox triage suggestions',
    blurb:
      'Proposes labels or archiving for a small, bounded set of conversations, following the instruction you give it.',
    outcome: 'Proposals wait in Approvals. Nothing is changed without you.',
    defaultTime: '08:00',
    defaultDays: [1, 2, 3, 4, 5],
    defaultConfig: { triageInstruction: 'Suggest archiving newsletters and receipts older than a week. Never touch mail from people.' },
  },
];

function AutomationSection({
  meta,
  automation,
  enabledByDeployment,
  onSaved,
}: {
  meta: TemplateMeta;
  automation: Automation | undefined;
  enabledByDeployment: boolean;
  onSaved: (automation: Automation) => void;
}) {
  const { boot, toast } = useApp();
  const eligible = boot.connections.filter((c) => c.assistantAccess);
  const [time, setTime] = useState(automation?.schedule.time ?? meta.defaultTime);
  const [days, setDays] = useState<number[]>(automation?.schedule.days ?? meta.defaultDays);
  const [accountIds, setAccountIds] = useState<Id[]>(automation?.accountIds ?? []);
  const [config, setConfig] = useState<AutomationConfig>(automation?.config ?? meta.defaultConfig);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'toggle'>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const Icon = meta.icon;
  const timezone = automation?.schedule.timezone ?? boot.settings.timezone;

  const schedule = (): AutomationSchedule => ({ time, days, timezone });
  const touch = () => {
    setDirty(true);
    setError(null);
  };

  const persist = async (kind: 'save' | 'toggle', enabled: boolean) => {
    if (days.length === 0) {
      setError(new ApiRequestError('validation_failed', 'Pick at least one day for it to run.', 0, ''));
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const saved = automation
        ? await api.updateAutomation(
            automation.id,
            kind === 'toggle' && !dirty ? { enabled } : { enabled, accountIds, schedule: schedule(), config },
          )
        : await api.createAutomation({
            template: meta.template,
            name: meta.name,
            enabled,
            accountIds,
            schedule: schedule(),
            config,
          });
      onSaved(saved);
      setDirty(false);
      invalidate('activity');
      toast({
        tone: 'ok',
        message:
          kind === 'toggle'
            ? `${meta.name} ${saved.enabled ? 'turned on' : 'turned off'}.`
            : `${meta.name} saved${saved.nextRunAt && saved.enabled ? ` — next run ${shortDateTime(saved.nextRunAt)}` : ''}.`,
      });
    } catch (err) {
      setError(toApiError(err));
    } finally {
      setBusy(null);
    }
  };

  const enabled = automation?.enabled ?? false;
  const toggleAccount = (id: Id) => {
    setAccountIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    touch();
  };

  return (
    <section className={clsx('auto', enabled && 'auto--on')} aria-labelledby={`auto-${meta.template}`}>
      <div className="auto__intro">
        <span className="auto__icon" aria-hidden="true">
          <Icon size={18} />
        </span>
        <div>
          <h2 className="auto__name" id={`auto-${meta.template}`}>
            {meta.name}
            {enabled ? <Pill tone="ok">On</Pill> : <Pill>Off</Pill>}
          </h2>
          <p className="auto__blurb">{meta.blurb}</p>
          <p className="auto__outcome">{meta.outcome}</p>
        </div>
        <div className="auto__switch">
          <Toggle
            checked={enabled}
            label={`${enabled ? 'Turn off' : 'Turn on'} ${meta.name}`}
            disabled={busy !== null || (!enabledByDeployment && !enabled)}
            onChange={(next) => void persist('toggle', next)}
          />
        </div>
      </div>

      <div className="auto__form">
        <Field label="Runs at" hint={timezone}>
          <input
            className="input"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              touch();
            }}
          />
        </Field>
        <div className="field">
          <span className="field__label">On</span>
          <DayPicker
            label={`${meta.name} days`}
            value={days}
            onChange={(next) => {
              setDays(next);
              touch();
            }}
          />
        </div>

        {meta.template === 'follow_up' && (
          <Field label="Remind after" hint="Days without a reply">
            <input
              className="input input--short"
              type="number"
              min={1}
              max={30}
              value={config.followUpAfterDays ?? 3}
              onChange={(e) => {
                setConfig({ ...config, followUpAfterDays: Math.max(1, Math.min(30, Number(e.target.value) || 1)) });
                touch();
              }}
            />
          </Field>
        )}

        <div className="field auto__accounts">
          <span className="field__label">Accounts</span>
          {eligible.length === 0 ? (
            <span className="field__hint">No account has assistant access. Turn it on in Connections.</span>
          ) : (
            <div className="scopechips scopechips--inline" role="group" aria-label={`${meta.name} accounts`}>
              <button
                type="button"
                className={clsx('scopechip', accountIds.length === 0 && 'is-on')}
                aria-pressed={accountIds.length === 0}
                onClick={() => {
                  setAccountIds([]);
                  touch();
                }}
              >
                All with assistant access
              </button>
              {eligible.map((connection) => (
                <button
                  key={connection.id}
                  type="button"
                  className={clsx('scopechip', accountIds.includes(connection.id) && 'is-on')}
                  aria-pressed={accountIds.includes(connection.id)}
                  title={connection.email}
                  onClick={() => toggleAccount(connection.id)}
                >
                  <AccountDot account={connection} />
                  <span>{connection.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {meta.template === 'triage' && (
          <Field label="Instruction" className="auto__wide" hint="Plain language. The assistant follows it and still asks before changing anything.">
            <textarea
              className="input input--area"
              rows={3}
              value={config.triageInstruction ?? ''}
              onChange={(e) => {
                setConfig({ ...config, triageInstruction: e.target.value });
                touch();
              }}
            />
          </Field>
        )}
      </div>

      <div className="auto__foot">
        <span className="auto__runs">
          {automation ? (
            <>
              {automation.lastRunAt ? (
                <span className={clsx(automation.lastRunStatus === 'failed' && 'auto__failed')}>
                  Last run {relativeTime(automation.lastRunAt)}
                  {automation.lastRunStatus === 'failed' ? ' — failed' : ''}
                  {automation.lastRunDetail ? `: ${automation.lastRunDetail}` : ''}
                </span>
              ) : (
                <span>Has not run yet</span>
              )}
              {automation.enabled && automation.nextRunAt && <span> · Next {shortDateTime(automation.nextRunAt)}</span>}
            </>
          ) : (
            <span>Not set up yet. Turning it on saves these settings.</span>
          )}
        </span>
        {error && (
          <span className="auto__error" role="alert">
            {error.message}
          </span>
        )}
        <Button
          size="sm"
          variant="primary"
          busy={busy === 'save'}
          disabled={busy !== null || !dirty}
          onClick={() => void persist('save', enabled)}
        >
          {automation ? 'Save changes' : 'Save without turning on'}
        </Button>
      </div>
    </section>
  );
}

export function AutomationsView() {
  const { boot } = useApp();
  const capability = boot.capabilities.automations;
  const automations = useResource('automations', (signal) => api.automations({ signal }), { refreshMs: 120_000 });

  const upsert = (saved: Automation) => {
    automations.mutate((current) => ({
      ...current,
      items: current.items.some((item) => item.id === saved.id)
        ? current.items.map((item) => (item.id === saved.id ? saved : item))
        : [...current.items, saved],
    }));
  };

  return (
    <div className="view view--narrow">
      <ViewHeader kicker="Automations" title="Things Orbitdesk does on a schedule">
        Three bounded routines. Each one reads only the accounts you choose, and none of them can send, invite or delete
        without an approval.
      </ViewHeader>

      {!capability.available && (
        <Notice tone="warn">
          <strong>Schedules are not running on this deployment.</strong>{' '}
          {capability.reason ?? 'The background worker is not available, so automations cannot be turned on.'}
        </Notice>
      )}
      {!boot.capabilities.agent.available && (
        <Notice tone="info">
          No model is configured. The daily brief is assembled without written prose, and triage suggestions are unavailable.
        </Notice>
      )}

      {automations.loading && <LoadingBlock label="Loading automations" />}
      {automations.error && !automations.data && <ErrorState error={automations.error} onRetry={automations.reload} />}
      {automations.error && automations.data && <StaleNotice error={automations.error} onRetry={automations.reload} />}

      {automations.data && (
        <div className="autos">
          {TEMPLATES.map((meta) => {
            const existing = automations.data!.items.find((item) => item.template === meta.template);
            return (
              <AutomationSection
                // Remount when the server record appears so the form starts from saved values.
                key={`${meta.template}:${existing?.id ?? 'new'}`}
                meta={meta}
                automation={existing}
                enabledByDeployment={capability.available}
                onSaved={upsert}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
