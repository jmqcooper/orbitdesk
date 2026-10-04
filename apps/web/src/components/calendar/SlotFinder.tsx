'use client';

import { addDays, endOfDay, format, startOfDay } from 'date-fns';
import { CalendarSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { clockTime, combineDateTime, durationLabel, parseDate, toDateKey, toIso } from '@/lib/format';
import type { AvailabilityResult, Id, TimeSlot } from '@/lib/types';
import { AccountDot, GapNotice, useApp } from '../AppContext';
import { Button, Dialog, EmptyState, Field, Notice, Toggle } from '../ui';

const DURATIONS = [15, 30, 45, 60, 90, 120];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Asks the server for live free/busy across the chosen calendars. Slots are
 * the server's answer; when a calendar could not be read the result says so.
 */
export function SlotFinder({ onClose, onPick }: { onClose: () => void; onPick: (slot: TimeSlot) => void }) {
  const { boot, account } = useApp();
  const settings = boot.settings;
  const [duration, setDuration] = useState(
    DURATIONS.includes(settings.defaultMeetingMinutes) ? settings.defaultMeetingMinutes : 30,
  );
  const [from, setFrom] = useState(toDateKey(new Date()));
  const [to, setTo] = useState(toDateKey(addDays(new Date(), 6)));
  const [calendarIds, setCalendarIds] = useState<Id[]>(() =>
    boot.calendars.filter((c) => c.includeInAvailability).map((c) => c.id),
  );
  const [working, setWorking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<AvailabilityResult | null>(null);

  const search = async () => {
    const start = combineDateTime(from, '00:00');
    const end = combineDateTime(to, '00:00');
    if (!start || !end || end < start) {
      setProblem('Choose a valid date range.');
      return;
    }
    if (calendarIds.length === 0) {
      setProblem('Select at least one calendar to check.');
      return;
    }
    setProblem(null);
    setError(null);
    setBusy(true);
    try {
      const now = new Date();
      const timeMin = startOfDay(start) < now ? now : startOfDay(start);
      setResult(
        await api.availability({
          timeMin: toIso(timeMin),
          timeMax: toIso(endOfDay(end)),
          durationMinutes: duration,
          calendarIds,
          withinWorkingHours: working,
          limit: 40,
        }),
      );
    } catch (err) {
      setError(toApiError(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  const toggleCalendar = (id: Id) => {
    setCalendarIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const groups = new Map<string, TimeSlot[]>();
  for (const slot of result?.slots ?? []) {
    const start = parseDate(slot.start);
    if (!start) continue;
    const key = toDateKey(start);
    groups.set(key, [...(groups.get(key) ?? []), slot]);
  }

  const hours = settings.workingHours;
  const accountIds = Array.from(new Set(boot.calendars.map((c) => c.accountId)));

  return (
    <Dialog
      title="Find a time"
      size="lg"
      onClose={onClose}
      kicker="Live free/busy across the calendars you choose. Event titles are never read for this."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" icon={<CalendarSearch size={15} />} busy={busy} onClick={search}>
            {result ? 'Check again' : 'Find open slots'}
          </Button>
        </>
      }
    >
      <div className="slots">
        <form
          className="slots__form form"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <div className="form__row form__row--3">
            <Field label="Length">
              <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURATIONS.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {durationLabel(minutes)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From">
              <input className="input" type="date" value={from} min={toDateKey(new Date())} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To">
              <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </div>

          <div className="toggle-row">
            <Toggle checked={working} onChange={setWorking} label="Only within working hours" />
            <span>
              Only within working hours
              <span className="toggle-row__note">
                {hours.days.map((d) => DAY_SHORT[d]).join(', ')} · {hours.start}–{hours.end} · {settings.meetingBufferMinutes} min buffer ·{' '}
                {settings.timezone}
              </span>
            </span>
          </div>

          <fieldset className="slots__cals">
            <legend className="field__label">Calendars that must be free</legend>
            {boot.calendars.length === 0 && <p className="prose-sm">No calendars are available.</p>}
            {accountIds.map((accountId) => {
              const owner = account(accountId);
              return (
                <div key={accountId} className="slots__group">
                  <span className="slots__owner">
                    <AccountDot account={owner} /> {owner?.label ?? 'Account'}
                  </span>
                  {boot.calendars
                    .filter((c) => c.accountId === accountId)
                    .map((calendar) => (
                      <label key={calendar.id} className="check">
                        <input
                          type="checkbox"
                          checked={calendarIds.includes(calendar.id)}
                          onChange={() => toggleCalendar(calendar.id)}
                        />
                        <span className="evt__swatch" style={{ background: calendar.color }} aria-hidden="true" />
                        <span>{calendar.name}</span>
                        {calendar.error && (
                          <span className="check__warn" title={calendar.error}>
                            <TriangleAlert size={12} aria-hidden="true" /> unreadable
                          </span>
                        )}
                      </label>
                    ))}
                </div>
              );
            })}
          </fieldset>
          <button type="submit" hidden />
        </form>

        <div className="slots__results" aria-live="polite">
          {problem && <Notice tone="warn">{problem}</Notice>}
          {error && (
            <Notice tone="danger">
              Availability could not be checked: {error.message} <span className="mono-note">({error.code})</span>
            </Notice>
          )}
          {!result && !error && !busy && (
            <EmptyState compact icon={<CalendarSearch size={20} />} title="Choose a range and check">
              Slots come from a live free/busy query, so they reflect changes made in Google a moment ago.
            </EmptyState>
          )}
          {busy && <p className="slots__busy">Checking {calendarIds.length} calendars…</p>}
          {result && !busy && (
            <>
              {!result.complete && (
                <Notice tone="warn" icon={<TriangleAlert size={15} aria-hidden="true" />}>
                  <strong>Availability is incomplete.</strong> At least one calendar could not be read, so these slots are
                  only verified against the others. Do not treat them as confirmed.
                </Notice>
              )}
              <GapNotice gaps={result.gaps} onLeave={onClose} />
              {result.slots.length === 0 ? (
                <EmptyState compact title={`No open ${durationLabel(duration)} slot in this range`}>
                  {working ? 'Try a longer range, a shorter meeting, or include time outside working hours.' : 'Try a longer range or a shorter meeting.'}
                </EmptyState>
              ) : (
                <div className="slots__days">
                  {Array.from(groups.entries()).map(([key, slots]) => {
                    const day = parseDate(key);
                    return (
                      <section key={key} className="slots__day">
                        <h3 className="slots__dayname">{day ? format(day, 'EEEE, MMM d') : key}</h3>
                        <div className="slots__chips">
                          {slots.map((slot) => {
                            const start = parseDate(slot.start);
                            const end = parseDate(slot.end);
                            if (!start || !end) return null;
                            return (
                              <button key={slot.start} type="button" className="slotchip" onClick={() => onPick(slot)}>
                                {clockTime(start)} – {clockTime(end)}
                              </button>
                            );
                          })}
                        </div>
                      </section>
                    );
                  })}
                </div>
              )}
              <p className="slots__foot">
                Checked {format(parseDate(result.checkedAt) ?? new Date(), 'h:mm:ss a')} against {result.calendarIds.length}{' '}
                {result.calendarIds.length === 1 ? 'calendar' : 'calendars'} · {result.busy.length} busy{' '}
                {result.busy.length === 1 ? 'block' : 'blocks'} · times in your browser’s zone. Choosing a slot opens a new
                event; availability is checked again when it is created.
              </p>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
