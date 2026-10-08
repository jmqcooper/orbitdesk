'use client';

import clsx from 'clsx';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  Forward,
  Inbox,
  ListPlus,
  MailOpen,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Reply,
  ReplyAll,
  RotateCcw,
  Sparkles,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { displayName, dueLabel, formatAddress, formatBytes, fullDateTime, listTime, safeHref, shortDateTime } from '@/lib/format';
import { invalidate, useResource, useShortcuts } from '@/lib/hooks';
import { composeFromMessage } from '@/lib/mail';
import type { Draft, DraftMode, Id, MailLane, Message, SourceRef, ThreadAction, ThreadActionRequest, ThreadSummary } from '@/lib/types';
import { AccountBadge, useApp, type ComposeRequest } from '../AppContext';
import { TaskDialog } from '../tasks/TaskDialog';
import { Button, ErrorState, IconButton, Kbd, LoadingBlock, Menu, Spinner, type MenuItem } from '../ui';
import { Composer } from './Composer';
import { MessageBody } from './MessageBody';

const VERBS: Record<ThreadAction, string> = {
  archive: 'archive',
  unarchive: 'move to the inbox',
  mark_read: 'mark read',
  mark_unread: 'mark unread',
  star: 'star',
  unstar: 'remove the star',
  trash: 'trash',
  restore: 'restore',
  label: 'change labels',
};

function recipients(message: Message, ownEmail: string | undefined): string {
  const names = [...message.to, ...message.cc].map((address) =>
    ownEmail && address.email.toLowerCase() === ownEmail.toLowerCase() ? 'me' : displayName(address),
  );
  if (!names.length) return '';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

function MessageItem({
  message,
  expanded,
  onToggle,
  ownEmail,
  loadImages,
}: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
  ownEmail: string | undefined;
  loadImages: boolean;
}) {
  const [details, setDetails] = useState(false);
  const files = message.attachments.filter((attachment) => !attachment.inline);
  const to = recipients(message, ownEmail);

  return (
    <article className={clsx('msg', expanded && 'msg--open')}>
      <header className="msg__head">
        <button type="button" className="msg__toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className="msg__name">{message.outgoing ? 'You' : displayName(message.from)}</span>
          {expanded ? to && <span className="msg__to">to {to}</span> : <span className="msg__snippet">{message.snippet || (message.bodyText ?? '').trim().slice(0, 160)}</span>}
        </button>
        {files.length > 0 && !expanded && <Paperclip size={13} className="muted" aria-label={`${files.length} attachments`} />}
        <time className="msg__time num" dateTime={message.sentAt} title={fullDateTime(message.sentAt)}>
          {listTime(message.sentAt)}
        </time>
        {expanded && (
          <IconButton label={details ? 'Hide details' : 'Show details'} onClick={() => setDetails((value) => !value)}>
            {details ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </IconButton>
        )}
      </header>

      {expanded && (
        <div className="msg__content">
          {details && (
            <dl className="msg__details">
              <dt>From</dt>
              <dd>{formatAddress(message.from)}</dd>
              {message.replyTo.length > 0 && (
                <>
                  <dt>Reply-To</dt>
                  <dd>{message.replyTo.map(formatAddress).join(', ')}</dd>
                </>
              )}
              <dt>To</dt>
              <dd>{message.to.map(formatAddress).join(', ') || '—'}</dd>
              {message.cc.length > 0 && (
                <>
                  <dt>Cc</dt>
                  <dd>{message.cc.map(formatAddress).join(', ')}</dd>
                </>
              )}
              {message.bcc.length > 0 && (
                <>
                  <dt>Bcc</dt>
                  <dd>{message.bcc.map(formatAddress).join(', ')}</dd>
                </>
              )}
              <dt>Date</dt>
              <dd>{fullDateTime(message.sentAt)}</dd>
            </dl>
          )}
          <div className="msg__body">
            <MessageBody message={message} loadImages={loadImages} />
          </div>
          {files.length > 0 && (
            <ul className="msg__files" aria-label="Attachments">
              {files.map((attachment) => {
                const href = safeHref(attachment.downloadUrl);
                return (
                  <li key={attachment.id}>
                    {href ? (
                      <a className="filechip filechip--link" href={href} download={attachment.filename}>
                        <Download size={13} aria-hidden="true" />
                        <span className="filechip__name">{attachment.filename}</span>
                        <span className="filechip__size">{formatBytes(attachment.size)}</span>
                      </a>
                    ) : (
                      <span className="filechip" title="This attachment cannot be downloaded right now">
                        <Paperclip size={13} aria-hidden="true" />
                        <span className="filechip__name">{attachment.filename}</span>
                        <span className="filechip__size">unavailable</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export function Thread({
  threadId,
  position,
  onBack,
  onChanged,
  onStep,
  onDone,
}: {
  threadId: Id;
  position: { at: number; of: number } | null;
  onBack: () => void;
  /** Called with the server's updated summary after any change. */
  onChanged: (summary: ThreadSummary) => void;
  onStep: (step: 1 | -1) => void;
  /** The conversation is dealt with (sent, archived, trashed): move on. */
  onDone: () => void;
}) {
  const { boot, account, toast, reportError, refreshBoot, ask, openSettings } = useApp();
  const thread = useResource(`thread:${threadId}`, (signal) => api.thread(threadId, { signal }));
  const drafts = useResource(`drafts:thread:${threadId}`, (signal) => api.drafts({ threadId }, { signal }));
  const [expanded, setExpanded] = useState<Set<Id> | null>(null);
  const [busy, setBusy] = useState<ThreadAction | 'task' | null>(null);
  const [reply, setReply] = useState<(ComposeRequest & { key: number }) | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const markedRef = useRef<Id | null>(null);
  const autoOpened = useRef(false);
  const replyKey = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  const data = thread.data;
  const owner = account(data?.accountId);
  const triage = data?.triage ?? null;

  const apply = (summary: ThreadSummary) => {
    thread.mutate((current) => ({ ...current, ...summary }));
    onChanged(summary);
    refreshBoot();
  };

  const openReply = (request: ComposeRequest) => {
    replyKey.current += 1;
    setReply({ ...request, key: replyKey.current });
    requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  };

  // Opening a conversation marks it read — as an explicit, visible request.
  useEffect(() => {
    if (!data || !data.unread || markedRef.current === data.id) return;
    markedRef.current = data.id;
    api.threadAction(data.id, { action: 'mark_read' }).then(
      (summary) => {
        thread.mutate((current) => ({ ...current, ...summary, messages: current.messages.map((message) => ({ ...message, unread: false })) }));
        onChanged(summary);
        refreshBoot();
      },
      (err) => reportError(err, 'Could not mark it read'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, data?.unread]);

  // A draft that is waiting — the agent's or yours — opens straight into the reply box.
  const editable = (drafts.data?.items ?? []).find((draft) => draft.status === 'draft' || draft.status === 'failed');
  useEffect(() => {
    if (!editable || autoOpened.current) return;
    autoOpened.current = true;
    replyKey.current += 1;
    setReply({ mode: editable.mode, draft: editable, key: replyKey.current });
  }, [editable]);

  const act = async (request: ThreadActionRequest, undo?: ThreadAction) => {
    if (!data) return;
    setBusy(request.action);
    try {
      apply(await api.threadAction(data.id, request));
      if (request.action === 'archive' || request.action === 'trash') {
        toast({
          message: request.action === 'archive' ? 'Archived.' : 'Moved to trash.',
          action: undo
            ? {
                label: 'Undo',
                run: () => {
                  api.threadAction(data.id, { action: undo }).then(
                    (restored) => {
                      onChanged(restored);
                      refreshBoot();
                    },
                    (err) => reportError(err, 'Could not undo'),
                  );
                },
              }
            : undefined,
        });
        onDone();
      }
    } catch (err) {
      reportError(err, `Could not ${VERBS[request.action]}`);
    } finally {
      setBusy(null);
    }
  };

  const startReply = (mode: Exclude<DraftMode, 'new'>) => {
    if (!data) return;
    const last = [...data.messages].reverse().find((message) => !message.outgoing) ?? data.messages[data.messages.length - 1];
    if (!last || !owner) {
      toast({ tone: 'error', message: 'This conversation’s account is no longer connected.' });
      return;
    }
    // One reply at a time: what is already open keeps its text.
    if (reply) return;
    // A draft that was closed earlier is picked up again instead of starting a second one.
    if (editable && mode !== 'forward') {
      openReply({ mode: editable.mode, draft: editable });
      return;
    }
    openReply({ mode, accountId: data.accountId, threadId: data.id, inReplyToMessageId: last.id, fields: composeFromMessage(mode, last, owner) });
  };

  /** Have the agent write (or rewrite) the reply. It lands in the reply box; nothing is sent. */
  const agentDraft = async (instruction?: string): Promise<Draft | null> => {
    if (!data || agentBusy) return null;
    setAgentBusy(true);
    try {
      const result = await api.triageThread(data.id, { redraft: true, instruction });
      apply(result.thread);
      invalidate('drafts');
      if (result.draft) {
        autoOpened.current = true;
        openReply({ mode: result.draft.mode, draft: result.draft });
      }
      return result.draft;
    } catch (err) {
      reportError(err, 'The agent could not draft this');
      return null;
    } finally {
      setAgentBusy(false);
    }
  };

  const setLane = async (lane: Exclude<MailLane, 'waiting'>) => {
    if (!data) return;
    try {
      const result = await api.triageThread(data.id, { lane });
      apply(result.thread);
      toast({ message: `Moved to ${lane === 'fyi' ? 'FYI' : lane === 'reply' ? 'Reply' : 'Other'}.` });
    } catch (err) {
      reportError(err, 'Could not move it');
    }
  };

  const sourceRef: SourceRef | null = data
    ? { kind: 'thread', id: data.id, accountId: data.accountId, title: data.subject || '(no subject)', snippet: data.snippet, url: data.url, occurredAt: data.lastMessageAt }
    : null;

  /** One click: the suggested task goes to this account's list. */
  const addTask = async () => {
    if (!data || !triage?.task || !sourceRef) return;
    const lists = boot.taskLists.filter((list) => list.accountId === data.accountId);
    const list = lists.find((item) => item.id === boot.settings.defaultTaskListId) ?? lists.find((item) => item.isDefault) ?? lists[0];
    if (!list) {
      setTaskOpen(true);
      return;
    }
    setBusy('task');
    try {
      const created = await api.createTask({ taskListId: list.id, title: triage.task.title, due: triage.task.due, notes: triage.summary || null, source: sourceRef });
      const result = await api.triageThread(data.id, { taskDone: true });
      apply(result.thread);
      invalidate('tasks', 'brief');
      toast({
        tone: 'ok',
        message: `Added to ${list.title}.`,
        action: {
          label: 'Undo',
          run: () => {
            Promise.all([api.deleteTask(created.id), api.triageThread(data.id, { taskDone: false })]).then(
              ([, undone]) => {
                apply(undone.thread);
                invalidate('tasks', 'brief');
              },
              (err) => reportError(err, 'Could not undo'),
            );
          },
        },
      });
    } catch (err) {
      reportError(err, 'Could not add the task');
    } finally {
      setBusy(null);
    }
  };

  const dismissTask = async () => {
    if (!data) return;
    try {
      apply((await api.triageThread(data.id, { taskDone: true })).thread);
    } catch (err) {
      reportError(err, 'Could not dismiss it');
    }
  };

  useShortcuts((event) => {
    if (!data) {
      if (event.key === 'Escape') onBack();
      return;
    }
    switch (event.key) {
      case 'Escape':
        onBack();
        break;
      case 'j':
        onStep(1);
        break;
      case 'k':
        onStep(-1);
        break;
      case 'e':
        if (!data.trashed && data.inInbox) void act({ action: 'archive' }, 'unarchive');
        break;
      case '#':
        if (!data.trashed) void act({ action: 'trash' }, 'restore');
        break;
      case 's':
        void act({ action: data.starred ? 'unstar' : 'star' });
        break;
      case 'u':
        markedRef.current = data.id;
        void act({ action: 'mark_unread' }).then(onBack);
        break;
      case 'r':
        event.preventDefault();
        startReply('reply');
        break;
      case 'a':
        event.preventDefault();
        startReply('reply_all');
        break;
      case 'f':
        event.preventDefault();
        startReply('forward');
        break;
      case 'd':
        if (boot.capabilities.agent.available && owner?.assistantAccess) {
          event.preventDefault();
          void agentDraft();
        }
        break;
      default:
    }
  });

  const bar = (
    <header className="bar">
      <IconButton label="Back  ·  Esc" onClick={onBack}>
        <ArrowLeft size={17} />
      </IconButton>
      {data && (
        <>
          <span className="bar__sep" />
          {data.trashed ? (
            <IconButton label="Restore" busy={busy === 'restore'} onClick={() => act({ action: 'restore' })}>
              <RotateCcw size={16} />
            </IconButton>
          ) : (
            <>
              {data.inInbox ? (
                <IconButton label="Archive  ·  E" busy={busy === 'archive'} onClick={() => act({ action: 'archive' }, 'unarchive')}>
                  <Archive size={16} />
                </IconButton>
              ) : (
                <IconButton label="Move to inbox" busy={busy === 'unarchive'} onClick={() => act({ action: 'unarchive' })}>
                  <Inbox size={16} />
                </IconButton>
              )}
              <IconButton label="Trash  ·  #" busy={busy === 'trash'} onClick={() => act({ action: 'trash' }, 'restore')}>
                <Trash2 size={16} />
              </IconButton>
            </>
          )}
          <IconButton
            label="Mark unread  ·  U"
            busy={busy === 'mark_unread'}
            onClick={async () => {
              markedRef.current = data.id;
              await act({ action: 'mark_unread' });
              onBack();
            }}
          >
            <MailOpen size={16} />
          </IconButton>
          <IconButton label={data.starred ? 'Remove star  ·  S' : 'Star  ·  S'} active={data.starred} busy={busy === 'star' || busy === 'unstar'} onClick={() => act({ action: data.starred ? 'unstar' : 'star' })}>
            <Star size={16} fill={data.starred ? 'currentColor' : 'none'} />
          </IconButton>
          <Menu label="More" align="start" button={<MoreHorizontal size={16} />} items={moreItems()} />
        </>
      )}
      <span className="bar__gap" />
      {position && (
        <span className="bar__sub num">
          {position.at} of {position.of}
        </span>
      )}
      {position && (
        <>
          <IconButton label="Previous  ·  K" disabled={position.at <= 1} onClick={() => onStep(-1)}>
            <ChevronUp size={16} />
          </IconButton>
          <IconButton label="Next  ·  J" disabled={position.at >= position.of} onClick={() => onStep(1)}>
            <ChevronDown size={16} />
          </IconButton>
        </>
      )}
    </header>
  );

  function moreItems(): Array<MenuItem | 'divider'> {
    if (!data) return [];
    const labels = boot.labels.filter((label) => label.accountId === data.accountId && label.kind === 'user');
    const items: Array<MenuItem | 'divider'> = [
      { label: 'Add a task', icon: <ListPlus size={15} />, onSelect: () => setTaskOpen(true) },
      { label: 'Ask the agent about this', icon: <MessageCircle size={15} />, onSelect: () => sourceRef && ask({ context: [sourceRef] }) },
    ];
    if (data.inInbox && !data.trashed && triage?.lane !== 'waiting') {
      items.push('divider');
      for (const lane of ['reply', 'fyi', 'other'] as const) {
        items.push({
          key: `lane-${lane}`,
          label: `Move to ${lane === 'fyi' ? 'FYI' : lane === 'reply' ? 'Reply' : 'Other'}`,
          checked: triage?.lane === lane,
          onSelect: () => void setLane(lane),
        });
      }
    }
    if (labels.length) {
      items.push('divider');
      for (const label of labels.slice(0, 12)) {
        const on = data.labelIds.includes(label.id);
        items.push({ key: label.id, label: label.name, checked: on, onSelect: () => void act({ action: 'label', ...(on ? { removeLabelIds: [label.id] } : { addLabelIds: [label.id] }) }) });
      }
    }
    const gmail = safeHref(data.url);
    if (gmail) {
      items.push('divider', { label: 'Open in Gmail', icon: <ExternalLink size={15} />, onSelect: () => window.open(gmail, '_blank', 'noopener') });
    }
    return items;
  }

  if (thread.loading || !data) {
    return (
      <div className="mail">
        {bar}
        <div className="scroll">{thread.loading ? <LoadingBlock label="Opening" /> : thread.error && <ErrorState error={thread.error} onRetry={thread.reload} />}</div>
      </div>
    );
  }

  const openIds = expanded ?? new Set(data.messages.filter((message, index) => index === data.messages.length - 1 || message.unread).map((message) => message.id));
  const toggle = (id: Id) => {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const queued = (drafts.data?.items ?? []).filter((draft) => draft.status === 'scheduled' || draft.status === 'pending_approval' || draft.status === 'sending');
  const agentCan = boot.capabilities.agent.available && Boolean(owner?.assistantAccess);
  const agentNote = reply?.draft && triage?.draft.draftId === reply.draft.id ? (triage.draft.note ?? '') : null;
  const due = triage?.task ? dueLabel(triage.task.due) : null;
  const canReply = !data.trashed && data.messages.length > 0;

  return (
    <div className="mail">
      {bar}
      <div className="scroll">
        <div className="column column--narrow thread">
          <header className="thread__head">
            <h1 className="thread__subject">{data.subject || '(no subject)'}</h1>
            <div className="thread__meta">
              <AccountBadge accountId={data.accountId} showEmail />
              {data.messages.length > 1 && <span>{data.messages.length} messages</span>}
              {data.trashed && <span className="mark mark--urgent">In trash</span>}
            </div>
          </header>

          {triage && (triage.summary || (triage.task && !triage.taskDone)) && (
            <div className="gist">
              <Sparkles size={14} aria-hidden="true" />
              <div className="gist__body">
                {triage.summary && <p className="gist__text">{triage.summary}</p>}
                {triage.task && !triage.taskDone && (
                  <div className="gist__actions">
                    <button type="button" className="suggest" disabled={busy === 'task'} onClick={addTask}>
                      {busy === 'task' ? <Spinner size={12} /> : <ListPlus size={13} aria-hidden="true" />}
                      <span>
                        Add task: {triage.task.title}
                        {due ? ` · ${due.text}` : ''}
                      </span>
                    </button>
                    <IconButton label="Dismiss suggestion" onClick={dismissTask}>
                      <X size={13} />
                    </IconButton>
                  </div>
                )}
              </div>
            </div>
          )}

          {owner?.status === 'reconnect_required' && (
            <div className="notice notice--warn" role="status">
              <span className="notice__text">{owner.label} needs reconnecting before you can reply or change anything.</span>
              <button type="button" className="link-btn" onClick={() => openSettings('accounts')}>
                Reconnect
              </button>
            </div>
          )}

          <div className="thread__messages">
            {data.messages.map((message) => (
              <MessageItem
                key={message.id}
                message={message}
                expanded={openIds.has(message.id)}
                onToggle={() => toggle(message.id)}
                ownEmail={owner?.email}
                loadImages={boot.settings.loadRemoteImages}
              />
            ))}
          </div>

          {queued.map((draft) => (
            <p key={draft.id} className="queued">
              <Clock size={13} aria-hidden="true" />
              {draft.status === 'scheduled' ? `Your reply is scheduled for ${shortDateTime(draft.scheduledAt)}.` : draft.status === 'sending' ? 'Your reply is sending.' : 'Your reply is waiting for your OK in the agent panel.'}
            </p>
          ))}

          {canReply &&
            (reply ? (
              <Composer
                key={reply.key}
                variant="reply"
                request={reply}
                agentNote={agentNote}
                agentBusy={agentBusy}
                onAgent={agentCan ? agentDraft : undefined}
                onClose={() => setReply(null)}
                onSent={() => {
                  setReply(null);
                  onDone();
                }}
              />
            ) : (
              <div className="replybar">
                {agentCan && (
                  <Button variant="agent" icon={<Sparkles size={14} />} busy={agentBusy} onClick={() => void agentDraft()}>
                    {agentBusy ? 'Drafting' : 'Draft reply'}
                    {!agentBusy && <Kbd>D</Kbd>}
                  </Button>
                )}
                <Button variant={agentCan ? 'ghost' : 'outline'} icon={<Reply size={14} />} onClick={() => startReply('reply')}>
                  Reply
                </Button>
                <Button variant="ghost" icon={<ReplyAll size={14} />} onClick={() => startReply('reply_all')}>
                  Reply all
                </Button>
                <Button variant="ghost" icon={<Forward size={14} />} onClick={() => startReply('forward')}>
                  Forward
                </Button>
              </div>
            ))}
          <div ref={endRef} />
        </div>
      </div>

      {taskOpen && sourceRef && (
        <TaskDialog
          onClose={() => setTaskOpen(false)}
          initial={{ title: triage?.task?.title ?? data.subject, notes: triage?.summary || data.snippet, due: triage?.task?.due ?? null, accountId: data.accountId, source: sourceRef }}
        />
      )}
    </div>
  );
}
