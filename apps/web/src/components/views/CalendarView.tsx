'use client';

import clsx from 'clsx';
import { addDays, addMinutes, differenceInCalendarDays, format, isSameDay, isSameMonth, startOfDay, startOfWeek } from 'date-fns';
import {
  CalendarDays,
  CalendarSearch,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Layers,
  MapPin,
  Plus,
  RotateCw,
  TriangleAlert,
  Video,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { canWriteCalendar } from '@/lib/accounts';
import { api } from '@/lib/api';
import { clockTime, eventSpan, eventTimeLabel, parseDate, toIso, type EventSpan } from '@/lib/format';
import { invalidate, useMediaQuery, useNow, useResource } from '@/lib/hooks';
import type { Calendar, CalendarEvent, CalendarPreference, Id } from '@/lib/types';
import { AccountDot, GapNotice, useApp } from '../AppContext';
import { EventDialog, type EventSeed } from '../calendar/EventDialog';
import { SlotFinder } from '../calendar/SlotFinder';
import { Button, EmptyState, ErrorState, IconButton, LoadingBlock, Popover, Spinner, StaleNotice, ViewHeader } from '../ui';

const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

interface Placed {
  event: CalendarEvent;
  top: number;
  height: number;
  col: number;
  cols: number;
  startsBefore: boolean;
  endsAfter: boolean;
}

/** Timed events of one day, laid out side by side where they overlap. */
function layoutDay(day: Date, events: Array<{ event: CalendarEvent; span: EventSpan }>): Placed[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const items = events
    .filter(({ span }) => span.start.getTime() < dayEnd && span.end.getTime() > dayStart)
    .map(({ event, span }) => {
      const startMin = Math.max(0, (span.start.getTime() - dayStart) / 60_000);
      const rawEnd = Math.min(24 * 60, (span.end.getTime() - dayStart) / 60_000);
      return {
        event,
        startMin,
        endMin: Math.max(rawEnd, startMin + 22),
        startsBefore: span.start.getTime() < dayStart,
        endsAfter: span.end.getTime() > dayEnd,
        col: 0,
        cols: 1,
      };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  let cluster: typeof items = [];
  let columnEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const item of cluster) item.cols = columnEnds.length;
    cluster = [];
    columnEnds = [];
    clusterEnd = -1;
  };
  for (const item of items) {
    if (cluster.length && item.startMin >= clusterEnd) close();
    let col = columnEnds.findIndex((end) => end <= item.startMin);
    if (col === -1) {
      col = columnEnds.length;
      columnEnds.push(item.endMin);
    } else {
      columnEnds[col] = item.endMin;
    }
    item.col = col;
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  close();

  return items.map((item) => ({
    event: item.event,
    top: (item.startMin / 60) * HOUR_PX,
    height: Math.max(((item.endMin - item.startMin) / 60) * HOUR_PX - 2, 18),
    col: item.col,
    cols: item.cols,
    startsBefore: item.startsBefore,
    endsAfter: item.endsAfter,
  }));
}

function coversDay(span: EventSpan, day: Date): boolean {
  const dayStart = startOfDay(day);
  return span.start < addDays(dayStart, 1) && span.end > dayStart;
}

export function CalendarView() {
  const { boot, account, scopeParam, scopeKey, patchBoot, reportError } = useApp();
  const narrow = useMediaQuery('(max-width: 860px)');
  const now = useNow(60_000);
  const [anchor, setAnchor] = useState(() => new Date());
  const [modeChoice, setModeChoice] = useState<'week' | 'agenda' | null>(null);
  const [dialog, setDialog] = useState<{ event?: CalendarEvent; seed?: EventSeed; key: number } | null>(null);
  const [finding, setFinding] = useState(false);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  const [prefBusy, setPrefBusy] = useState<Id | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dialogKey = useRef(0);

  const mode = modeChoice ?? (narrow ? 'agenda' : 'week');
  const weekStart = useMemo(
    () => startOfWeek(anchor, { weekStartsOn: boot.settings.weekStartsOn }),
    [anchor, boot.settings.weekStartsOn],
  );
  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)), [weekStart]);
  const weekEnd = addDays(weekStart, 7);

  const events = useResource(
    `events:${toIso(weekStart)}:${scopeKey}`,
    (signal) => api.events({ timeMin: toIso(weekStart), timeMax: toIso(weekEnd), accountId: scopeParam }, { signal }),
    { refreshMs: 120_000 },
  );

  const calendarsById = useMemo(() => new Map(boot.calendars.map((c) => [c.id, c])), [boot.calendars]);
  const visible = useMemo(() => {
    const out: Array<{ event: CalendarEvent; span: EventSpan }> = [];
    for (const event of events.data?.items ?? []) {
      if (event.status === 'cancelled') continue;
      if (calendarsById.get(event.calendarId)?.visible === false) continue;
      const span = eventSpan(event);
      if (span) out.push({ event, span });
    }
    return out.sort((a, b) => a.span.start.getTime() - b.span.start.getTime());
  }, [events.data, calendarsById]);

  // Events that cover whole days sit in the banner row; the rest go on the time grid.
  const banner = visible.filter(({ event, span }) => event.allDay || span.end.getTime() - span.start.getTime() >= 24 * 3_600_000);
  const timed = visible.filter((item) => !banner.includes(item));

  useEffect(() => {
    if (mode !== 'week' || !scrollRef.current) return;
    const first = timed.length ? Math.min(...timed.map(({ span }) => span.start.getHours())) : 8;
    scrollRef.current.scrollTop = Math.max(0, (Math.min(first, 8) - 1) * HOUR_PX);
    // Scroll once per week shown, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, weekStart.getTime(), events.loading]);

  const openEvent = (event: CalendarEvent) => {
    dialogKey.current += 1;
    setDialog({ event, key: dialogKey.current });
  };
  /** The next half hour when this week is on screen, otherwise 9:00 on the first day shown. */
  const defaultStart = (): Date => {
    const today = new Date();
    if (today >= weekStart && today < weekEnd) {
      const start = new Date(today);
      start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0);
      return start;
    }
    const start = new Date(weekStart);
    start.setHours(9, 0, 0, 0);
    return start;
  };
  const openNew = (seed?: EventSeed) => {
    dialogKey.current += 1;
    const start = seed?.start ?? defaultStart();
    setDialog({
      seed: seed ?? { start, end: addMinutes(start, boot.settings.defaultMeetingMinutes) },
      key: dialogKey.current,
    });
  };

  const onGridClick = (day: Date, event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const minutes = Math.floor(((event.clientY - rect.top) / HOUR_PX) * 2) * 30;
    const start = addMinutes(startOfDay(day), Math.max(0, Math.min(minutes, 23 * 60 + 30)));
    openNew({ start, end: addMinutes(start, boot.settings.defaultMeetingMinutes) });
  };

  const setPreference = async (preference: CalendarPreference) => {
    setPrefBusy(preference.calendarId);
    try {
      const result = await api.updateSettings({ calendars: [preference] });
      patchBoot((current) => ({ ...current, settings: result.settings, calendars: result.calendars }));
      invalidate('events', 'brief');
    } catch (err) {
      reportError(err, 'Could not update the calendar');
    } finally {
      setPrefBusy(null);
    }
  };

  const title = isSameMonth(weekStart, addDays(weekStart, 6))
    ? format(weekStart, 'MMMM yyyy')
    : `${format(weekStart, 'MMM')} – ${format(addDays(weekStart, 6), 'MMM yyyy')}`;
  const rangeLabel = `${format(weekStart, 'MMM d')} – ${format(addDays(weekStart, 6), isSameMonth(weekStart, addDays(weekStart, 6)) ? 'd' : 'MMM d')}`;
  const shown = boot.calendars.filter((c) => c.visible).length;
  const accountIds = Array.from(new Set(boot.calendars.map((c) => c.accountId)));
  const brokenCalendars = boot.calendars.filter((c) => c.error);
  const canCreate = boot.calendars.some(canWriteCalendar);
  const nowTop = ((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX;

  return (
    <div className="view view--calendar">
      <ViewHeader
        kicker={`Calendar · ${shown} of ${boot.calendars.length} calendars shown`}
        title={title}
        aside={
          <>
            <Button icon={<CalendarSearch size={15} />} onClick={() => setFinding(true)} disabled={boot.calendars.length === 0}>
              Find a time
            </Button>
            <Button variant="primary" icon={<Plus size={15} />} onClick={() => openNew()} disabled={!canCreate}>
              New event
            </Button>
          </>
        }
      />

      <div className="calbar">
        <div className="calbar__nav">
          <IconButton label="Previous week" onClick={() => setAnchor(addDays(anchor, -7))}>
            <ChevronLeft size={18} />
          </IconButton>
          <Button size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <IconButton label="Next week" onClick={() => setAnchor(addDays(anchor, 7))}>
            <ChevronRight size={18} />
          </IconButton>
          <span className="calbar__range">{rangeLabel}</span>
          {events.refreshing && <Spinner size={14} label="Refreshing" />}
        </div>
        <div className="calbar__right">
          <div className="seg" role="group" aria-label="Calendar layout">
            <button type="button" className={clsx('seg__btn', mode === 'week' && 'is-active')} aria-pressed={mode === 'week'} onClick={() => setModeChoice('week')}>
              Week
            </button>
            <button type="button" className={clsx('seg__btn', mode === 'agenda' && 'is-active')} aria-pressed={mode === 'agenda'} onClick={() => setModeChoice('agenda')}>
              Agenda
            </button>
          </div>
          <Popover
            open={calendarsOpen}
            onClose={() => setCalendarsOpen(false)}
            align="end"
            panelClassName="calpanel"
            trigger={
              <button
                type="button"
                className="btn btn--outline btn--sm"
                aria-haspopup="dialog"
                aria-expanded={calendarsOpen}
                onClick={() => setCalendarsOpen((value) => !value)}
              >
                <Layers size={14} aria-hidden="true" />
                <span>Calendars</span>
                {brokenCalendars.length > 0 && <TriangleAlert size={13} className="calbar__warn" aria-label="Some calendars are unreadable" />}
              </button>
            }
          >
            <CalendarPanel accountIds={accountIds} calendars={boot.calendars} busyId={prefBusy} onChange={setPreference} />
          </Popover>
          <IconButton label="Refresh events" onClick={events.reload}>
            <RotateCw size={16} />
          </IconButton>
        </div>
      </div>

      {events.data && <GapNotice gaps={events.data.gaps} />}
      {events.error && events.data && <StaleNotice error={events.error} onRetry={events.reload} />}
      {events.loading && <LoadingBlock label="Loading events" />}
      {events.error && !events.data && <ErrorState error={events.error} onRetry={events.reload} />}

      {events.data && boot.calendars.length === 0 && (
        <EmptyState icon={<CalendarDays size={22} />} title="No calendars yet">
          Connect a Google account with Calendar access to see its events here.
        </EmptyState>
      )}

      {events.data && boot.calendars.length > 0 && mode === 'week' && (
        <div className="week" role="grid" aria-label={`Week of ${format(weekStart, 'MMMM d')}`}>
          <div className="week__scroll" ref={scrollRef}>
            <div className="week__inner">
              <div className="week__head" role="row">
                <div className="week__corner" aria-hidden="true">
                  <Clock3 size={13} />
                </div>
                {days.map((day) => {
                  const today = isSameDay(day, now);
                  return (
                    <div key={day.toISOString()} className={clsx('week__dayhead', today && 'is-today')} role="columnheader">
                      <span className="week__dow">{format(day, 'EEE')}</span>
                      <span className="week__dom">{format(day, 'd')}</span>
                    </div>
                  );
                })}
              </div>

              {banner.length > 0 && (
                <div className="week__banner" role="row">
                  <div className="week__corner week__corner--label">all day</div>
                  {days.map((day) => (
                    <div key={day.toISOString()} className="week__bannercell" role="gridcell">
                      {banner
                        .filter(({ span }) => coversDay(span, day))
                        .map(({ event }) => (
                          <EventChip key={event.id} event={event} calendar={calendarsById.get(event.calendarId)} onOpen={openEvent} />
                        ))}
                    </div>
                  ))}
                </div>
              )}

              <div className="week__body" role="row">
                <div className="week__hours" aria-hidden="true">
                  {HOURS.map((hour) => (
                    <div key={hour} className="week__hour">
                      {hour > 0 && <span>{clockTime(new Date(2000, 0, 1, hour))}</span>}
                    </div>
                  ))}
                </div>
                {days.map((day) => {
                  const placed = layoutDay(day, timed);
                  const today = isSameDay(day, now);
                  return (
                    <div
                      key={day.toISOString()}
                      className={clsx('week__col', today && 'is-today')}
                      role="gridcell"
                      aria-label={format(day, 'EEEE, MMMM d')}
                      onClick={canCreate ? (event) => onGridClick(day, event) : undefined}
                    >
                      {today && <div className="week__now" style={{ top: nowTop }} aria-hidden="true" />}
                      {placed.map((item) => {
                        const calendar = calendarsById.get(item.event.calendarId);
                        const owner = account(item.event.accountId);
                        const declined = item.event.myResponse === 'declined';
                        const pending = item.event.myResponse === 'needsAction';
                        return (
                          <button
                            key={`${item.event.id}-${day.getDate()}`}
                            type="button"
                            className={clsx(
                              'wevent',
                              item.height < 34 && 'wevent--short',
                              declined && 'wevent--declined',
                              pending && 'wevent--pending',
                              item.event.status === 'tentative' && 'wevent--tentative',
                            )}
                            style={{
                              top: item.top,
                              height: item.height,
                              left: `calc(${(item.col / item.cols) * 100}% + 2px)`,
                              width: `calc(${100 / item.cols}% - 5px)`,
                              ['--cal' as string]: calendar?.color ?? '#8a887f',
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              openEvent(item.event);
                            }}
                            title={`${item.event.title || '(no title)'} · ${eventTimeLabel(item.event)} · ${owner?.label ?? ''}`}
                          >
                            <span className="wevent__title">{item.event.title || '(no title)'}</span>
                            <span className="wevent__time">
                              {eventTimeLabel(item.event)}
                              {item.event.meetUrl ? ' · Meet' : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {visible.length === 0 && (
            <p className="week__empty">
              No events this week on the calendars shown.{canCreate ? ' Click any time to add one.' : ''}
            </p>
          )}
        </div>
      )}

      {events.data && boot.calendars.length > 0 && mode === 'agenda' && (
        <div className="agenda">
          {visible.length === 0 && (
            <EmptyState icon={<CalendarDays size={22} />} title="Nothing scheduled this week">
              No events on the calendars shown between {rangeLabel}.
            </EmptyState>
          )}
          {days.map((day) => {
            const dayEvents = visible.filter(({ span }) => coversDay(span, day));
            if (!dayEvents.length) return null;
            const today = isSameDay(day, now);
            const offset = differenceInCalendarDays(day, now);
            return (
              <section key={day.toISOString()} className={clsx('agenda__day', today && 'is-today')}>
                <header className="agenda__date">
                  <span className="agenda__dom">{format(day, 'd')}</span>
                  <span className="agenda__dow">
                    {format(day, 'EEEE')}
                    <span className="agenda__rel">{offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : format(day, 'MMMM')}</span>
                  </span>
                </header>
                <ul className="agenda__list">
                  {dayEvents.map(({ event }) => {
                    const calendar = calendarsById.get(event.calendarId);
                    const owner = account(event.accountId);
                    return (
                      <li key={event.id}>
                        <button
                          type="button"
                          className={clsx('agenda__item', event.myResponse === 'declined' && 'is-declined')}
                          onClick={() => openEvent(event)}
                        >
                          <span className="agenda__time">{eventTimeLabel(event)}</span>
                          <span className="agenda__bar" style={{ background: calendar?.color ?? '#8a887f' }} aria-hidden="true" />
                          <span className="agenda__main">
                            <span className="agenda__title">{event.title || '(no title)'}</span>
                            <span className="agenda__meta">
                              <AccountDot account={owner} />
                              <span>{owner?.label ?? 'Removed account'}</span>
                              <span>· {calendar?.name ?? 'Calendar'}</span>
                              {event.location && (
                                <span className="agenda__loc">
                                  <MapPin size={12} aria-hidden="true" /> {event.location}
                                </span>
                              )}
                              {event.meetUrl && (
                                <span className="agenda__loc">
                                  <Video size={12} aria-hidden="true" /> Meet
                                </span>
                              )}
                            </span>
                          </span>
                          {event.myResponse === 'needsAction' && <span className="pill pill--accent">Reply needed</span>}
                          {event.myResponse === 'tentative' && <span className="pill pill--warn">Maybe</span>}
                          {event.myResponse === 'declined' && <span className="pill pill--neutral">Declined</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {dialog && (
        <EventDialog
          key={dialog.key}
          event={dialog.event}
          seed={dialog.seed}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            events.mutate((current) => {
              const exists = current.items.some((item) => item.id === saved.id);
              return {
                ...current,
                items: exists ? current.items.map((item) => (item.id === saved.id ? saved : item)) : [...current.items, saved],
              };
            });
            // Series edits and Meet links arrive with the next read.
            events.reload();
          }}
          onDeleted={(id) => {
            events.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== id) }));
            events.reload();
          }}
        />
      )}

      {finding && (
        <SlotFinder
          onClose={() => setFinding(false)}
          onPick={(slot, availabilityCalendarIds) => {
            const start = parseDate(slot.start);
            const end = parseDate(slot.end);
            if (!start || !end) return;
            setFinding(false);
            setAnchor(start);
            openNew({ start, end, availabilityCalendarIds });
          }}
        />
      )}
    </div>
  );
}

function EventChip({
  event,
  calendar,
  onOpen,
}: {
  event: CalendarEvent;
  calendar: Calendar | undefined;
  onOpen: (event: CalendarEvent) => void;
}) {
  return (
    <button
      type="button"
      className={clsx('wchip', event.myResponse === 'declined' && 'wevent--declined')}
      style={{ ['--cal' as string]: calendar?.color ?? '#8a887f' }}
      onClick={() => onOpen(event)}
      title={`${event.title || '(no title)'} · ${eventTimeLabel(event)}`}
    >
      {event.title || '(no title)'}
    </button>
  );
}

function CalendarPanel({
  accountIds,
  calendars,
  busyId,
  onChange,
}: {
  accountIds: Id[];
  calendars: Calendar[];
  busyId: Id | null;
  onChange: (preference: CalendarPreference) => void;
}) {
  const { account } = useApp();
  if (calendars.length === 0) return <p className="calpanel__empty">No calendars are connected.</p>;
  return (
    <div className="calpanel__body" role="group" aria-label="Calendars">
      <div className="calpanel__legend">
        <span>Show</span>
        <span>Calendar</span>
        <span title="Counts toward availability when finding a time">Availability</span>
      </div>
      {accountIds.map((accountId) => {
        const owner = account(accountId);
        return (
          <div key={accountId} className="calpanel__group">
            <div className="calpanel__owner">
              <AccountDot account={owner} />
              <span>{owner?.label ?? 'Account'}</span>
              <span className="calpanel__email">{owner?.email}</span>
            </div>
            {calendars
              .filter((c) => c.accountId === accountId)
              .map((calendar) => (
                <div key={calendar.id} className="calpanel__row">
                  <input
                    type="checkbox"
                    aria-label={`Show ${calendar.name}`}
                    checked={calendar.visible}
                    disabled={busyId === calendar.id}
                    onChange={(e) => onChange({ calendarId: calendar.id, visible: e.target.checked })}
                  />
                  <span className="calpanel__name">
                    <span className="evt__swatch" style={{ background: calendar.color }} aria-hidden="true" />
                    <span>
                      {calendar.name}
                      {calendar.primary && <span className="calpanel__tag">primary</span>}
                      {!canWriteCalendar(calendar) && (
                        <span className="calpanel__tag">{calendar.accessRole === 'freeBusyReader' ? 'free/busy only' : 'read only'}</span>
                      )}
                      {calendar.error && (
                        <span className="calpanel__error">
                          <TriangleAlert size={12} aria-hidden="true" /> {calendar.error}
                        </span>
                      )}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Count ${calendar.name} toward availability`}
                    checked={calendar.includeInAvailability}
                    disabled={busyId === calendar.id}
                    onChange={(e) => onChange({ calendarId: calendar.id, includeInAvailability: e.target.checked })}
                  />
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
