'use client';

import clsx from 'clsx';
import {
  Ban,
  CalendarPlus,
  CalendarX,
  Check,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  ExternalLink,
  FileText,
  ListPlus,
  Mail,
  MailCheck,
  Paperclip,
  Send,
  Sparkles,
  Tags,
  TriangleAlert,
  User,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { api, toApiError } from '@/lib/api';
import { eventDateLabel, formatAddress, formatBytes, relativeTime, safeHref, shortDateTime, titleCase } from '@/lib/format';
import { invalidate } from '@/lib/hooks';
import type { Action, ActionKind, ActionPreview, ActionState, Address } from '@/lib/types';
import { AccountBadge, useApp } from '../AppContext';
import { Button, Pill, Spinner, type Tone } from '../ui';

const KIND_ICON: Record<ActionKind, LucideIcon> = {
  send_email: Send,
  create_event: CalendarPlus,
  update_event: CalendarPlus,
  cancel_event: CalendarX,
  rsvp_event: MailCheck,
  create_task: ListPlus,
  update_task: ListPlus,
  delete_task: ListPlus,
  modify_threads: Tags,
  file_operation: FileText,
  other: Zap,
};

const STATE_META: Record<ActionState, { label: string; tone: Tone }> = {
  proposed: { label: 'Needs your OK', tone: 'accent' },
  approved: { label: 'Approved', tone: 'info' },
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Cancelled', tone: 'neutral' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  needs_review: { label: 'Needs review', tone: 'warn' },
};

const ORIGIN_META: Record<Action['origin'], { label: string; icon: LucideIcon }> = {
  user: { label: 'You', icon: User },
  agent: { label: 'Agent', icon: Sparkles },
  automation: { label: 'Automation', icon: Zap },
};

function isAction(value: unknown): value is Action {
  return typeof value === 'object' && value !== null && 'contentHash' in value && 'preview' in value && 'state' in value;
}

function People({ label, list }: { label: string; list: Address[] }) {
  if (!list.length) return null;
  return (
    <>
      <dt>{label}</dt>
      <dd>{list.map(formatAddress).join(', ')}</dd>
    </>
  );
}

function Changes({ changes }: { changes: Array<{ field: string; from: string | null; to: string | null }> }) {
  if (!changes.length) return null;
  return (
    <>
      <dt>Changes</dt>
      <dd>
        <ul className="acard__changes">
          {changes.map((change) => (
            <li key={change.field}>
              <span className="acard__field">{titleCase(change.field)}</span>
              <del>{change.from ?? '—'}</del>
              <span aria-hidden="true">→</span>
              <ins>{change.to ?? '—'}</ins>
            </li>
          ))}
        </ul>
      </dd>
    </>
  );
}

/** The exact payload, rendered by kind. Nothing here is inferred by the client. */
function Preview({ preview }: { preview: ActionPreview }) {
  const [showBody, setShowBody] = useState(false);
  switch (preview.kind) {
    case 'send_email': {
      const long = preview.bodyText.length > 520;
      return (
        <dl className="acard__grid">
          <People label="From" list={[preview.from]} />
          <People label="To" list={preview.to} />
          <People label="Cc" list={preview.cc} />
          <People label="Bcc" list={preview.bcc} />
          <dt>Subject</dt>
          <dd className="acard__strong">{preview.subject || '(no subject)'}</dd>
          <dt>Message</dt>
          <dd>
            <div className={clsx('acard__body', long && !showBody && 'is-clamped')}>{preview.bodyText || '(empty)'}</div>
            {long && (
              <button type="button" className="link-btn" onClick={() => setShowBody((v) => !v)}>
                {showBody ? 'Show less' : 'Show the whole message'}
              </button>
            )}
          </dd>
          {preview.attachments.length > 0 && (
            <>
              <dt>Files</dt>
              <dd className="acard__files">
                {preview.attachments.map((file) => (
                  <span key={file.filename} className="filechip">
                    <Paperclip size={12} aria-hidden="true" />
                    <span className="filechip__name">{file.filename}</span>
                    <span className="filechip__size">{formatBytes(file.size)}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      );
    }
    case 'create_event':
    case 'update_event':
      return (
        <dl className="acard__grid">
          <dt>Event</dt>
          <dd className="acard__strong">{preview.title || '(no title)'}</dd>
          <dt>When</dt>
          <dd>
            {eventDateLabel(preview)}
            {preview.timezone ? ` (${preview.timezone})` : ''}
            {preview.recurrence?.length ? ' · repeats' : ''}
          </dd>
          <dt>Calendar</dt>
          <dd>{preview.calendarName}</dd>
          {preview.location && (
            <>
              <dt>Where</dt>
              <dd>{preview.location}</dd>
            </>
          )}
          <People label="Guests" list={preview.attendees} />
          {preview.addMeet && (
            <>
              <dt>Video</dt>
              <dd>A Google Meet link will be added</dd>
            </>
          )}
          {preview.description && (
            <>
              <dt>Notes</dt>
              <dd className="acard__body is-clamped">{preview.description}</dd>
            </>
          )}
          <Changes changes={preview.changes} />
          <dt>Notify</dt>
          <dd>{preview.notifiesAttendees ? 'Guests will be emailed by Google Calendar.' : 'No emails are sent to guests.'}</dd>
        </dl>
      );
    case 'cancel_event':
      return (
        <dl className="acard__grid">
          <dt>Cancel</dt>
          <dd className="acard__strong">{preview.title || '(no title)'}</dd>
          <dt>When</dt>
          <dd>{eventDateLabel(preview)}</dd>
          <dt>Calendar</dt>
          <dd>{preview.calendarName}</dd>
          <dt>Scope</dt>
          <dd>{preview.scope === 'series' ? 'Every event in the series' : 'This event only'}</dd>
          <People label="Guests" list={preview.attendees} />
          <dt>Notify</dt>
          <dd>{preview.notifiesAttendees ? 'Guests will be emailed about the cancellation.' : 'No emails are sent to guests.'}</dd>
        </dl>
      );
    case 'rsvp_event':
      return (
        <dl className="acard__grid">
          <dt>Event</dt>
          <dd className="acard__strong">{preview.title || '(no title)'}</dd>
          <dt>When</dt>
          <dd>{eventDateLabel(preview)}</dd>
          {preview.organizer && <People label="Organizer" list={[preview.organizer]} />}
          <dt>Reply</dt>
          <dd className="acard__strong">
            {preview.response === 'accepted' ? 'Yes, going' : preview.response === 'tentative' ? 'Maybe' : 'No, not going'}
          </dd>
          {preview.comment && (
            <>
              <dt>Note</dt>
              <dd>{preview.comment}</dd>
            </>
          )}
        </dl>
      );
    case 'create_task':
    case 'update_task':
    case 'delete_task':
      return (
        <dl className="acard__grid">
          <dt>{preview.kind === 'delete_task' ? 'Delete' : 'Task'}</dt>
          <dd className="acard__strong">{preview.title}</dd>
          <dt>List</dt>
          <dd>{preview.taskListTitle}</dd>
          {preview.due && (
            <>
              <dt>Due</dt>
              <dd>{preview.due}</dd>
            </>
          )}
          {preview.notes && (
            <>
              <dt>Notes</dt>
              <dd className="acard__body is-clamped">{preview.notes}</dd>
            </>
          )}
          {preview.source && (
            <>
              <dt>Source</dt>
              <dd>
                {titleCase(preview.source.kind)}: {preview.source.title}
              </dd>
            </>
          )}
          <Changes changes={preview.changes} />
        </dl>
      );
    case 'modify_threads':
      return (
        <dl className="acard__grid">
          <dt>Action</dt>
          <dd className="acard__strong">
            {titleCase(preview.operation)} {preview.count} {preview.count === 1 ? 'conversation' : 'conversations'}
          </dd>
          {preview.addLabels.length > 0 && (
            <>
              <dt>Add</dt>
              <dd>{preview.addLabels.join(', ')}</dd>
            </>
          )}
          {preview.removeLabels.length > 0 && (
            <>
              <dt>Remove</dt>
              <dd>{preview.removeLabels.join(', ')}</dd>
            </>
          )}
          <dt>Includes</dt>
          <dd>
            <ul className="acard__threads">
              {preview.threads.map((thread) => (
                <li key={thread.id}>
                  <Mail size={12} aria-hidden="true" />
                  <span className="acard__thread-subject">{thread.subject || '(no subject)'}</span>
                  {thread.from && <span className="acard__muted">{thread.from.name ?? thread.from.email}</span>}
                </li>
              ))}
            </ul>
            {preview.count > preview.threads.length && (
              <span className="acard__muted">and {preview.count - preview.threads.length} more</span>
            )}
          </dd>
        </dl>
      );
    case 'file_operation':
      return (
        <dl className="acard__grid">
          <dt>{titleCase(preview.operation)}</dt>
          <dd className="acard__strong">{preview.fileName}</dd>
          {preview.fields.map((field) => (
            <FieldPair key={field.label} label={field.label} value={field.value} />
          ))}
        </dl>
      );
    default:
      return (
        <dl className="acard__grid">
          {(preview.fields ?? []).map((field) => (
            <FieldPair key={field.label} label={field.label} value={field.value} />
          ))}
        </dl>
      );
  }
}

function FieldPair({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

const STEP_ICON: Record<Action['steps'][number]['state'], LucideIcon> = {
  pending: CircleDashed,
  running: CircleDashed,
  succeeded: CircleCheck,
  failed: CircleX,
  skipped: Ban,
};

export function ActionCard({
  action,
  onChange,
  defaultOpen,
}: {
  action: Action;
  /** Receives the server's updated action after approve, reject or cancel. */
  onChange: (action: Action) => void;
  defaultOpen?: boolean;
}) {
  const { toast, refreshBoot } = useApp();
  const decidable = action.state === 'proposed';
  // Paused by the server: the outcome was not confirmed, or the content changed after it was
  // prepared. It is never retried or re-approved; the user dismisses it.
  const uncertain = action.state === 'needs_review';
  const cancelable = action.state === 'approved' || action.state === 'queued';
  const [open, setOpen] = useState(defaultOpen ?? (decidable || uncertain || cancelable));
  const [busy, setBusy] = useState<null | 'approve' | 'reject' | 'cancel'>(null);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const Icon = KIND_ICON[action.kind] ?? Zap;
  const state = STATE_META[action.state] ?? { label: action.state, tone: 'neutral' as Tone };
  const origin = ORIGIN_META[action.origin] ?? ORIGIN_META.user;
  const OriginIcon = origin.icon;
  const resultHref = safeHref(action.result?.url);

  const run = async (kind: 'approve' | 'reject' | 'cancel') => {
    setBusy(kind);
    setError(null);
    try {
      const updated =
        kind === 'approve'
          ? await api.approveAction(action.id, { contentHash: action.contentHash })
          : kind === 'reject'
            ? await api.rejectAction(action.id)
            : await api.cancelAction(action.id);
      setChanged(false);
      onChange(updated);
      invalidate('actions', 'activity', 'brief', 'threads', 'drafts', 'events', 'tasks');
      refreshBoot();
      if (kind === 'approve') {
        if (updated.state === 'succeeded') toast({ tone: 'ok', message: updated.result?.message ?? `${updated.title} — done.` });
        else if (updated.state === 'failed') toast({ tone: 'error', message: updated.error?.message ?? 'The action failed.' });
        else if (updated.scheduledAt) toast({ tone: 'ok', message: `Approved. Runs ${shortDateTime(updated.scheduledAt)}.` });
        else toast({ tone: 'info', message: 'Approved. It is being carried out now.' });
      }
    } catch (err) {
      const apiError = toApiError(err);
      // The content changed after it was shown: replace the card and ask again.
      if (apiError.code === 'conflict' && isAction(apiError.details?.action)) {
        setChanged(true);
        setOpen(true);
        onChange(apiError.details.action);
      }
      setError(apiError.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={clsx('acard', `acard--${action.state}`, (decidable || uncertain) && 'acard--pending')} aria-label={action.title}>
      <header className="acard__head">
        <span className="acard__icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <button type="button" className="acard__titlebtn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="acard__title">{action.title}</span>
          <span className="acard__sub">
            <AccountBadge accountId={action.accountId} />
            <span className="acard__origin">
              <OriginIcon size={11} aria-hidden="true" /> {origin.label}
            </span>
            <span>{relativeTime(action.createdAt)}</span>
          </span>
        </button>
        <span className="acard__state">
          {action.state === 'running' && <Spinner size={13} />}
          <Pill tone={state.tone}>{state.label}</Pill>
          {action.scheduledAt && (action.state === 'queued' || action.state === 'approved' || action.state === 'proposed') && (
            <span className="acard__when">
              <Clock size={12} aria-hidden="true" /> {shortDateTime(action.scheduledAt)}
            </span>
          )}
        </span>
      </header>

      {open && (
        <div className="acard__content">
          {changed && (
            <div className="notice notice--warn" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">
                The content changed after it was first shown. This is the current version — review it before approving.
              </span>
            </div>
          )}
          {uncertain && (
            <div className="notice notice--warn" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">
                <strong>Paused — this will not run or retry by itself.</strong>{' '}
                {action.error?.message ?? 'The outcome could not be confirmed.'} If it may already have happened,
                check the account in Google first. Then dismiss this, and prepare the action again if it is still
                needed.
              </span>
            </div>
          )}
          {action.preview ? (
            <Preview preview={action.preview} />
          ) : (
            <p className="acard__muted">The server did not include a preview for this action.</p>
          )}

          {action.steps.length > 1 && (
            <ol className="acard__steps" aria-label="Steps">
              {action.steps.map((step) => {
                const StepIcon = STEP_ICON[step.state] ?? CircleDashed;
                const href = safeHref(step.url);
                return (
                  <li key={step.id} className={`acard__step acard__step--${step.state}`}>
                    <StepIcon size={14} aria-hidden="true" />
                    <span>
                      {step.label}
                      {step.detail && <span className="acard__muted"> — {step.detail}</span>}
                    </span>
                    {href && (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="link-btn">
                        Open <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    )}
                  </li>
                );
              })}
            </ol>
          )}

          {action.result && (
            <p className="acard__result">
              <CircleCheck size={14} aria-hidden="true" /> {action.result.message}
              {resultHref && (
                <a href={resultHref} target="_blank" rel="noopener noreferrer" className="link-btn">
                  Open in Google <ExternalLink size={11} aria-hidden="true" />
                </a>
              )}
            </p>
          )}
          {action.error && !uncertain && (
            <p className="acard__error" role="alert">
              <CircleX size={14} aria-hidden="true" /> {action.error.message} <span className="mono-note">({action.error.code})</span>
            </p>
          )}
          {error && (
            <p className="acard__error" role="alert">
              <TriangleAlert size={14} aria-hidden="true" /> {error}
            </p>
          )}

          {(decidable || uncertain || cancelable) && (
            <footer className="acard__foot">
              {uncertain && (
                <Button variant="outline" size="sm" icon={<X size={15} />} busy={busy === 'reject'} disabled={busy !== null} onClick={() => run('reject')}>
                  Dismiss
                </Button>
              )}
              {decidable && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Check size={15} />}
                    busy={busy === 'approve'}
                    disabled={busy !== null || !action.preview}
                    onClick={() => run('approve')}
                  >
                    {action.kind === 'send_email' ? (action.scheduledAt ? 'Schedule' : 'Send') : 'Approve'}
                  </Button>
                  <Button variant="ghost" size="sm" busy={busy === 'reject'} disabled={busy !== null} onClick={() => run('reject')}>
                    Reject
                  </Button>
                </>
              )}
              {cancelable && (
                <Button variant="outline" size="sm" icon={<Ban size={15} />} busy={busy === 'cancel'} disabled={busy !== null} onClick={() => run('cancel')}>
                  {action.scheduledAt ? 'Cancel scheduled action' : 'Cancel'}
                </Button>
              )}
            </footer>
          )}
        </div>
      )}
    </article>
  );
}
