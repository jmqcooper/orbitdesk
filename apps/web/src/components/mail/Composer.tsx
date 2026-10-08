'use client';

import clsx from 'clsx';
import { addDays, nextMonday, set } from 'date-fns';
import { ArrowUp, ChevronDown, Clock, MoreHorizontal, Paperclip, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react';
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { canAct, defaultIdentity, hasPermission, identitiesOf } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { displayName, formatBytes, listTime, shortDateTime, toDateTimeInput, toIso } from '@/lib/format';
import { invalidate } from '@/lib/hooks';
import { blankCompose, fileToBase64, splitQuote } from '@/lib/mail';
import type { Address, Attachment, Draft, DraftMode, Id } from '@/lib/types';
import { AccountDot, useApp, type ComposeRequest } from '../AppContext';
import { Button, ConfirmDialog, IconButton, Kbd, Popover, Spinner } from '../ui';
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

/**
 * One editor, two shapes: `reply` sits at the foot of a conversation with the
 * quoted original tucked away; `sheet` floats for a new message or a forward.
 * Every save is a real Gmail draft in the sending account.
 */
export function Composer({
  ref,
  request,
  variant = 'sheet',
  agentNote = null,
  agentBusy = false,
  onAgent,
  onClose,
  onSent,
}: {
  ref?: Ref<ComposerHandle>;
  request: ComposeRequest;
  variant?: 'sheet' | 'reply';
  /** Non-null when the agent wrote the draft on screen; holds what it checked or assumed. */
  agentNote?: string | null;
  agentBusy?: boolean;
  /** Ask the agent to write this reply again, optionally steered. The parent swaps in the result. */
  onAgent?: (instruction?: string) => Promise<Draft | null>;
  onClose: () => void;
  /** Called instead of `onClose` once the message has gone (or is queued to go). */
  onSent?: () => void;
}) {
  const { boot, account, toast, navigate, refreshBoot, setAgentOpen, openSettings } = useApp();
  const mode: DraftMode = request.draft?.mode ?? request.mode;
  const inline = variant === 'reply';
  const threadId = request.draft?.threadId ?? request.threadId ?? null;
  const inReplyToMessageId = request.draft?.inReplyToMessageId ?? request.inReplyToMessageId ?? null;

  const mailAccounts = boot.connections.filter((connection) => hasPermission(connection, 'mail'));

  const [form, setForm] = useState<FormState>(() => {
    if (request.draft) {
      const d = request.draft;
      return { accountId: d.accountId, fromEmail: d.from?.email ?? '', to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, bodyText: d.bodyText, pending: [], removedIds: [] };
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
  const [gone, setGone] = useState(false);
  const [sending, setSending] = useState<null | 'send' | 'schedule'>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [subjectConfirmed, setSubjectConfirmed] = useState(false);
  const [showCc, setShowCc] = useState(() => form.bcc.length > 0 || (!inline && form.cc.length > 0));
  const [showFields, setShowFields] = useState(() => !inline || mode === 'forward');
  const [showQuote, setShowQuote] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [customTime, setCustomTime] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [instruction, setInstruction] = useState('');

  // The save pipeline reads the latest values from refs so queued saves never use a stale render.
  const formRef = useRef(form);
  const draftRef = useRef(draft);
  const dirtyRef = useRef(false);
  const editSeq = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const closedRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLElement>(null);

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
  const attachedBytes = serverAttachments.reduce((sum, a) => sum + a.size, 0) + form.pending.reduce((sum, p) => sum + p.file.size, 0);

  /* ---------------- Saving ---------------- */

  /**
   * The server refused because the draft is not what this composer last saw — edited or
   * removed in Gmail. Find out which, so the user chooses instead of overwriting blindly.
   */
  const handleStale = useCallback(async (error: ApiRequestError) => {
    if (error.code !== 'conflict' && error.code !== 'not_found') return;
    if (isDraft(error.details?.current)) {
      setConflict(error.details.current);
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    try {
      const list = await api.drafts({ accountId: current.accountId, threadId: current.threadId ?? undefined, limit: 100 });
      if (closedRef.current) return;
      const latest = list.items.find((item) => item.id === current.id);
      if (latest) {
        if (latest.version !== current.version) setConflict(latest);
      } else if (list.nextCursor === null) {
        // Only when the whole list was read is its absence proof that the draft is gone.
        setGone(true);
      }
    } catch {
      // The error already on screen says what happened; the lookup adds nothing if it fails too.
    }
  }, []);

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
              toast({ tone: 'error', message: `The earlier copy of this draft could not be removed from the previous account: ${toApiError(err).message}` });
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
          setSaveError(apiError);
          void handleStale(apiError);
        }
        throw apiError;
      } finally {
        if (!closedRef.current) setSaving(false);
      }
    },
    [mode, threadId, inReplyToMessageId, toast, handleStale],
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
    if (!editTick || conflict || gone || sending) return;
    const timer = setTimeout(() => {
      if (dirtyRef.current && formRef.current.accountId) save().catch(() => undefined);
    }, 1600);
    return () => clearTimeout(timer);
  }, [editTick, conflict, gone, sending, save]);

  // Leaving the page inside the autosave window would lose the last edits.
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);

  // A reply box that goes away (next conversation, back to the list) keeps what was typed.
  useEffect(() => {
    closedRef.current = false;
    return () => {
      if (!closedRef.current && dirtyRef.current && formRef.current.accountId) runSave(false).catch(() => undefined);
      closedRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // A reply the user asked for starts with the cursor in it; a waiting draft does not steal focus.
  useEffect(() => {
    if (request.draft || mode === 'new') return;
    const el = bodyRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(0, 0);
      el.scrollTop = 0;
    }
  }, [request.draft, mode]);

  // The quoted original is found once, when the editor opens, and kept out of the text box
  // for as long as the body still ends with it.
  const [quoted] = useState(() => (inline ? splitQuote(form.bodyText).tail : ''));
  const tucked = inline && !showQuote && quoted !== '' && form.bodyText.endsWith(quoted);
  const quote = tucked
    ? { head: form.bodyText.slice(0, form.bodyText.length - quoted.length).replace(/\n{1,2}$/, ''), tail: quoted }
    : { head: form.bodyText, tail: '' };

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !inline) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 88), window.innerHeight * 0.6)}px`;
  }, [quote.head, inline]);

  /* ---------------- Closing ---------------- */

  const finish = useCallback(
    (sent = false) => {
      closedRef.current = true;
      if (sent && onSent) onSent();
      else onClose();
    },
    [onClose, onSent],
  );

  const closeAndKeep = async () => {
    if (!dirtyRef.current) {
      finish();
      return;
    }
    try {
      await save();
      if (!inline) toast({ message: 'Saved to Drafts.', action: { label: 'View', run: () => navigate('#/mail/drafts') } });
      finish();
    } catch {
      // The reason is on screen; the editor stays open.
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
      setProblem(`Attachments are limited to ${formatBytes(limit)} per message. These would bring the total to ${formatBytes(total)}.`);
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

  const submit = async (scheduleAt: Date | null) => {
    const snapshot = formRef.current;
    const acting = account(snapshot.accountId);
    if (!acting) {
      setProblem('Choose a sending account.');
      return;
    }
    if (acting.status === 'reconnect_required') {
      setProblem(`${acting.label} needs to be reconnected before it can send.`);
      return;
    }
    if (snapshot.to.length + snapshot.cc.length + snapshot.bcc.length === 0) {
      setShowFields(true);
      setProblem('Add at least one recipient.');
      return;
    }
    if (!snapshot.subject.trim() && !subjectConfirmed) {
      setSubjectConfirmed(true);
      setProblem('No subject. Send again to send it anyway.');
      return;
    }
    if (scheduleAt && scheduleAt.getTime() <= Date.now() + 30_000) {
      setProblem('Pick a time at least a minute from now.');
      return;
    }

    setScheduleOpen(false);
    setProblem(null);
    setSendError(null);
    setSending(scheduleAt ? 'schedule' : 'send');
    try {
      let saved: Draft;
      try {
        saved = await save();
      } catch {
        // The save step has already put its reason on screen; nothing was sent.
        return;
      }
      const { action } = await api.sendDraft(saved.id, { version: saved.version, intent: 'send', scheduleAt: scheduleAt ? toIso(scheduleAt) : null });
      invalidate('threads', 'thread:', 'drafts', 'actions', 'activity', 'brief');
      refreshBoot();

      if (action.state === 'failed') {
        setSendError(action.error?.message ?? 'The message could not be sent.');
        return;
      }
      const review = { label: 'View', run: () => setAgentOpen(true) };
      if (action.state === 'needs_review') {
        toast({ tone: 'error', message: `Not confirmed as sent. ${action.error?.message ?? 'Check Sent in Gmail before trying again.'}`, action: review, durationMs: 12_000 });
      } else if (action.scheduledAt && action.state !== 'succeeded') {
        toast({ tone: 'ok', message: `Scheduled for ${shortDateTime(action.scheduledAt)} from ${acting.label}.`, action: review, durationMs: 8000 });
      } else if (action.state === 'succeeded') {
        toast({ tone: 'ok', message: acting.demo ? `Sent from ${acting.label} — simulated, nothing left the sandbox.` : `Sent from ${acting.label}.` });
      } else {
        toast({ tone: 'info', message: `Sending from ${acting.label}…`, action: review });
      }
      finish(true);
    } catch (err) {
      const apiError = toApiError(err);
      setSendError(apiError.message);
      void handleStale(apiError);
    } finally {
      if (!closedRef.current) setSending(null);
    }
  };

  const loadTheirs = (theirs: Draft) => {
    draftRef.current = theirs;
    formRef.current = {
      accountId: theirs.accountId,
      fromEmail: theirs.from?.email ?? '',
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

  /** Keep this composer's text, saved on top of the other version the user has now seen. */
  const keepMine = (theirs: Draft) => {
    draftRef.current = theirs;
    dirtyRef.current = true;
    setDraft(theirs);
    setDirty(true);
    setConflict(null);
    setSaveError(null);
    setSendError(null);
    save(true).catch(() => undefined);
  };

  /** The Gmail draft is gone; what is on screen becomes a fresh draft. */
  const saveAsNew = () => {
    draftRef.current = null;
    dirtyRef.current = true;
    formRef.current = { ...formRef.current, removedIds: [] };
    setDraft(null);
    setForm(formRef.current);
    setDirty(true);
    setGone(false);
    setSaveError(null);
    setSendError(null);
    save().catch(() => undefined);
  };

  /** Hand the reply to the agent. What is typed is saved first so it can build on it. */
  const rewrite = async () => {
    if (!onAgent || agentBusy) return;
    if (dirtyRef.current) {
      try {
        await save();
      } catch {
        return;
      }
    }
    const text = instruction.trim();
    // The parent replaces this editor with the new draft; nothing here is dirty any more.
    closedRef.current = true;
    const result = await onAgent(text || undefined);
    if (!result) closedRef.current = false;
    else setInstruction('');
  };

  const busy = sending !== null || discarding || agentBusy;
  const blocked = busy || Boolean(conflict) || gone;

  // ⌘↵ sends from anywhere while a reply box is open, not only from inside the text.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (!inline) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !document.querySelector('dialog[open]')) {
        if (rootRef.current?.contains(event.target as Node) && (event.target as HTMLElement).dataset.agentInput) return;
        event.preventDefault();
        if (!blocked) void submitRef.current(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [inline, blocked]);

  /* ---------------- Schedule presets ---------------- */

  const now = new Date();
  const at = (date: Date, hours: number) => set(date, { hours, minutes: 0, seconds: 0, milliseconds: 0 });
  const presets: Array<{ label: string; when: Date }> = [];
  if (now.getHours() < 16) presets.push({ label: 'Later today', when: at(now, 17) });
  presets.push({ label: 'Tomorrow morning', when: at(addDays(now, 1), 8) });
  presets.push({ label: 'Monday morning', when: at(nextMonday(now), 8) });
  const scheduling = boot.capabilities.scheduledSend;

  const title = MODE_TITLES[mode];
  const status = saving ? 'Saving…' : saveError ? 'Not saved' : dirty ? '' : savedAt ? `Saved ${listTime(savedAt)}` : '';
  const everyone = [...form.to, ...form.cc, ...form.bcc];
  const byAgent = agentNote !== null && !dirty && !agentBusy;

  if (mailAccounts.length === 0) {
    return (
      <section className={clsx('composer', inline ? 'composer--reply' : 'composer--sheet')} role="group" aria-label={title}>
        <div className="composer__blocked">
          <p>No connected account can send mail yet.</p>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              openSettings('accounts');
              finish();
            }}
          >
            Connect one
          </Button>
        </div>
      </section>
    );
  }

  const fields = showFields && (
    <div className="composer__fields">
      {(!inline || fromChoices.length > 1) && (
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
          </span>
        </div>
      )}
      <div className="composer__row">
        <span className="composer__label">To</span>
        <RecipientInput label="To" value={form.to} onChange={(to) => update({ to })} accountId={form.accountId} autoFocus={!inline && (mode === 'new' || mode === 'forward')} />
        {!showCc && (
          <button type="button" className="composer__cc" onClick={() => setShowCc(true)}>
            Cc Bcc
          </button>
        )}
      </div>
      {(showCc || form.cc.length > 0) && (
        <div className="composer__row">
          <span className="composer__label">Cc</span>
          <RecipientInput label="Cc" value={form.cc} onChange={(cc) => update({ cc })} accountId={form.accountId} />
        </div>
      )}
      {showCc && (
        <div className="composer__row">
          <span className="composer__label">Bcc</span>
          <RecipientInput label="Bcc" value={form.bcc} onChange={(bcc) => update({ bcc })} accountId={form.accountId} />
        </div>
      )}
      {(!inline || mode === 'forward') && (
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
      )}
    </div>
  );

  const notices = (
    <>
      {draft?.bodyHtml && <p className="composer__note">Formatted in Gmail. Saving here keeps the text and drops the formatting.</p>}
      {(serverAttachments.length > 0 || form.pending.length > 0) && (
        <ul className="composer__files" aria-label="Attachments">
          {serverAttachments.map((attachment) => (
            <li key={attachment.id} className="filechip">
              <Paperclip size={13} aria-hidden="true" />
              <span className="filechip__name">{attachment.filename}</span>
              <span className="filechip__size">{formatBytes(attachment.size)}</span>
              <button type="button" className="chip__x" aria-label={`Remove ${attachment.filename}`} onClick={() => update({ removedIds: [...formRef.current.removedIds, attachment.id] })}>
                <X size={12} />
              </button>
            </li>
          ))}
          {form.pending.map((item) => (
            <li key={item.id} className="filechip" title="Uploads with the next save">
              <Paperclip size={13} aria-hidden="true" />
              <span className="filechip__name">{item.file.name}</span>
              <span className="filechip__size">{formatBytes(item.file.size)}</span>
              <button type="button" className="chip__x" aria-label={`Remove ${item.file.name}`} onClick={() => update({ pending: formRef.current.pending.filter((p) => p.id !== item.id) })}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {conflict && (
        <div className="notice notice--warn composer__notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div className="notice__text">
            <strong>This draft was changed somewhere else</strong>, probably in Gmail ({shortDateTime(conflict.updatedAt)}). It now reads: “
            {conflict.bodyText.trim().slice(0, 120) || 'empty'}
            {conflict.bodyText.trim().length > 120 ? '…' : ''}”
            <div className="notice__actions">
              <Button size="sm" onClick={() => loadTheirs(conflict)}>
                Use that version
              </Button>
              <Button size="sm" variant="primary" onClick={() => keepMine(conflict)}>
                Keep mine
              </Button>
            </div>
          </div>
        </div>
      )}
      {gone && !conflict && (
        <div className="notice notice--warn composer__notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <div className="notice__text">
            <strong>This draft is no longer in Gmail.</strong> It may have been sent or deleted there. Your text is still here.
            <div className="notice__actions">
              <Button size="sm" variant="primary" onClick={saveAsNew}>
                Save as a new draft
              </Button>
            </div>
          </div>
        </div>
      )}
      {!conflict && !gone && saveError && (
        <div className="notice notice--danger composer__notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="notice__text">Not saved: {saveError.message}</span>
          <button type="button" className="link-btn" onClick={() => save().catch(() => undefined)}>
            Retry
          </button>
        </div>
      )}
      {sendError && (
        <div className="notice notice--danger composer__notice" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          <span className="notice__text">Not sent: {sendError} Your draft is still here.</span>
        </div>
      )}
      {problem && (
        <div className="notice notice--warn composer__notice" role="alert">
          <span className="notice__text">{problem}</span>
        </div>
      )}
    </>
  );

  const footer = (
    <footer className="composer__foot">
      <div className="split">
        <button type="button" className="btn btn--primary split__main" disabled={blocked} onClick={() => void submit(null)} title="Send  ·  ⌘↵">
          {sending === 'send' ? <Spinner size={14} /> : null}
          <span>{sending === 'send' ? 'Sending' : 'Send'}</span>
          {sending !== 'send' && <Kbd>⌘↵</Kbd>}
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
              className="btn btn--primary split__more"
              aria-label="Send later"
              title="Send later"
              aria-haspopup="dialog"
              aria-expanded={scheduleOpen}
              disabled={blocked}
              onClick={() => {
                if (!customTime) setCustomTime(toDateTimeInput(at(addDays(new Date(), 1), 9)));
                setScheduleOpen((value) => !value);
              }}
            >
              {sending === 'schedule' ? <Spinner size={14} /> : <ChevronDown size={14} />}
            </button>
          }
        >
          <div className="menu__title">Send later</div>
          {scheduling.available ? (
            <>
              {presets.map((preset) => (
                <button key={preset.label} type="button" className="menu__item" onClick={() => void submit(preset.when)}>
                  <span className="menu__icon">
                    <Clock size={14} />
                  </span>
                  <span className="menu__label">{preset.label}</span>
                  <span className="menu__hint">{shortDateTime(toIso(preset.when))}</span>
                </button>
              ))}
              <div className="schedule__custom">
                <input
                  type="datetime-local"
                  className="input input--sm"
                  aria-label={`Pick a time (${boot.settings.timezone})`}
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
                    else void submit(when);
                  }}
                >
                  Schedule
                </Button>
              </div>
            </>
          ) : (
            <p className="schedule__off">{scheduling.reason ?? 'Scheduled sending is not available right now.'}</p>
          )}
        </Popover>
      </div>

      {inline && onAgent && (
        <form
          className="agentask"
          onSubmit={(event) => {
            event.preventDefault();
            void rewrite();
          }}
        >
          {agentBusy ? <Spinner size={13} /> : <Sparkles size={13} aria-hidden="true" />}
          <input
            className="agentask__input"
            type="text"
            data-agent-input="true"
            aria-label="Tell the agent how to change this reply"
            placeholder={agentBusy ? 'Writing…' : draft || form.bodyText.trim() ? 'Tell the agent what to change' : 'Tell the agent what to say'}
            value={instruction}
            disabled={busy}
            onChange={(event) => setInstruction(event.target.value)}
          />
          {instruction.trim() && (
            <button type="submit" className="agentask__go" aria-label="Rewrite" disabled={busy}>
              <ArrowUp size={13} />
            </button>
          )}
        </form>
      )}

      <span className="spacer" />
      <span className={clsx('composer__status', saveError && 'is-error')} role="status" aria-live="polite">
        {status}
      </span>
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
      <IconButton label={`Attach  ·  up to ${formatBytes(limit)}`} onClick={() => fileInput.current?.click()} disabled={busy}>
        <Paperclip size={16} />
      </IconButton>
      <IconButton
        label="Discard"
        disabled={busy}
        onClick={() => {
          const s = formRef.current;
          if (draftRef.current || dirtyRef.current || s.to.length > 0) setConfirmDiscard(true);
          else finish();
        }}
      >
        <Trash2 size={16} />
      </IconButton>
    </footer>
  );

  const body = (
    <textarea
      ref={bodyRef}
      className="composer__body"
      aria-label="Message"
      placeholder={inline ? 'Write a reply' : 'Write your message'}
      value={quote.head}
      disabled={agentBusy}
      onChange={(event) => update({ bodyText: quote.tail ? `${event.target.value}\n\n${quote.tail}` : event.target.value })}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (!blocked) void submit(null);
        } else if (event.key === 'Escape' && inline) {
          // Step out of the text so the conversation's single-key shortcuts work again.
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );

  const confirm = confirmDiscard && (
    <ConfirmDialog title="Discard this draft?" confirmLabel="Discard" danger busy={discarding} onClose={() => setConfirmDiscard(false)} onConfirm={discard}>
      <p>{draft ? `It is deleted from ${sender?.email ?? 'the account'}’s Gmail drafts as well.` : 'What you wrote is not saved anywhere yet.'}</p>
    </ConfirmDialog>
  );

  if (inline) {
    return (
      <section ref={rootRef} className={clsx('composer composer--reply', byAgent && 'composer--agent', agentBusy && 'is-writing')} role="group" aria-label={title}>
        <header className="composer__head">
          <button type="button" className="composer__summary" onClick={() => setShowFields((value) => !value)} aria-expanded={showFields} title="Edit recipients">
            <span className="composer__mode">{title}</span>
            {!showFields && (
              <span className="composer__to">
                {everyone.length ? `to ${everyone.slice(0, 3).map((a) => displayName(a)).join(', ')}${everyone.length > 3 ? ` +${everyone.length - 3}` : ''}` : 'no recipients yet'}
              </span>
            )}
            <MoreHorizontal size={14} aria-hidden="true" />
          </button>
          <span className="spacer" />
          {byAgent && (
            <span className="composer__by" title={agentNote || undefined}>
              <Sparkles size={12} aria-hidden="true" />
              {agentNote ? `Drafted · ${agentNote}` : 'Drafted by the agent'}
            </span>
          )}
          <IconButton label="Close  ·  kept as a draft" onClick={closeAndKeep} disabled={busy}>
            <X size={15} />
          </IconButton>
        </header>
        {fields}
        {body}
        {quote.tail && (
          <button type="button" className="composer__quote" onClick={() => setShowQuote(true)} title="Show quoted text" aria-label="Show quoted text">
            <MoreHorizontal size={14} />
          </button>
        )}
        {notices}
        {footer}
        {confirm}
      </section>
    );
  }

  return (
    <section ref={rootRef} className="composer composer--sheet" role="dialog" aria-label={title}>
      <header className="composer__head">
        <span className="composer__mode">{title}</span>
        <span className="spacer" />
        <IconButton label="Close  ·  kept as a draft" onClick={closeAndKeep} disabled={busy}>
          <X size={15} />
        </IconButton>
      </header>
      {fields}
      {body}
      {notices}
      {footer}
      {confirm}
    </section>
  );
}
