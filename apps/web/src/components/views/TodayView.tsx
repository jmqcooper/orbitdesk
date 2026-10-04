'use client';

import clsx from 'clsx';
import { format } from 'date-fns';
import { ArrowRight, Check, MapPin, RotateCw, ShieldCheck, TriangleAlert, Video } from 'lucide-react';
import { useState } from 'react';
import { needsAttention } from '@/lib/accounts';
import { api } from '@/lib/api';
import { displayName, dueLabel, eventSpan, eventTimeLabel, firstName, listTime, plural, relativeTime } from '@/lib/format';
import { invalidate, routePath, useNow, useResource } from '@/lib/hooks';
import type { BriefMailItem, CalendarEvent, Id, Task } from '@/lib/types';
import { AccountBadge, AccountDot, GapNotice, useApp } from '../AppContext';
import { EventDialog } from '../calendar/EventDialog';
import { Button, ErrorState, LoadingBlock, StaleNotice } from '../ui';

function greeting(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function MailList({ items, empty }: { items: BriefMailItem[]; empty: string }) {
  const now = useNow();
  if (!items.length) return <p className="brief__empty">{empty}</p>;
  return (
    <ul className="brief__list">
      {items.map(({ thread, reason }) => (
        <li key={thread.id}>
          <a className="brief__mail" href={routePath('inbox', 'all', thread.id)}>
            <span className="brief__mail-top">
              <span className="brief__from">{displayName(thread.participants[thread.participants.length - 1] ?? thread.participants[0])}</span>
              <time dateTime={thread.lastMessageAt}>{listTime(thread.lastMessageAt, now)}</time>
            </span>
            <span className="brief__subject">{thread.subject || '(no subject)'}</span>
            <span className="brief__reason">{reason}</span>
            <AccountBadge accountId={thread.accountId} />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function TodayView() {
  const { boot, account, scopeParam, scopeKey, reportError, refreshBoot, toast } = useApp();
  const now = useNow();
  const brief = useResource(`brief:${scopeKey}`, (signal) => api.brief({ accountId: scopeParam }, { signal }), {
    refreshMs: 5 * 60_000,
  });
  const [rebuilding, setRebuilding] = useState(false);
  const [openEvent, setOpenEvent] = useState<CalendarEvent | null>(null);
  const [pending, setPending] = useState<Set<Id>>(new Set());

  const rebuild = async () => {
    setRebuilding(true);
    try {
      const fresh = await api.brief({ refresh: true, accountId: scopeParam });
      brief.mutate(() => fresh);
    } catch (err) {
      reportError(err, 'Could not rebuild the brief');
    } finally {
      setRebuilding(false);
    }
  };

  const complete = async (task: Task) => {
    setPending((set) => new Set(set).add(task.id));
    try {
      await api.updateTask(task.id, { completed: true });
      brief.mutate((current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== task.id) }));
      invalidate('tasks');
      refreshBoot();
      toast({
        message: `Completed “${task.title}”.`,
        action: {
          label: 'Undo',
          run: () => {
            api.updateTask(task.id, { completed: false }).then(
              () => {
                brief.reload();
                invalidate('tasks');
                refreshBoot();
              },
              (err) => reportError(err, 'Could not reopen the task'),
            );
          },
        },
      });
    } catch (err) {
      reportError(err, 'Could not complete the task');
    } finally {
      setPending((set) => {
        const next = new Set(set);
        next.delete(task.id);
        return next;
      });
    }
  };

  const user = boot.session.user;
  const data = brief.data;
  const attention = boot.connections.filter(needsAttention);
  const meetings = (data?.meetings ?? []).filter((event) => event.status !== 'cancelled');

  return (
    <div className="view view--today">
      <header className="masthead">
        <p className="kicker">
          {format(now, 'EEEE, MMMM d')} · {boot.settings.timezone}
        </p>
        <h1 className="masthead__title">
          {data?.headline ?? `${greeting(now)}, ${firstName({ name: user.name, email: user.email })}.`}
        </h1>
        {data &&
          (data.summary ? (
            <p className="masthead__lede">{data.summary}</p>
          ) : (
            <p className="masthead__lede masthead__lede--plain">
              {plural(meetings.length, 'meeting')} today, {plural(data.tasks.length, 'task')} due or overdue,{' '}
              {plural(data.needsReply.length, 'conversation')} waiting on you
              {data.waitingOn.length ? `, and ${plural(data.waitingOn.length, 'thread')} waiting on someone else` : ''}.
            </p>
          ))}
        {data && (
          <p className="masthead__meta">
            <span>
              {data.generatedBy === 'model'
                ? `Written by the assistant${boot.capabilities.agentModel ? ` (${boot.capabilities.agentModel})` : ''}`
                : 'Assembled from your data without a model'}{' '}
              · {relativeTime(data.generatedAt)} · {plural(scopeParam?.length ?? boot.connections.length, 'account')}
            </span>
            <Button size="sm" variant="ghost" icon={<RotateCw size={13} />} busy={rebuilding} onClick={rebuild}>
              Rebuild
            </Button>
          </p>
        )}
      </header>

      {brief.loading && <LoadingBlock label="Preparing today’s brief" />}
      {brief.error && !data && <ErrorState error={brief.error} onRetry={brief.reload} />}
      {brief.error && data && <StaleNotice error={brief.error} onRetry={brief.reload} />}

      {attention.length > 0 && (
        <div className="notice notice--warn" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <span className="notice__text">
            <strong>{attention.length === 1 ? `${attention[0]!.label} needs attention.` : `${attention.length} accounts need attention.`}</strong>{' '}
            Their mail and calendars may be missing from this page until they are reconnected.
          </span>
          <a className="link-btn" href="#/connections">
            Review
          </a>
        </div>
      )}
      {data && <GapNotice gaps={data.gaps} />}

      {boot.counts.pendingActions > 0 && (
        <a className="approvals-strip" href="#/approvals">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>
            <strong>{plural(boot.counts.pendingActions, 'action')}</strong> {boot.counts.pendingActions === 1 ? 'is' : 'are'} waiting for
            your approval
          </span>
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      )}

      {data && (
        <div className="brief">
          <section className="brief__col" aria-labelledby="brief-cal">
            <h2 className="brief__h" id="brief-cal">
              On the calendar <span>{meetings.length || ''}</span>
            </h2>
            {meetings.length === 0 ? (
              <p className="brief__empty">No meetings today on the calendars you show.</p>
            ) : (
              <ul className="brief__list">
                {meetings.map((event) => {
                  const span = eventSpan(event);
                  const past = span ? span.end < now : false;
                  const live = span ? span.start <= now && span.end > now && !event.allDay : false;
                  return (
                    <li key={event.id}>
                      <button type="button" className={clsx('brief__event', past && 'is-past')} onClick={() => setOpenEvent(event)}>
                        <span className="brief__time">
                          {eventTimeLabel(event)}
                          {live && <span className="brief__live">now</span>}
                        </span>
                        <span className="brief__subject">{event.title || '(no title)'}</span>
                        <span className="brief__meta">
                          <AccountDot account={account(event.accountId)} />
                          <span>{account(event.accountId)?.label ?? 'Removed account'}</span>
                          {event.location && (
                            <span>
                              <MapPin size={11} aria-hidden="true" /> {event.location}
                            </span>
                          )}
                          {event.meetUrl && (
                            <span>
                              <Video size={11} aria-hidden="true" /> Meet
                            </span>
                          )}
                          {event.myResponse === 'needsAction' && <span className="pill pill--accent">Reply needed</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <a className="brief__more" href="#/calendar">
              Open the calendar <ArrowRight size={13} aria-hidden="true" />
            </a>
          </section>

          <section className="brief__col" aria-labelledby="brief-reply">
            <h2 className="brief__h" id="brief-reply">
              Waiting on you <span>{data.needsReply.length || ''}</span>
            </h2>
            <MailList items={data.needsReply} empty="No conversation is waiting for your reply." />
            <a className="brief__more" href="#/inbox">
              Open the inbox <ArrowRight size={13} aria-hidden="true" />
            </a>
          </section>

          <section className="brief__col" aria-labelledby="brief-tasks">
            <h2 className="brief__h" id="brief-tasks">
              Due <span>{data.tasks.length || ''}</span>
            </h2>
            {data.tasks.length === 0 ? (
              <p className="brief__empty">Nothing is due today or overdue.</p>
            ) : (
              <ul className="brief__list">
                {data.tasks.map((task) => {
                  const due = dueLabel(task.due, now);
                  return (
                    <li key={task.id} className="brief__task">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={false}
                        aria-label={`Complete ${task.title}`}
                        className="task__check"
                        disabled={pending.has(task.id)}
                        onClick={() => complete(task)}
                      >
                        {pending.has(task.id) && <Check size={13} strokeWidth={3} />}
                      </button>
                      <a className="brief__task-main" href={routePath('tasks', task.taskListId)}>
                        <span className="brief__subject">{task.title}</span>
                        <span className="brief__meta">
                          {due && <span className={clsx('due', `due--${due.tone}`)}>{due.text}</span>}
                          <AccountBadge accountId={task.accountId} />
                          <span>{boot.taskLists.find((l) => l.id === task.taskListId)?.title ?? ''}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            <a className="brief__more" href="#/tasks">
              Open tasks <ArrowRight size={13} aria-hidden="true" />
            </a>
          </section>
        </div>
      )}

      {data && data.waitingOn.length > 0 && (
        <section className="brief__wide" aria-labelledby="brief-waiting">
          <h2 className="brief__h" id="brief-waiting">
            Waiting on others <span>{data.waitingOn.length}</span>
          </h2>
          <p className="brief__note">
            Threads you sent that have had no reply. These are reminders only — Orbitdesk never sends a follow-up by itself.
          </p>
          <div className="brief__wide-list">
            <MailList items={data.waitingOn} empty="" />
          </div>
        </section>
      )}

      {openEvent && (
        <EventDialog
          event={openEvent}
          onClose={() => setOpenEvent(null)}
          onSaved={() => brief.reload()}
          onDeleted={() => brief.reload()}
        />
      )}
    </div>
  );
}
