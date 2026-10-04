import {
  addDays,
  differenceInCalendarDays,
  format,
  formatDistanceToNowStrict,
  isSameDay,
  isSameYear,
  isValid,
  parseISO,
} from 'date-fns';
import type { Address, CalendarEvent } from './types';

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = parseISO(value);
  return isValid(date) ? date : null;
}

/** `YYYY-MM-DD` in the browser's zone. */
export function toDateKey(date: Date): string {
  return format(date, 'yyyy-MM-dd');
}

/** Value for `<input type="time">`. */
export function toTimeInput(date: Date): string {
  return format(date, 'HH:mm');
}

/** Value for `<input type="datetime-local">`. */
export function toDateTimeInput(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}

/** RFC 3339 with the browser's current offset. */
export function toIso(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm:ssxxx");
}

export function combineDateTime(dateKey: string, time: string): Date | null {
  const date = parseISO(`${dateKey}T${time || '00:00'}`);
  return isValid(date) ? date : null;
}

/** Compact time for list rows: time today, weekday this week, date otherwise. */
export function listTime(value: string | null | undefined, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return '';
  if (isSameDay(date, now)) return format(date, 'h:mm a');
  const days = differenceInCalendarDays(now, date);
  if (days > 0 && days < 7) return format(date, 'EEE');
  if (isSameYear(date, now)) return format(date, 'MMM d');
  return format(date, 'MMM d, yyyy');
}

export function fullDateTime(value: string | null | undefined): string {
  const date = parseDate(value);
  return date ? format(date, "EEE, MMM d, yyyy 'at' h:mm a") : '';
}

export function shortDateTime(value: string | null | undefined, now = new Date()): string {
  const date = parseDate(value);
  if (!date) return '';
  if (isSameDay(date, now)) return `Today, ${format(date, 'h:mm a')}`;
  if (isSameDay(date, addDays(now, 1))) return `Tomorrow, ${format(date, 'h:mm a')}`;
  return format(date, isSameYear(date, now) ? 'EEE, MMM d, h:mm a' : 'MMM d, yyyy, h:mm a');
}

export function relativeTime(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return 'never';
  if (Math.abs(Date.now() - date.getTime()) < 45_000) return 'just now';
  return formatDistanceToNowStrict(date, { addSuffix: true });
}

export function clockTime(date: Date): string {
  return format(date, date.getMinutes() === 0 ? 'h a' : 'h:mm a');
}

export function dueLabel(due: string | null, now = new Date()): { text: string; tone: 'overdue' | 'today' | 'later' } | null {
  const date = parseDate(due);
  if (!date) return null;
  const days = differenceInCalendarDays(date, now);
  if (days < 0) return { text: days === -1 ? 'Yesterday' : format(date, 'MMM d'), tone: 'overdue' };
  if (days === 0) return { text: 'Today', tone: 'today' };
  if (days === 1) return { text: 'Tomorrow', tone: 'later' };
  if (days < 7) return { text: format(date, 'EEEE'), tone: 'later' };
  return { text: format(date, isSameYear(date, now) ? 'MMM d' : 'MMM d, yyyy'), tone: 'later' };
}

/* ---------------- Events ---------------- */

export interface EventSpan {
  start: Date;
  /** Exclusive end. */
  end: Date;
}

/** All-day events carry dates; they are read as local midnights so they never shift a day. */
export function eventSpan(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): EventSpan | null {
  const start = parseDate(event.start);
  const end = parseDate(event.end);
  if (!start || !end) return null;
  return { start, end: end > start ? end : start };
}

export function eventTimeLabel(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): string {
  const span = eventSpan(event);
  if (!span) return '';
  if (event.allDay) {
    const lastDay = addDays(span.end, -1);
    if (lastDay <= span.start) return 'All day';
    return `${format(span.start, 'MMM d')} – ${format(lastDay, 'MMM d')}`;
  }
  const sameMeridiem = format(span.start, 'a') === format(span.end, 'a');
  const startText = format(span.start, span.start.getMinutes() === 0 ? 'h' : 'h:mm') + (sameMeridiem ? '' : format(span.start, ' a'));
  const endText = format(span.end, span.end.getMinutes() === 0 ? 'h a' : 'h:mm a');
  if (!isSameDay(span.start, span.end) && differenceInCalendarDays(span.end, span.start) >= 1 && span.end.getHours() + span.end.getMinutes() > 0) {
    return `${format(span.start, 'MMM d, h:mm a')} – ${format(span.end, 'MMM d, h:mm a')}`;
  }
  return `${startText} – ${endText}`;
}

export function eventDateLabel(event: Pick<CalendarEvent, 'start' | 'end' | 'allDay'>): string {
  const span = eventSpan(event);
  if (!span) return '';
  return `${format(span.start, 'EEEE, MMMM d')} · ${eventTimeLabel(event)}`;
}

export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/* ---------------- People ---------------- */

export function displayName(address: Address | null | undefined): string {
  if (!address) return 'Unknown';
  const name = address.name?.trim();
  if (name) return name.replace(/^["']|["']$/g, '');
  return address.email.split('@')[0] || address.email;
}

export function firstName(address: Address | null | undefined): string {
  return displayName(address).split(/\s+/)[0] ?? '';
}

export function formatAddress(address: Address): string {
  const name = address.name?.trim();
  return name ? `${name} <${address.email}>` : address.email;
}

export function initials(nameOrEmail: string): string {
  const words = nameOrEmail
    .replace(/@.*$/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/** Parses pasted or typed recipients: `a@b.c`, `Name <a@b.c>`, separated by commas, semicolons or newlines. */
export function parseAddresses(input: string): { valid: Address[]; invalid: string[] } {
  const valid: Address[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[,;\n]+/)) {
    const part = raw.trim();
    if (!part) continue;
    const angled = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(part);
    const email = (angled ? angled[2]! : part).trim();
    const name = angled ? angled[1]!.trim().replace(/^["']|["']$/g, '') : '';
    if (isEmail(email)) valid.push({ name: name || null, email });
    else invalid.push(part);
  }
  return { valid, invalid };
}

export function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function dedupeAddresses(list: Address[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const address of list) {
    const key = address.email.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

/* ---------------- Misc ---------------- */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function titleCase(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const FALLBACK_COLORS = ['#2f7f79', '#3d6aa8', '#b0762a', '#8a4f6d', '#5d7a3a', '#a2543e', '#52618c', '#7a6a4f'];

/** Colors come from the server; this only guards against a malformed value reaching CSS. */
export function safeColor(color: string | null | undefined, seed = ''): string {
  if (color && HEX_RE.test(color)) return color;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]!;
}

/** Only http(s) and mailto links are ever rendered as anchors. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:' ? url : null;
  } catch {
    return null;
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
