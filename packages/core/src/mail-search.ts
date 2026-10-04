import type { ThreadDetail } from './types';

/** The common Gmail operators used by the sandbox; live accounts use Gmail itself. */
export function matchesMailQuery(thread: ThreadDetail, query: string, now = Date.now()): boolean {
  const text = [thread.subject, thread.snippet, ...thread.messages.map(m => m.bodyText || '')].join(' ').toLowerCase();
  const address = (field: 'from' | 'to' | 'cc' | 'bcc', value: string) => thread.messages.some(m => {
    const entries = field === 'from' ? [m.from] : m[field];
    return entries.some(a => (a.email + ' ' + (a.name || '')).toLowerCase().includes(value));
  });
  const match = (raw: string): boolean => {
    const negative = raw.startsWith('-');
    const token = (negative ? raw.slice(1) : raw).toLowerCase();
    const colon = token.indexOf(':');
    const key = colon < 0 ? '' : token.slice(0, colon);
    const value = (colon < 0 ? token : token.slice(colon + 1)).replace(/^"|"$/g, '');
    let found: boolean;
    if (['from', 'to', 'cc', 'bcc'].includes(key)) found = address(key as 'from', value);
    else if (key === 'subject') found = thread.subject.toLowerCase().includes(value);
    else if (key === 'is') found = value === 'unread' ? thread.unread : value === 'read' ? !thread.unread : value === 'starred' ? thread.starred : false;
    else if (key === 'in') found = value === 'anywhere' ? true : value === 'inbox' ? thread.inInbox : value === 'trash' ? thread.trashed : value === 'sent' ? thread.labelIds.includes('SENT') : false;
    else if (key === 'has' && value === 'attachment') found = thread.hasAttachments;
    else if (key === 'label') found = thread.labelIds.some(id => id.toLowerCase() === value);
    else if (key === 'after' || key === 'before' || key === 'newer' || key === 'older') {
      const boundary = Date.parse(value.replaceAll('/', '-'));
      found = Number.isFinite(boundary) && (['after', 'newer'].includes(key) ? Date.parse(thread.lastMessageAt) > boundary : Date.parse(thread.lastMessageAt) < boundary);
    } else if (key === 'older_than' || key === 'newer_than') {
      const duration = /^(\d+)([dmy])$/.exec(value);
      const boundary = duration ? now - Number(duration[1]) * ({ d: 1, m: 30, y: 365 }[duration[2]!] || 0) * 86400000 : NaN;
      found = Number.isFinite(boundary) && (key === 'older_than' ? Date.parse(thread.lastMessageAt) < boundary : Date.parse(thread.lastMessageAt) > boundary);
    } else found = text.includes(value);
    return negative ? !found : found;
  };
  return query.split(/\s+OR\s+/i).some(group => (group.match(/-?(?:\w+:)?"[^"]*"|\S+/g) || []).every(match));
}
