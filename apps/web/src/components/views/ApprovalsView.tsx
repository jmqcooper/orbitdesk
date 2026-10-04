'use client';

import clsx from 'clsx';
import { format } from 'date-fns';
import { CalendarClock, History, RotateCw, ScrollText, ShieldCheck, Sparkles, User, Zap } from 'lucide-react';
import { useState } from 'react';
import { api, toApiError } from '@/lib/api';
import { parseDate, toDateKey } from '@/lib/format';
import { routePath, useResource } from '@/lib/hooks';
import type { Action, ActivityEntry } from '@/lib/types';
import { ActionCard } from '../actions/ActionCard';
import { AccountBadge, GapNotice, useApp } from '../AppContext';
import { Button, EmptyState, ErrorState, IconButton, SkeletonRows, Spinner, StaleNotice, Tabs, ViewHeader } from '../ui';

type TabId = 'pending' | 'scheduled' | 'history' | 'activity';
const TAB_IDS: TabId[] = ['pending', 'scheduled', 'history', 'activity'];

const EMPTY: Record<Exclude<TabId, 'activity'>, { title: string; text: string; icon: React.ReactNode }> = {
  pending: {
    title: 'Nothing is waiting for you',
    text: 'When the assistant or an automation wants to send, invite, cancel or delete something, the exact content appears here first.',
    icon: <ShieldCheck size={22} />,
  },
  scheduled: {
    title: 'Nothing is scheduled',
    text: 'Messages you schedule and actions you approve for later wait here. You can cancel them until they start.',
    icon: <CalendarClock size={22} />,
  },
  history: {
    title: 'No finished actions yet',
    text: 'Completed, failed, rejected and cancelled actions are kept here with what actually happened.',
    icon: <History size={22} />,
  },
};

const ACTOR_ICON = { user: User, agent: Sparkles, automation: Zap, system: ScrollText } as const;
const ACTOR_LABEL = { user: 'You', agent: 'Assistant', automation: 'Automation', system: 'System' } as const;

export function ApprovalsView({ tab }: { tab?: string }) {
  const { boot, scopeParam, scopeKey, navigate } = useApp();
  const active: TabId = TAB_IDS.includes(tab as TabId) ? (tab as TabId) : 'pending';

  const actions = useResource(
    active !== 'activity' ? `actions:${active}:${scopeKey}` : null,
    (signal) =>
      api.actions({ status: active === 'history' ? 'done' : (active as 'pending' | 'scheduled'), accountId: scopeParam, limit: 50 }, { signal }),
    { refreshMs: active === 'scheduled' ? 20_000 : 60_000 },
  );
  const activity = useResource(active === 'activity' ? `activity:${scopeKey}` : null, (signal) =>
    api.activity({ accountId: scopeParam, limit: 80 }, { signal }),
  );
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const replace = (action: Action) => {
    actions.mutate((current) => ({
      ...current,
      items: current.items.map((item) => (item.id === action.id ? action : item)),
    }));
  };

  const loadMoreActivity = async () => {
    const cursor = activity.data?.nextCursor;
    if (!cursor) return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await api.activity({ accountId: scopeParam, limit: 80, cursor });
      activity.mutate((current) => ({
        items: [...current.items, ...page.items.filter((item) => !current.items.some((c) => c.id === item.id))],
        nextCursor: page.nextCursor,
        gaps: current.gaps,
      }));
    } catch (err) {
      setMoreError(toApiError(err).message);
    } finally {
      setMoreBusy(false);
    }
  };

  const loadMoreActions = async () => {
    const cursor = actions.data?.nextCursor;
    if (!cursor || active === 'activity') return;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await api.actions({
        status: active === 'history' ? 'done' : active,
        accountId: scopeParam,
        limit: 50,
        cursor,
      });
      actions.mutate((current) => ({
        items: [...current.items, ...page.items.filter((item) => !current.items.some((c) => c.id === item.id))],
        nextCursor: page.nextCursor,
        gaps: current.gaps,
      }));
    } catch (err) {
      setMoreError(toApiError(err).message);
    } finally {
      setMoreBusy(false);
    }
  };

  const days = new Map<string, ActivityEntry[]>();
  for (const entry of activity.data?.items ?? []) {
    const date = parseDate(entry.at);
    const key = date ? toDateKey(date) : 'unknown';
    days.set(key, [...(days.get(key) ?? []), entry]);
  }

  const resource = active === 'activity' ? activity : actions;

  return (
    <div className="view view--narrow">
      <ViewHeader
        kicker="Approvals & activity"
        title={
          active === 'pending'
            ? 'Waiting for your decision'
            : active === 'scheduled'
              ? 'Scheduled and in progress'
              : active === 'history'
                ? 'What was done'
                : 'Activity log'
        }
        aside={
          <>
            {resource.refreshing && <Spinner size={14} label="Refreshing" />}
            <IconButton label="Refresh" onClick={resource.reload}>
              <RotateCw size={16} />
            </IconButton>
          </>
        }
      >
        Nothing is sent, booked, cancelled or deleted on your behalf without an approval bound to its exact content.
      </ViewHeader>

      <Tabs
        label="Approvals sections"
        value={active}
        onChange={(id) => navigate(routePath('approvals', id))}
        tabs={[
          { id: 'pending', label: 'Needs approval', count: boot.counts.pendingActions },
          { id: 'scheduled', label: 'Scheduled', count: boot.counts.scheduledActions },
          { id: 'history', label: 'History' },
          { id: 'activity', label: 'Activity log' },
        ]}
      />

      {active !== 'activity' && (
        <div className="acards">
          {actions.data && <GapNotice gaps={actions.data.gaps} />}
          {actions.error && actions.data && <StaleNotice error={actions.error} onRetry={actions.reload} />}
          {actions.loading && <SkeletonRows count={4} tall />}
          {actions.error && !actions.data && <ErrorState error={actions.error} onRetry={actions.reload} />}
          {actions.data && actions.data.items.length === 0 && (
            <EmptyState icon={EMPTY[active].icon} title={EMPTY[active].title}>
              {EMPTY[active].text}
            </EmptyState>
          )}
          {actions.data?.items.map((action) => (
            <ActionCard key={action.id} action={action} onChange={replace} defaultOpen={active !== 'history'} />
          ))}
          {actions.data?.nextCursor && (
            <div className="inbox__more">
              <Button busy={moreBusy} onClick={loadMoreActions}>
                Load more
              </Button>
              {moreError && <p className="inbox__more-error">{moreError}</p>}
            </div>
          )}
        </div>
      )}

      {active === 'activity' && (
        <div className="log">
          {activity.error && activity.data && <StaleNotice error={activity.error} onRetry={activity.reload} />}
          {activity.loading && <SkeletonRows count={8} />}
          {activity.error && !activity.data && <ErrorState error={activity.error} onRetry={activity.reload} />}
          {activity.data && activity.data.items.length === 0 && (
            <EmptyState icon={<ScrollText size={22} />} title="No activity recorded yet">
              Sign-ins, syncs, approvals and every action taken through Orbitdesk are listed here, without message content.
            </EmptyState>
          )}
          {Array.from(days.entries()).map(([key, entries]) => {
            const day = parseDate(key);
            return (
              <section key={key} className="log__day">
                <h2 className="log__date">{day ? format(day, 'EEEE, MMMM d') : 'Undated'}</h2>
                <ol className="log__list">
                  {entries.map((entry) => {
                    const at = parseDate(entry.at);
                    const ActorIcon = ACTOR_ICON[entry.actor] ?? ScrollText;
                    return (
                      <li key={entry.id} className={clsx('log__row', `log__row--${entry.outcome}`)}>
                        <time className="log__time" dateTime={entry.at}>
                          {at ? format(at, 'HH:mm') : '—'}
                        </time>
                        <span className="log__dot" aria-hidden="true" />
                        <span className="log__body">
                          <span className="log__title">{entry.title}</span>
                          {entry.detail && <span className="log__detail">{entry.detail}</span>}
                        </span>
                        <span className="log__meta">
                          {entry.accountId && <AccountBadge accountId={entry.accountId} />}
                          <span className="log__actor">
                            <ActorIcon size={11} aria-hidden="true" /> {ACTOR_LABEL[entry.actor] ?? entry.actor}
                          </span>
                          <code className="log__kind">{entry.kind}</code>
                          {entry.outcome === 'failed' && <span className="pill pill--danger">Failed</span>}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
          {activity.data?.nextCursor && (
            <div className="inbox__more">
              <Button busy={moreBusy} onClick={loadMoreActivity}>
                Load older activity
              </Button>
              {moreError && <p className="inbox__more-error">{moreError}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
