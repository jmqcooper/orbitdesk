'use client';

import clsx from 'clsx';
import { addDays, nextMonday, set } from 'date-fns';
import {
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Paperclip,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { canAct, defaultIdentity, hasPermission, identitiesOf } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { formatBytes, listTime, shortDateTime, toDateTimeInput, toIso } from '@/lib/format';
import { invalidate } from '@/lib/hooks';
import { blankCompose, fileToBase64 } from '@/lib/mail';
import type { Address, Attachment, Draft, DraftMode, Id } from '@/lib/types';
import { AccountDot, useApp, type ComposeRequest } from '../AppContext';
import { Button, ConfirmDialog, IconButton, Popover, Spinner } from '../ui';
import { RecipientInput } from './RecipientInput';

export interface ComposerHandle {
  /** Persist unsaved edits before another message takes the composer's place. */
  saveBeforeReplace: () => Promise<boolean>;
}

interface PendingFile {
  id: string;
  file: File;
}

interface FormState {
  accountId: Id | null;
  fromEmail: string;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  pending: PendingFile[];
  removedIds: Id[];
}

const MODE_TITLES: Record<DraftMode, string> = {
  new: 'New message',
  reply: 'Reply',
  reply_all: 'Reply all',
  forward: 'Forward',
};

function isDraft(value: unknown): value is Draft {
  return typeof value === 'object' && value !== null && 'id' in value && 'version' in value && 'bodyText' in value;
}

export function Composer({
  ref,
  request,
  onClose,
}: {
  ref?: Ref<ComposerHandle>;
  request: ComposeRequest;
  onClose: () => void;
}) {
  const { boot, account, toast, navigate, refreshBoot } = useApp();
  const mode: DraftMode = request.draft?.mode ?? request.mode;
  const threadId = request.draft?.threadId ?? request.threadId ?? null;
  const inReplyToMessageId = request.draft?.inReplyToMessageId ?? request.inReplyToMessageId ?? null;

  const mailAccounts = boot.connections.filter((connection) => hasPermission(connection, 'mail'));

  const [form, setForm] = useState<FormState>(() => {
    if (request.draft) {
      const d = request.draft;
      return {
        accountId: d.accountId,
        fromEmail: d.from.email,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: d.subject,
        bodyText: d.bodyText,
        pending: [],
        removedIds: [],
      };
    }
    const preferred =
      request.accountId ??
      (boot.settings.defaultAccountId && mailAccounts.some((c) => c.id === boot.settings.defaultAccountId)
        ? boot.settings.defaultAccountId
        : (mailAccounts.find((c) => canAct(c, 'mail')) ?? mailAccounts[0])?.id) ??
      null;
    const sender = boot.connections.find((c) => c.id === preferred);
    const blank = blankCompose(sender);
    return {
      accountId: preferred,
      fromEmail: sender ? defaultIdentity(sender) : '',
      to: request.fields?.to ?? blank.to,
      cc: request.fields?.cc ?? blank.cc,
      bcc: request.fields?.bcc ?? blank.bcc,
      subject: request.fields?.subject ?? blank.subject,
      bodyText: request.fields?.bodyText ?? blank.bodyText,
      pending: [],
      removedIds: [],
    };
  });
  const [draft, setDraft] = useState<Draft | null>(request.draft ?? null);
  const [dirty, setDirty] = useState(false);
  const [editTick, setEditTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(request.draft?.updatedAt ?? null);
  const [saveError, setSaveError] = useState<ApiRequestError | null>(null);
  const [conflict, setConflict] = useState<Draft | null>(null);
  const [sending, setSending] = useState<null | 'send' | 'schedule' | 'preview'>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [subjectConfirmed, setSubjectConfirmed] = useState(false);
  const [showCc, setShowCc] = useState(() => form.cc.length > 0 || form.bcc.length > 0);
  const [minimized, setMinimized] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customTime, setCustomTime] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // The save pipeline reads the latest values from refs so queued saves never use a stale render.
  const formRef = useRef(form);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const editSeq = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const closedRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const update = useCallback((patch: Partial<FormState>) => {
    formRef.current = { ...formRef.current, ...patch };
    editSeq.current += 1;
    dirtyRef.current = true;
    setForm(formRef.current);
    setDirty(true);
    setEditTick((tick) => tick + 1);
    setProblem(null);
    setSendError(null);
  }, []);

  const sender = account(form.accountId);
  const lockedToAccount = mode !== 'new' || (draft?.attachments.length ?? 0) > 0;
  const fromChoices = (lockedToAccount && sender ? [sender] : mailAccounts).flatMap((connection) =>
    identitiesOf(connection).map((identity) => ({
      value: `${connection.id}\n${identity.email}`,
      label: connection.label === identity.email ? identity.email : `${connection.label} — ${identity.email}`,
    })),
  );

  const serverAttachments: Attachment[] = (draft?.attachments ?? []).filter((a) => !form.removedIds.includes(a.id));
  const limit = boot.capabilities.limits.attachmentBytesPerMessage;
  const attachedBytes =
    serverAttachments.reduce((sum, a) => sum + a.size, 0) + form.pending.reduce((sum, p) => sum + p.file.size, 0);

  /* ---------------- Saving ---------------- */

  const runSave = useCallback(
    async (force: boolean): Promise<Draft> => {
      const snapshot = formRef.current;
      const current = draftRef.current;
      if (current && !dirtyRef.current && !force) return current;
      if (!snapshot.accountId) throw new ApiRequestError('validation_failed', 'Choose a sending account first.', 0, '');

      const seq = editSeq.current;
      setSaving(true);
      setSaveError(null);
      try {
        const uploads = await Promise.all(
          snapshot.pending.map(async (item) => ({
            filename: item.file.name,
            mimeType: item.file.type || 'application/octet-stream',
            dataBase64: await fileToBase64(item.file),
          })),
        );
        const uploadedIds = new Set(snapshot.pending.map((item) => item.id));
        const common = {
          fromEmail: snapshot.fromEmail || undefined,
          to: snapshot.to,
          cc: snapshot.cc,
          bcc: snapshot.bcc,
          subject: snapshot.subject,
          bodyText: snapshot.bodyText,
          addAttachments: uploads.length ? uploads : undefined,
        };

        let next: Draft;
        if (current && current.accountId === snapshot.accountId) {
          next = await api.updateDraft(current.id, {
            ...common,
            version: current.version,
            force: force || undefined,
            removeAttachmentIds: snapshot.removedIds.length ? snapshot.removedIds : undefined,
          });
        } else {
          next = await api.createDraft({
            ...common,
            accountId: snapshot.accountId,
            mode,
            threadId,
            inReplyToMessageId,
            includeOriginalAttachments: mode === 'forward' ? true : undefined,
          });
          if (current) {
            // The sender changed mailbox: the draft now lives in the new one.
            try {
              await api.deleteDraft(current.id);
            } catch (err) {
              toast({
                tone: 'error',
                message: `The earlier copy of this draft could not be removed from the previous account: ${toApiError(err).message}`,
              });
            }
          }
        }

        draftRef.current = next;
        formRef.current = {
          ...formRef.current,
          pending: formRef.current.pending.filter((item) => !uploadedIds.has(item.id)),
          removedIds: formRef.current.removedIds.filter((id) => !snapshot.removedIds.includes(id)),
        };
        if (editSeq.current === seq) dirtyRef.current = false;
        if (!closedRef.current) {
          setDraft(next);
          setForm(formRef.current);
          setDirty(dirtyRef.current);
          setSavedAt(next.updatedAt);
          setConflict(null);
        }
        invalidate('drafts');
        return next;
      } catch (err) {
        const apiError = toApiError(err);
        if (!closedRef.current) {
          if (apiError.code === 'conflict' && isDraft(apiError.details?.current)) setConflict(apiError.details.current);
          setSaveError(apiError);
        }
        throw apiError;
      } finally {
        if (!closedRef.current) setSaving(false);
      }
    },
    [mode, threadId, inReplyToMessageId, toast],
  );

  /** Saves run one at a time, in order. */
  const save = useCallback(
    (force = false): Promise<Draft> => {
      const job = chain.current.then(() => runSave(force));
      chain.current = job.catch(() => undefined);
      return job;
    },
    [runSave],
  );

  // Autosave shortly after the last edit. A conflict pauses it until the user chooses.
  useEffect(() => {
    if (!editTick || conflict || sending) return;
    const timer = setTimeout(() => {
      if (dirtyRef.current && formRef.current.accountId) save().catch(() => undefined);
    }, 1600);
    return () => clearTimeout(timer);
  }, [editTick, conflict, sending, save]);

  useImperativeHandle(
    ref,
    () => ({
      saveBeforeReplace: async () => {
        if (!dirtyRef.current) return true;
        try {
          await save();
          return true;
        } catch {
          return false;
        }
      },
    }),
    [save],
  );

  useEffect(() => {
    if (request.draft || mode === 'new') return;
    // Replies open with the cursor above the quoted text.
    const el = bodyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(0, 0);
      el.scrollTop = 0;
    }
  }, [request.draft, mode]);

  /* ---------------- Closing ---------------- */

  const finish = useCallback(() => {
    closedRef.current = true;
    onClose();
  }, [onClose]);

  const closeAndKeep = async () => {
    if (!dirtyRef.current) {
      finish();
      return;
    }
    try {
      await save();
      toast({ message: 'Saved to Drafts.', action: { label: 'View drafts', run: () => navigate('#/inbox/drafts') } });
      finish();
    } catch {
      setMinimized(false);
    }
  };

  const discard = async () => {
    setDiscarding(true);
    // Let any save in flight settle so the draft it created is the one deleted.
    await chain.current;
    const current = draftRef.current;
    if (!current) {
      finish();
      return;
    }
    try {
      await api.deleteDraft(current.id);
      invalidate('drafts', 'threads');
      refreshBoot();
      toast({ message: 'Draft discarded.' });
      finish();
    } catch (err) {
      setDiscarding(false);
      setConfirmDiscard(false);
      setSaveError(toApiError(err));
    }
  };

  /* ---------------- Attachments ---------------- */

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const incoming = Array.from(files);
    const total = attachedBytes + incoming.reduce((sum, file) => sum + file.size, 0);
    if (total > limit) {
      setProblem(
        `Attachments are limited to ${formatBytes(limit)} per message. These files would bring the total to ${formatBytes(total)}.`,
      );
      return;
    }
    update({
      pending: [
        ...formRef.current.pending,
        ...incoming.map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`, file })),
      ],
    });
  };

  /* ---------------- Sending ---------------- */

  const submit = async (intent: 'send' | 'preview', scheduleAt: Date | null) => {
    const snapshot = formRef.current;
    const acting = account(snapshot.accountId);
    if (!acting) {
      setProblem('Choose a sending account.');
      return;
    }
    if (acting.status === 'reconnect_required') {
      setProblem(`${acting.label} needs to be reconnected before it can send. Open Connections to reconnect it.`);
      return;
    }
    if (snapshot.to.length + snapshot.cc.length + snapshot.bcc.length === 0) {
      setProblem('Add at least one recipient.');
      return;
    }
    if (!snapshot.subject.trim() && !subjectConfirmed) {
      setSubjectConfirmed(true);
      setProblem('This message has no subject. Press send again to send it anyway.');
      return;
    }
    if (scheduleAt && scheduleAt.getTime() <= Date.now() + 30_000) {
      setProblem('Pick a time at least a minute from now.');
      return;
    }

    setScheduleOpen(false);
    setProblem(null);
    setSendError(null);
    setSending(intent === 'preview' ? 'preview' : scheduleAt ? 'schedule' : 'send');
    try {
      const saved = await save();
      const { action } = await api.sendDraft(saved.id, {
        version: saved.version,
        intent,
        scheduleAt: scheduleAt ? toIso(scheduleAt) : null,
      });
      invalidate('threads', 'thread:', 'drafts', 'actions', 'activity', 'brief');
      refreshBoot();

      if (action.state === 'failed') {
        setSendError(action.error?.message ?? 'The message could not be sent.');
        return;
      }
      const review = { label: 'Open approvals', run: () => navigate('#/approvals') };
      if (action.state === 'proposed') {
        toast({ tone: 'ok', message: 'Added to Approvals. Nothing has been sent.', action: review });
      } else if (action.state === 'needs_review') {
        toast({
          tone: 'info',
          message: action.summary ?? 'The send needs a second look before it can go out.',
          action: review,
          durationMs: 9000,
        });
      } else if (action.scheduledAt && action.state !== 'succeeded') {
        toast({
          tone: 'ok',
          message: `Scheduled for ${shortDateTime(action.scheduledAt)} from ${acting.email}.`,
          action: { label: 'View', run: () => navigate('#/approvals/scheduled') },
          durationMs: 8000,
        });
      } else if (action.state === 'succeeded') {
        toast({ tone: 'ok', message: acting.demo ? `Sent from ${acting.email} (simulated — nothing left the sandbox).` : `Sent from ${acting.email}.` });
      } else {
        toast({ tone: 'info', message: `Sending from ${acting.email}…`, action: review });
      }
      finish();
    } catch (err) {
      const apiError = toApiError(err);
      if (apiError.code === 'conflict' && isDraft(apiError.details?.current)) setConflict(apiError.details.current);
      else setSendError(apiError.message);
    } finally {
      if (!closedRef.current) setSending(null);
    }
  };

  const loadTheirs = (theirs: Draft) => {
    draftRef.current = theirs;
    formRef.current = {
      accountId: theirs.accountId,
      fromEmail: theirs.from.email,
      to: theirs.to,
      cc: theirs.cc,
      bcc: theirs.bcc,
      subject: theirs.subject,
      bodyText: theirs.bodyText,
      pending: formRef.current.pending,
      removedIds: [],
    };
    dirtyRef.current = formRef.current.pending.length > 0;
    setDraft(theirs);
    setForm(formRef.current);
    setDirty(dirtyRef.current);
    setSavedAt(theirs.updatedAt);
    setConflict(null);
    setSaveError(null);
  };

  const keepMine = () => {
    setConflict(null);
    save(true).catch(() => undefined);
  };

  /* ---------------- Schedule presets ---------------- */

  const now = new Date();
  const at = (date: Date, hours: number) => set(date, { hours, minutes: 0, seconds: 0, milliseconds: 0 });
  const presets: Array<{ label: string; when: Date }> = [];
  if (now.getHours() < 16) presets.push({ label: 'Later today', when: at(now, 17) });
  presets.push({ label: 'Tomorrow morning', when: at(addDays(now, 1), 8) });
  presets.push({ label: 'Monday morning', when: at(nextMonday(now), 8) });
  const scheduling = boot.capabilities.scheduledSend;

  const busy = sending !== null || discarding;
  const title = MODE_TITLES[mode];
  const status = saving
    ? 'Saving…'
    : saveError
      ? 'Not saved'
      : dirty
        ? 'Unsaved changes'
        : savedAt
          ? `Saved ${listTime(savedAt)}`
          : '';

  if (mailAccounts.length === 0) {
    return (
      <section className="composer" role="dialog" aria-label={title}>
        <header className="composer__head">
          <span className="composer__title">{title}</span>
          <span className="composer__spacer" />
          <IconButton label="Close" className="icon-btn--onink" onClick={finish}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="composer__blocked">
          <p>No connected account can send mail yet. Connect a Google account with Gmail access to write messages.</p>
          <Button
            variant="primary"
            onClick={() => {
              navigate('#/connections');
              finish();
            }}
          >
            Open connections
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className={clsx('composer', minimized && 'composer--min')} role="dialog" aria-label={title}>
      <header className="composer__head">
        <button
          type="button"
          className="composer__headbtn"
          onClick={() => setMinimized((value) => !value)}
          aria-expanded={!minimized}
          aria-label={minimized ? `Expand ${title}` : `Minimize ${title}`}
        >
          <span className="composer__title">{title}</span>
          {(form.subject || request.contextLabel) && (
            <span className="composer__ctx">{form.subject || request.contextLabel}</span>
          )}
          <span className="composer__spacer" />
          {minimized ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        <IconButton label="Save and close" className="icon-btn--onink" onClick={closeAndKeep} disabled={busy}>
          <X size={16} />
        </IconButton>
      </header>

      {!minimized && (
        <>
          <div className="composer__fields">
            <div className="composer__row">
              <label className="composer__label" htmlFor="composer-from">
                From
              </label>
              <span className="composer__from">
                <AccountDot account={sender} />
                <select
                  id="composer-from"
                  className="composer__select"
                  value={`${form.accountId ?? ''}\n${form.fromEmail}`}
                  disabled={busy || fromChoices.length <= 1}
                  onChange={(event) => {
                    const [accountId, fromEmail] = event.target.value.split('\n');
                    update({ accountId: accountId ?? null, fromEmail: fromEmail ?? '' });
                  }}
                >
                  {fromChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
                {sender?.demo && <span className="acct-badge__demo">demo</span>}
              </span>
            </div>
            <div className="composer__row">
              <span className="composer__label">To</span>
              <RecipientInput
                label="To"
                value={form.to}
                onChange={(to) => update({ to })}
                accountId={form.accountId}
                autoFocus={mode === 'new' || mode === 'forward'}
              />
              {!showCc && (
                <button type="button" className="link-btn composer__cc" onClick={() => setShowCc(true)}>
                  Cc Bcc
                </button>
              )}
            </div>
            {showCc && (
              <>
                <div className="composer__row">
                  <span className="composer__label">Cc</span>
                  <RecipientInput label="Cc" value={form.cc} onChange={(cc) => update({ cc })} accountId={form.accountId} />
                </div>
                <div className="composer__row">
                  <span className="composer__label">Bcc</span>
                  <RecipientInput label="Bcc" value={form.bcc} onChange={(bcc) => update({ bcc })} accountId={form.accountId} />
                </div>
              </>
            )}
            <div className="composer__row">
              <label className="composer__label" htmlFor="composer-subject">
                Subject
              </label>
              <input
                id="composer-subject"
                className="composer__subject"
                type="text"
                value={form.subject}
                onChange={(event) => {
                  setSubjectConfirmed(false);
                  update({ subject: event.target.value });
                }}
              />
            </div>
          </div>

          <textarea
            ref={bodyRef}
            className="composer__body"
            aria-label="Message body"
            placeholder="Write your message"
            value={form.bodyText}
            onChange={(event) => update({ bodyText: event.target.value })}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void submit('send', null);
              }
            }}
          />

          {draft && (draft.status === 'scheduled' || draft.status === 'pending_approval') && (
            <p className="composer__note">
              <Clock size={13} aria-hidden="true" />
              {draft.status === 'scheduled'
                ? ` Scheduled to send ${shortDateTime(draft.scheduledAt)}. Editing it pauses that send until you approve the new content.`
                : ' Waiting in Approvals. Editing it means the new content has to be reviewed again.'}
            </p>
          )}
          {draft?.bodyHtml && (
            <p className="composer__note">
              <FileText size={13} aria-hidden="true" /> This draft was formatted in Gmail. Saving it here keeps the
              text and drops the formatting.
            </p>
          )}

          {(serverAttachments.length > 0 || form.pending.length > 0) && (
            <ul className="composer__files" aria-label="Attachments">
              {serverAttachments.map((attachment) => (
                <li key={attachment.id} className="filechip">
                  <Paperclip size={13} aria-hidden="true" />
                  <span className="filechip__name">{attachment.filename}</span>
                  <span className="filechip__size">{formatBytes(attachment.size)}</span>
                  <button
                    type="button"
                    className="chip__x"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() => update({ removedIds: [...formRef.current.removedIds, attachment.id] })}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
              {form.pending.map((item) => (
                <li key={item.id} className="filechip filechip--pending" title="Uploads with the next save">
                  <Paperclip size={13} aria-hidden="true" />
                  <span className="filechip__name">{item.file.name}</span>
                  <span className="filechip__size">{formatBytes(item.file.size)} · not saved yet</span>
                  <button
                    type="button"
                    className="chip__x"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() => update({ pending: formRef.current.pending.filter((p) => p.id !== item.id) })}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {conflict && (
            <div className="notice notice--warn composer__notice" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <div className="notice__text">
                <strong>This draft was changed somewhere else</strong> (last saved {shortDateTime(conflict.updatedAt)}),
                probably in Gmail. Its version reads: “{conflict.subject || '(no subject)'}” —{' '}
                {conflict.bodyText.trim().slice(0, 140) || 'empty body'}
                {conflict.bodyText.trim().length > 140 ? '…' : ''}
                <div className="notice__actions">
                  <Button size="sm" onClick={() => loadTheirs(conflict)}>
                    Load that version
                  </Button>
                  <Button size="sm" variant="primary" onClick={keepMine}>
                    Keep mine and overwrite
                  </Button>
                </div>
              </div>
            </div>
          )}
          {!conflict && saveError && (
            <div className="notice notice--danger composer__notice" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">
                Draft not saved: {saveError.message} <span className="mono-note">({saveError.code})</span>
              </span>
              <button type="button" className="link-btn" onClick={() => save().catch(() => undefined)}>
                Retry
              </button>
            </div>
          )}
          {sendError && (
            <div className="notice notice--danger composer__notice" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">Not sent: {sendError} Your draft is still here.</span>
            </div>
          )}
          {problem && (
            <div className="notice notice--warn composer__notice" role="alert">
              <TriangleAlert size={15} aria-hidden="true" />
              <span className="notice__text">{problem}</span>
            </div>
          )}

          <footer className="composer__foot">
            <div className="split">
              <button
                type="button"
                className="btn btn--accent split__main"
                disabled={busy || Boolean(conflict)}
                onClick={() => void submit('send', null)}
                title="Send now (⌘ Enter)"
              >
                {sending === 'send' ? <Spinner size={14} /> : <Send size={15} aria-hidden="true" />}
                <span>{sending === 'send' ? 'Sending…' : 'Send'}</span>
              </button>
              <Popover
                open={scheduleOpen}
                onClose={() => setScheduleOpen(false)}
                side="top"
                align="start"
                panelClassName="schedule"
                trigger={
                  <button
                    type="button"
                    className="btn btn--accent split__more"
                    aria-label="Schedule or send for approval"
                    aria-haspopup="dialog"
                    aria-expanded={scheduleOpen}
                    disabled={busy || Boolean(conflict)}
                    onClick={() => {
                      if (!customTime) setCustomTime(toDateTimeInput(at(addDays(new Date(), 1), 9)));
                      setScheduleOpen((value) => !value);
                    }}
                  >
                    {sending === 'schedule' || sending === 'preview' ? <Spinner size={14} /> : <ChevronUp size={15} />}
                  </button>
                }
              >
                <div className="schedule__title">
                  <Clock size={14} aria-hidden="true" /> Schedule send
                </div>
                {scheduling.available ? (
                  <>
                    {presets.map((preset) => (
                      <button key={preset.label} type="button" className="menu__item" onClick={() => void submit('send', preset.when)}>
                        <span className="menu__label">{preset.label}</span>
                        <span className="menu__hint">{shortDateTime(toIso(preset.when))}</span>
                      </button>
                    ))}
                    <div className="schedule__custom">
                      <label className="field__label" htmlFor="composer-schedule">
                        Pick a time ({boot.settings.timezone})
                      </label>
                      <div className="schedule__row">
                        <input
                          id="composer-schedule"
                          type="datetime-local"
                          className="input"
                          value={customTime}
                          min={toDateTimeInput(new Date())}
                          onChange={(event) => setCustomTime(event.target.value)}
                        />
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={!customTime}
                          onClick={() => {
                            const when = new Date(customTime);
                            if (Number.isNaN(when.getTime())) setProblem('That time is not valid.');
                            else void submit('send', when);
                          }}
                        >
                          Schedule
                        </Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="schedule__off">{scheduling.reason ?? 'Scheduled sending is not available on this deployment.'}</p>
                )}
                <div className="menu__divider" role="separator" />
                <button type="button" className="menu__item" onClick={() => void submit('preview', null)}>
                  <span className="menu__icon">
                    <ShieldCheck size={15} />
                  </span>
                  <span className="menu__label">Queue for approval instead</span>
                </button>
                <p className="schedule__hint">Adds the exact message to Approvals. Nothing is sent until you approve it there.</p>
              </Popover>
            </div>

            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFiles(event.target.files);
                event.target.value = '';
              }}
            />
            <IconButton
              label={`Attach files (up to ${formatBytes(limit)} per message)`}
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              <Paperclip size={17} />
            </IconButton>
            <span className="composer__limit">
              {attachedBytes > 0 ? `${formatBytes(attachedBytes)} of ${formatBytes(limit)}` : `Up to ${formatBytes(limit)}`}
            </span>

            <span className="composer__spacer" />
            <span className={clsx('composer__status', saveError && 'is-error')} role="status" aria-live="polite">
              {status}
            </span>
            <Button size="sm" variant="ghost" disabled={busy || saving || !dirty} onClick={() => save().catch(() => undefined)}>
              Save
            </Button>
            <IconButton
              label="Discard draft"
              disabled={busy}
              onClick={() => {
                const s = formRef.current;
                const hasContent = Boolean(draftRef.current) || dirtyRef.current || s.to.length > 0;
                if (hasContent) setConfirmDiscard(true);
                else finish();
              }}
            >
              <Trash2 size={16} />
            </IconButton>
          </footer>
        </>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          confirmLabel="Discard"
          danger
          busy={discarding}
          onClose={() => setConfirmDiscard(false)}
          onConfirm={discard}
        >
          <p>
            {draft
              ? `The draft is deleted from ${sender?.email ?? 'the account'}’s Gmail drafts as well. This cannot be undone.`
              : 'What you have written is not saved anywhere yet and will be lost.'}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
