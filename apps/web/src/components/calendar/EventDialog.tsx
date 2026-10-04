'use client';

import clsx from 'clsx';
import { addDays, addMinutes, format } from 'date-fns';
import { Check, CircleHelp, Clock, ExternalLink, MapPin, Pencil, Repeat, Trash2, Users, Video, X } from 'lucide-react';
import { useState } from 'react';
import { canAct, canWriteCalendar } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import {
  browserTimezone,
  combineDateTime,
  displayName,
  eventDateLabel,
  eventSpan,
  safeHref,
  toDateKey,
  toIso,
  toTimeInput,
} from '@/lib/format';
import { invalidate } from '@/lib/hooks';
import { htmlToText } from '@/lib/sanitize';
import type {
  Address,
  CalendarEvent,
  EventCreateRequest,
  EventUpdateRequest,
  Id,
  RecurrenceScope,
  ResponseStatus,
} from '@/lib/types';
import { AccountBadge, useApp } from '../AppContext';
import { Linkified } from '../mail/MessageBody';
import { RecipientInput } from '../mail/RecipientInput';
import { Button, Dialog, Field, Notice, Pill, Toggle } from '../ui';

export interface EventSeed {
  start: Date;
  end: Date;
  allDay?: boolean;
  title?: string;
  description?: string;
  attendees?: Address[];
  calendarId?: Id;
  availabilityCalendarIds?: Id[];
}

type RepeatChoice = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly' | 'keep';

const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_NAMES: Record<string, string> = { SU: 'Sun', MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat' };

function describeRecurrence(rules: string[] | null): string | null {
  const rule = rules?.find((line) => line.toUpperCase().startsWith('RRULE:'));
  if (!rule) return rules?.length ? 'Repeats' : null;
  const parts = new Map(
    rule
      .slice(6)
      .split(';')
      .map((pair) => pair.split('=') as [string, string]),
  );
  const freq = parts.get('FREQ');
  const interval = Number(parts.get('INTERVAL') ?? '1');
  const days = (parts.get('BYDAY') ?? '').split(',').filter(Boolean);
  const unit = freq === 'DAILY' ? 'day' : freq === 'WEEKLY' ? 'week' : freq === 'MONTHLY' ? 'month' : freq === 'YEARLY' ? 'year' : null;
  if (!unit) return 'Repeats';
  let text = interval > 1 ? `Repeats every ${interval} ${unit}s` : `Repeats every ${unit}`;
  if (freq === 'WEEKLY' && days.length) {
    text =
      days.join(',') === 'MO,TU,WE,TH,FR' && interval === 1
        ? 'Repeats every weekday'
        : `${text} on ${days.map((day) => DAY_NAMES[day.slice(-2)] ?? day).join(', ')}`;
  }
  if (parts.get('UNTIL')) text += ' (until an end date)';
  if (parts.get('COUNT')) text += ` (${parts.get('COUNT')} times)`;
  return text;
}

function recurrenceFor(repeat: RepeatChoice, start: Date): string[] | null {
  switch (repeat) {
    case 'daily':
      return ['RRULE:FREQ=DAILY'];
    case 'weekdays':
      return ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'];
    case 'weekly':
      return [`RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[start.getDay()]}`];
    case 'monthly':
      return [`RRULE:FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`];
    case 'yearly':
      return ['RRULE:FREQ=YEARLY'];
    default:
      return null;
  }
}

const RESPONSE_LABEL: Record<ResponseStatus, string> = {
  accepted: 'Going',
  tentative: 'Maybe',
  declined: 'Not going',
  needsAction: 'No reply yet',
};

function ResponseIcon({ status }: { status: ResponseStatus }) {
  if (status === 'accepted') return <Check size={13} className="rsvp-icon rsvp-icon--yes" aria-hidden="true" />;
  if (status === 'declined') return <X size={13} className="rsvp-icon rsvp-icon--no" aria-hidden="true" />;
  if (status === 'tentative') return <CircleHelp size={13} className="rsvp-icon rsvp-icon--maybe" aria-hidden="true" />;
  return <Clock size={13} className="rsvp-icon" aria-hidden="true" />;
}

export function EventDialog({
  event,
  seed,
  onClose,
  onSaved,
  onDeleted,
}: {
  event?: CalendarEvent;
  seed?: EventSeed;
  onClose: () => void;
  onSaved: (event: CalendarEvent) => void;
  onDeleted: (id: Id) => void;
}) {
  const { boot, account, toast } = useApp();
  const [current, setCurrent] = useState<CalendarEvent | undefined>(event);
  const [editing, setEditing] = useState(!event);
  const [deleting, setDeleting] = useState(false);

  const writable = boot.calendars.filter((calendar) => {
    const owner = account(calendar.accountId);
    return canWriteCalendar(calendar) && owner !== undefined && canAct(owner, 'calendar');
  });

  if (editing) {
    return (
      <EventForm
        event={current}
        seed={seed}
        writableCalendarIds={writable.map((c) => c.id)}
        onCancel={() => (current ? setEditing(false) : onClose())}
        onClose={onClose}
        onSaved={(saved) => {
          onSaved(saved);
          toast({ tone: 'ok', message: current ? 'Event updated.' : 'Event created.' });
          onClose();
        }}
      />
    );
  }

  if (!current) return null;

  if (deleting) {
    return (
      <DeleteEvent
        event={current}
        onBack={() => setDeleting(false)}
        onClose={onClose}
        onDeleted={(id) => {
          onDeleted(id);
          toast({ message: 'Event deleted.' });
          onClose();
        }}
      />
    );
  }

  return (
    <EventDetails
      event={current}
      onClose={onClose}
      onEdit={() => setEditing(true)}
      onDelete={() => setDeleting(true)}
      onUpdated={(updated) => {
        setCurrent(updated);
        onSaved(updated);
      }}
    />
  );
}

/* ---------------- Details ---------------- */

function EventDetails({
  event,
  onClose,
  onEdit,
  onDelete,
  onUpdated,
}: {
  event: CalendarEvent;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onUpdated: (event: CalendarEvent) => void;
}) {
  const { boot, reportError } = useApp();
  const [rsvpBusy, setRsvpBusy] = useState<ResponseStatus | null>(null);
  const [scope, setScope] = useState<RecurrenceScope>('this');
  const calendar = boot.calendars.find((c) => c.id === event.calendarId);
  const recurring = Boolean(event.recurringEventId || event.recurrence?.length);
  const repeatText = describeRecurrence(event.recurrence);
  const meet = safeHref(event.meetUrl);
  const external = safeHref(event.url);
  const locationHref = event.location && /^https?:\/\//i.test(event.location) ? safeHref(event.location) : null;
  const description = event.description
    ? /<[a-z][\s\S]*>/i.test(event.description)
      ? htmlToText(event.description)
      : event.description
    : '';

  const respond = async (response: Exclude<ResponseStatus, 'needsAction'>) => {
    setRsvpBusy(response);
    try {
      const updated = await api.rsvp(event.id, { response, scope: recurring ? scope : undefined });
      invalidate('events', 'brief');
      onUpdated(updated);
    } catch (err) {
      reportError(err, 'Could not send your response');
    } finally {
      setRsvpBusy(null);
    }
  };

  return (
    <Dialog
      title={event.title || '(no title)'}
      onClose={onClose}
      kicker={eventDateLabel(event)}
      footer={
        <>
          {external && (
            <a className="btn btn--ghost dialog__foot-left" href={external} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} aria-hidden="true" />
              <span>Open in Google Calendar</span>
            </a>
          )}
          {event.canEdit && (
            <>
              <Button variant="ghost" icon={<Trash2 size={15} />} onClick={onDelete}>
                Delete
              </Button>
              <Button variant="primary" icon={<Pencil size={15} />} onClick={onEdit}>
                Edit
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="evt">
        <div className="evt__line">
          <span className="evt__swatch" style={{ background: calendar?.color ?? 'var(--text-3)' }} aria-hidden="true" />
          <span>{calendar?.name ?? 'Calendar unavailable'}</span>
          <AccountBadge accountId={event.accountId} showEmail />
          {event.status === 'tentative' && <Pill tone="warn">Tentative</Pill>}
          {!event.busy && <Pill>Shown as free</Pill>}
        </div>
        {repeatText && (
          <div className="evt__line">
            <Repeat size={15} aria-hidden="true" />
            <span>{repeatText}</span>
          </div>
        )}
        {event.timezone && event.timezone !== browserTimezone() && (
          <div className="evt__line evt__line--muted">
            <Clock size={15} aria-hidden="true" />
            <span>
              Shown in your time zone ({browserTimezone()}). The event was created in {event.timezone}.
            </span>
          </div>
        )}
        {event.location && (
          <div className="evt__line">
            <MapPin size={15} aria-hidden="true" />
            {locationHref ? (
              <a href={locationHref} target="_blank" rel="noopener noreferrer">
                {event.location}
              </a>
            ) : (
              <span>{event.location}</span>
            )}
          </div>
        )}
        {meet && (
          <div className="evt__line">
            <Video size={15} aria-hidden="true" />
            <a className="btn btn--outline btn--sm" href={meet} target="_blank" rel="noopener noreferrer">
              <span>Join with Google Meet</span>
            </a>
            <span className="evt__muted">{meet.replace(/^https?:\/\//, '')}</span>
          </div>
        )}

        {description && (
          <div className="evt__desc">
            <Linkified text={description} />
          </div>
        )}

        {event.attendees.length > 0 && (
          <section className="evt__guests" aria-label="Guests">
            <h3 className="evt__h">
              <Users size={14} aria-hidden="true" /> {event.attendees.length} {event.attendees.length === 1 ? 'guest' : 'guests'}
            </h3>
            <ul>
              {event.attendees.map((attendee) => (
                <li key={attendee.email}>
                  <ResponseIcon status={attendee.responseStatus} />
                  <span className="evt__guest-name">
                    {attendee.name || attendee.email}
                    {attendee.self ? ' (you)' : ''}
                  </span>
                  <span className="evt__muted">
                    {attendee.organizer ? 'Organizer · ' : ''}
                    {attendee.optional ? 'Optional · ' : ''}
                    {RESPONSE_LABEL[attendee.responseStatus]}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {event.organizer && event.attendees.length === 0 && (
          <div className="evt__line evt__line--muted">
            <Users size={15} aria-hidden="true" />
            <span>Organized by {displayName(event.organizer)}</span>
          </div>
        )}

        {event.canRsvp && (
          <section className="evt__rsvp" aria-label="Your response">
            <span className="evt__rsvp-label">
              Going? <span className="evt__muted">Replying as {event.attendees.find((a) => a.self)?.email ?? 'this account'}</span>
            </span>
            <div className="seg" role="group" aria-label="Respond to invitation">
              {(['accepted', 'tentative', 'declined'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={clsx('seg__btn', event.myResponse === value && 'is-active')}
                  aria-pressed={event.myResponse === value}
                  disabled={rsvpBusy !== null}
                  onClick={() => respond(value)}
                >
                  {rsvpBusy === value ? 'Sending…' : value === 'accepted' ? 'Yes' : value === 'tentative' ? 'Maybe' : 'No'}
                </button>
              ))}
            </div>
            {recurring && (
              <label className="evt__scope">
                <span className="sr-only">Apply response to</span>
                <select className="input input--sm" value={scope} onChange={(e) => setScope(e.target.value as RecurrenceScope)}>
                  <option value="this">This event only</option>
                  <option value="series">All events in the series</option>
                </select>
              </label>
            )}
          </section>
        )}
        {!event.canEdit && !event.canRsvp && (
          <p className="evt__muted evt__readonly">This account can view the event but not change it.</p>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------- Delete ---------------- */

function DeleteEvent({
  event,
  onBack,
  onClose,
  onDeleted,
}: {
  event: CalendarEvent;
  onBack: () => void;
  onClose: () => void;
  onDeleted: (id: Id) => void;
}) {
  const recurring = Boolean(event.recurringEventId || event.recurrence?.length);
  const others = event.attendees.filter((a) => !a.self);
  const [scope, setScope] = useState<RecurrenceScope>('this');
  const [notify, setNotify] = useState(others.length > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteEvent(event.id, { scope: recurring ? scope : undefined, notify: others.length ? notify : undefined });
      invalidate('events', 'brief');
      onDeleted(event.id);
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Delete this event?"
      size="sm"
      onClose={onClose}
      kicker={`${event.title || '(no title)'} · ${eventDateLabel(event)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onBack} disabled={busy}>
            Back
          </Button>
          <Button variant="danger" busy={busy} onClick={remove}>
            Delete event
          </Button>
        </>
      }
    >
      <div className="form">
        {recurring && (
          <fieldset className="radio-set">
            <legend className="field__label">This is a repeating event</legend>
            <label>
              <input type="radio" name="del-scope" checked={scope === 'this'} onChange={() => setScope('this')} /> This event only
            </label>
            <label>
              <input type="radio" name="del-scope" checked={scope === 'series'} onChange={() => setScope('series')} /> Every
              event in the series
            </label>
          </fieldset>
        )}
        {others.length > 0 ? (
          <div className="toggle-row">
            <Toggle checked={notify} onChange={setNotify} label="Email guests about the cancellation" />
            <span>
              Email {others.length} {others.length === 1 ? 'guest' : 'guests'} that this is cancelled
            </span>
          </div>
        ) : (
          <p className="prose-sm">The event is removed from the calendar in Google. This cannot be undone here.</p>
        )}
        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

/* ---------------- Create / edit ---------------- */

function initialRepeat(event: CalendarEvent | undefined): RepeatChoice {
  if (!event) return 'none';
  return event.recurrence?.length ? 'keep' : 'none';
}

function EventForm({
  event,
  seed,
  writableCalendarIds,
  onCancel,
  onClose,
  onSaved,
}: {
  event?: CalendarEvent;
  seed?: EventSeed;
  writableCalendarIds: Id[];
  onCancel: () => void;
  onClose: () => void;
  onSaved: (event: CalendarEvent) => void;
}) {
  const { boot, account } = useApp();
  const span = event ? eventSpan(event) : null;
  const firstStart = span?.start ?? seed?.start ?? new Date();
  const firstEndRaw = span?.end ?? seed?.end ?? addMinutes(firstStart, boot.settings.defaultMeetingMinutes);
  const startsAllDay = event?.allDay ?? seed?.allDay ?? false;
  // All-day ends are exclusive on the wire and inclusive in the form.
  const firstEnd = startsAllDay ? addDays(firstEndRaw, -1) : firstEndRaw;

  const writable = boot.calendars.filter((c) => writableCalendarIds.includes(c.id));
  const defaultCalendar =
    writable.find((c) => c.id === seed?.calendarId) ??
    writable.find((c) => c.id === boot.settings.defaultCalendarId) ??
    writable.find((c) => c.primary) ??
    writable[0];

  const [title, setTitle] = useState(event?.title ?? seed?.title ?? '');
  const [calendarId, setCalendarId] = useState<Id>(event?.calendarId ?? defaultCalendar?.id ?? '');
  const [allDay, setAllDay] = useState(startsAllDay);
  const [startDate, setStartDate] = useState(toDateKey(firstStart));
  const [startTime, setStartTime] = useState(startsAllDay ? '09:00' : toTimeInput(firstStart));
  const [endDate, setEndDate] = useState(toDateKey(firstEnd < firstStart ? firstStart : firstEnd));
  const [endTime, setEndTime] = useState(startsAllDay ? '10:00' : toTimeInput(firstEnd));
  const [location, setLocation] = useState(event?.location ?? '');
  const [description, setDescription] = useState(event?.description ?? seed?.description ?? '');
  const [guests, setGuests] = useState<Address[]>(
    event
      ? event.attendees.filter((a) => !a.self).map((a) => ({ name: a.name, email: a.email }))
      : (seed?.attendees ?? []),
  );
  const [addMeet, setAddMeet] = useState(false);
  const [repeat, setRepeat] = useState<RepeatChoice>(initialRepeat(event));
  const [scope, setScope] = useState<RecurrenceScope>('this');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const recurringExisting = Boolean(event && (event.recurringEventId || event.recurrence?.length));
  const calendar = boot.calendars.find((c) => c.id === calendarId);
  const owner = account(calendar?.accountId);
  const hadGuests = (event?.attendees.filter((a) => !a.self).length ?? 0) > 0;
  const willNotify = guests.length > 0 || hadGuests;

  const submit = async () => {
    setProblem(null);
    setError(null);
    if (!title.trim()) {
      setProblem('Give the event a title.');
      return;
    }
    if (!calendarId) {
      setProblem('Choose a calendar you can add events to.');
      return;
    }

    let start: string;
    let end: string;
    let startInstant: Date;
    if (allDay) {
      const first = combineDateTime(startDate, '00:00');
      const last = combineDateTime(endDate, '00:00');
      if (!first || !last) {
        setProblem('Enter valid dates.');
        return;
      }
      if (last < first) {
        setProblem('The end date is before the start date.');
        return;
      }
      startInstant = first;
      start = startDate;
      end = toDateKey(addDays(last, 1));
    } else {
      const first = combineDateTime(startDate, startTime);
      const last = combineDateTime(endDate, endTime);
      if (!first || !last) {
        setProblem('Enter a valid start and end.');
        return;
      }
      if (last <= first) {
        setProblem('The event has to end after it starts.');
        return;
      }
      startInstant = first;
      start = toIso(first);
      end = toIso(last);
    }

    // The form edits other people; the account's own attendee entry is carried through untouched.
    const self = (event?.attendees ?? []).filter((a) => a.self);
    const shared = {
      title: title.trim(),
      description: description.trim() ? description : null,
      location: location.trim() ? location.trim() : null,
      allDay,
      start,
      end,
      timezone: browserTimezone(),
      attendees: [
        ...guests.map((g) => ({ email: g.email, name: g.name })),
        ...self.map((a) => ({ email: a.email, name: a.name, optional: a.optional })),
      ],
      addMeet: addMeet || undefined,
      notify: willNotify ? notify : undefined,
    };

    setBusy(true);
    try {
      let saved: CalendarEvent;
      if (event) {
        const body: EventUpdateRequest = { ...shared, version: event.version };
        if (recurringExisting) body.scope = scope;
        // Recurrence only changes when the user picked a new rule, and only for the whole series.
        if (repeat !== 'keep' && (!recurringExisting || scope === 'series')) body.recurrence = recurrenceFor(repeat, startInstant);
        saved = await api.updateEvent(event.id, body);
      } else {
        if (seed?.availabilityCalendarIds?.length && !allDay) {
          const check = await api.availability({
            timeMin: start,
            timeMax: end,
            durationMinutes: (Date.parse(end) - Date.parse(start)) / 60000,
            calendarIds: seed.availabilityCalendarIds,
            withinWorkingHours: false,
            limit: 1,
          });
          if (!check.complete || !check.slots.some(slot => Date.parse(slot.start) === Date.parse(start))) {
            throw new ApiRequestError('conflict', 'This time is no longer confirmed free across the selected calendars. Check availability again.', 409, '');
          }
        }
        const body: EventCreateRequest = { ...shared, calendarId, recurrence: recurrenceFor(repeat, startInstant) };
        saved = await api.createEvent(body);
      }
      invalidate('events', 'brief');
      onSaved(saved);
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  const onStartDate = (value: string) => {
    // Keep the event's length when the start date moves.
    const before = combineDateTime(startDate, '00:00');
    const after = combineDateTime(value, '00:00');
    const endDay = combineDateTime(endDate, '00:00');
    setStartDate(value);
    if (before && after && endDay) {
      const shifted = new Date(endDay.getTime() + (after.getTime() - before.getTime()));
      setEndDate(toDateKey(shifted));
    }
  };

  const onStartTime = (value: string) => {
    const before = combineDateTime(startDate, startTime);
    const after = combineDateTime(startDate, value);
    const endAt = combineDateTime(endDate, endTime);
    setStartTime(value);
    if (before && after && endAt) {
      const shifted = new Date(endAt.getTime() + (after.getTime() - before.getTime()));
      setEndDate(toDateKey(shifted));
      setEndTime(toTimeInput(shifted));
    }
  };

  const startForLabels = combineDateTime(startDate, '12:00') ?? new Date();

  return (
    <Dialog
      title={event ? 'Edit event' : 'New event'}
      size="lg"
      onClose={onClose}
      kicker={owner ? <AccountBadge accountId={owner.id} showEmail /> : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {event ? 'Back' : 'Cancel'}
          </Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {event ? 'Save changes' : willNotify && notify ? 'Create and invite' : 'Create event'}
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
        {writable.length === 0 && !event && (
          <Notice tone="warn">
            None of the connected accounts has a calendar you can add events to. Check calendar permissions in Connections.
          </Notice>
        )}
        <Field label="Title">
          <input className="input input--title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </Field>

        <div className="form__row form__row--when">
          <Field label="Starts">
            <span className="when">
              <input className="input" type="date" aria-label="Start date" value={startDate} onChange={(e) => onStartDate(e.target.value)} />
              {!allDay && (
                <input className="input" type="time" aria-label="Start time" step={300} value={startTime} onChange={(e) => onStartTime(e.target.value)} />
              )}
            </span>
          </Field>
          <Field label="Ends">
            <span className="when">
              <input className="input" type="date" aria-label="End date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
              {!allDay && (
                <input className="input" type="time" aria-label="End time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} />
              )}
            </span>
          </Field>
        </div>
        <div className="toggle-row">
          <Toggle checked={allDay} onChange={setAllDay} label="All day" />
          <span>All day</span>
          <span className="toggle-row__note">Times are in {browserTimezone()}</span>
        </div>

        <div className="form__row">
          <Field label="Calendar" hint={event ? 'Events stay on the calendar they were created on.' : undefined}>
            <select className="input" value={calendarId} disabled={Boolean(event)} onChange={(e) => setCalendarId(e.target.value)}>
              {event && !writable.some((c) => c.id === calendarId) && <option value={calendarId}>{calendar?.name ?? 'Calendar'}</option>}
              {writable.map((c) => {
                const calOwner = account(c.accountId);
                return (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {calOwner ? ` — ${calOwner.label}` : ''}
                  </option>
                );
              })}
            </select>
          </Field>
          <Field label="Repeat">
            <select
              className="input"
              value={repeat}
              disabled={recurringExisting && scope === 'this'}
              onChange={(e) => setRepeat(e.target.value as RepeatChoice)}
            >
              {repeat === 'keep' || recurringExisting ? (
                <option value="keep">{describeRecurrence(event?.recurrence ?? null) ?? 'Keep current repeat'}</option>
              ) : null}
              <option value="none">Does not repeat</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Every weekday</option>
              <option value="weekly">Every week on {format(startForLabels, 'EEEE')}</option>
              <option value="monthly">Every month on day {startForLabels.getDate()}</option>
              <option value="yearly">Every year</option>
            </select>
          </Field>
        </div>

        {recurringExisting && (
          <fieldset className="radio-set">
            <legend className="field__label">Apply changes to</legend>
            <label>
              <input type="radio" name="edit-scope" checked={scope === 'this'} onChange={() => setScope('this')} /> This event
              only
            </label>
            <label>
              <input type="radio" name="edit-scope" checked={scope === 'series'} onChange={() => setScope('series')} /> Every
              event in the series
            </label>
          </fieldset>
        )}

        <Field label="Guests" hint="Guests are invited from the calendar’s account.">
          <RecipientInput label="Guests" value={guests} onChange={setGuests} accountId={calendar?.accountId ?? null} placeholder="Add people by email" />
        </Field>

        <div className="form__row">
          <Field label="Location">
            <input className="input" type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
          </Field>
          <div className="field">
            <span className="field__label">Video call</span>
            {event?.meetUrl ? (
              <span className="evt__line">
                <Video size={15} aria-hidden="true" /> Existing Meet link is kept
              </span>
            ) : (
              <span className="toggle-row">
                <Toggle checked={addMeet} onChange={setAddMeet} label="Add a Google Meet link" />
                <span>Add a Google Meet link</span>
              </span>
            )}
          </div>
        </div>

        <Field label="Description">
          <textarea className="input input--area" rows={4} value={description ?? ''} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        {willNotify && (
          <div className="toggle-row">
            <Toggle checked={notify} onChange={setNotify} label="Email guests about this" />
            <span>{event ? 'Email guests about the change' : 'Email invitations to guests'}</span>
          </div>
        )}

        {problem && <Notice tone="warn">{problem}</Notice>}
        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
            {error.code === 'conflict' ? ' Close this dialog and reopen the event to see the latest version.' : ''}
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
