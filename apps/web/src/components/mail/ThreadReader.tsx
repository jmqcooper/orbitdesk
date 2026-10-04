'use client';

import clsx from 'clsx';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Download,
  ExternalLink,
  Forward,
  Inbox,
  ListPlus,
  MailOpen,
  Paperclip,
  PenLine,
  Reply,
  ReplyAll,
  RotateCcw,
  Sparkles,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { displayName, formatAddress, formatBytes, fullDateTime, initials, listTime, safeColor, safeHref } from '@/lib/format';
import { useResource } from '@/lib/hooks';
import { composeFromMessage } from '@/lib/mail';
import type { DraftMode, Id, Message, SourceRef, ThreadAction, ThreadActionRequest, ThreadSummary } from '@/lib/types';
import { AccountBadge, useApp } from '../AppContext';
import { TaskDialog } from '../tasks/TaskDialog';
import { Button, ErrorState, IconButton, LoadingBlock, Menu, Pill, StaleNotice } from '../ui';
import { MessageBody } from './MessageBody';

const ACTION_VERBS: Record<ThreadAction, string> = {
  archive: 'archive the conversation',
  unarchive: 'move the conversation to the inbox',
  mark_read: 'mark the conversation read',
  mark_unread: 'mark the conversation unread',
  star: 'star the conversation',
  unstar: 'remove the star',
  trash: 'move the conversation to trash',
  restore: 'restore the conversation',
  label: 'change labels',
};

function recipientSummary(message: Message, ownEmail: string | undefined): string {
  const names = [...message.to, ...message.cc].map((address) =>
    ownEmail && address.email.toLowerCase() === ownEmail.toLowerCase() ? 'me' : displayName(address),
  );
  if (!names.length) return 'no visible recipients';
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} +${names.length - 3}`;
}

function MessageCard({
  message,
  expanded,
  onToggle,
  ownEmail,
  loadImages,
  onReply,
}: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
  ownEmail: string | undefined;
  loadImages: boolean;
  onReply: (mode: Exclude<DraftMode, 'new'>, message: Message) => void;
}) {
  const [details, setDetails] = useState(false);
  const sender = message.outgoing ? 'me' : displayName(message.from);
  const files = message.attachments.filter((attachment) => !attachment.inline);

  return (
    <article className={clsx('msg', expanded ? 'msg--open' : 'msg--closed', message.unread && 'msg--unread')}>
      <header className="msg__head">
        <span className="avatar" style={{ background: safeColor(null, message.from.email) }} aria-hidden="true">
          {initials(message.from.name || message.from.email)}
        </span>
        <button type="button" className="msg__toggle" onClick={onToggle} aria-expanded={expanded}>
          <span className="msg__from">
            <span className="msg__name">{sender}</span>
            {expanded && <span className="msg__email">{message.from.email}</span>}
          </span>
          {expanded ? (
            <span className="msg__to">to {recipientSummary(message, ownEmail)}</span>
          ) : (
            <span className="msg__snippet">{message.snippet}</span>
          )}
        </button>
        <span className="msg__meta">
          {files.length > 0 && <Paperclip size={13} aria-label={`${files.length} attachments`} />}
          <time dateTime={message.sentAt} title={fullDateTime(message.sentAt)}>
            {listTime(message.sentAt)}
          </time>
        </span>
        {expanded && (
          <span className="msg__actions">
            <IconButton label="Reply" onClick={() => onReply('reply', message)}>
              <Reply size={16} />
            </IconButton>
            <Menu
              label="More message actions"
              button={<ChevronDown size={16} />}
              items={[
                { label: 'Reply all', icon: <ReplyAll size={15} />, onSelect: () => onReply('reply_all', message) },
                { label: 'Forward', icon: <Forward size={15} />, onSelect: () => onReply('forward', message) },
                { label: details ? 'Hide details' : 'Show details', onSelect: () => setDetails((value) => !value) },
              ]}
            />
          </span>
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
              <dt>Subject</dt>
              <dd>{message.subject}</dd>
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
                        <span className="filechip__size">{formatBytes(attachment.size)} · unavailable</span>
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

export function ThreadReader({
  threadId,
  onBack,
  onChanged,
}: {
  threadId: Id;
  onBack: () => void;
  /** Called with the server's updated summary after any thread action. */
  onChanged: (summary: ThreadSummary) => void;
}) {
  const { boot, account, compose, toast, reportError, refreshBoot, navigate, setAssistantSeed } = useApp();
  const thread = useResource(`thread:${threadId}`, (signal) => api.thread(threadId, { signal }));
  const drafts = useResource(`drafts:thread:${threadId}`, (signal) => api.drafts({ threadId }, { signal }));
  const [expanded, setExpanded] = useState<Set<Id> | null>(null);
  const [busy, setBusy] = useState<ThreadAction | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const markedRef = useRef<Id | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const data = thread.data;
  const owner = account(data?.accountId);

  const apply = (summary: ThreadSummary) => {
    thread.mutate((current) => ({ ...current, ...summary }));
    onChanged(summary);
    refreshBoot();
  };

  // Opening a conversation marks it read — as an explicit, visible request.
  useEffect(() => {
    if (!data || !data.unread || markedRef.current === data.id) return;
    markedRef.current = data.id;
    api.threadAction(data.id, { action: 'mark_read' }).then(
      (summary) => {
        thread.mutate((current) => ({
          ...current,
          ...summary,
          messages: current.messages.map((message) => ({ ...message, unread: false })),
        }));
        onChanged(summary);
        refreshBoot();
      },
      (err) => reportError(err, 'Could not mark the conversation read'),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, data?.unread]);

  useEffect(() => {
    if (data) headingRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id]);

  if (thread.loading) {
    return (
      <div className="reader">
        <ReaderBar onBack={onBack} />
        <LoadingBlock label="Loading the full conversation" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="reader">
        <ReaderBar onBack={onBack} />
        {thread.error && <ErrorState error={thread.error} onRetry={thread.reload} />}
      </div>
    );
  }

  const openIds =
    expanded ??
    new Set(
      data.messages
        .filter((message, index) => index === data.messages.length - 1 || message.unread)
        .map((message) => message.id),
    );
  const toggle = (id: Id) => {
    const next = new Set(openIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const act = async (request: ThreadActionRequest, undo?: ThreadAction) => {
    setBusy(request.action);
    try {
      const summary = await api.threadAction(data.id, request);
      apply(summary);
      if (request.action === 'archive' || request.action === 'trash') {
        toast({
          message: request.action === 'archive' ? 'Conversation archived.' : 'Moved to trash.',
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
        onBack();
      }
    } catch (err) {
      reportError(err, `Could not ${ACTION_VERBS[request.action]}`);
    } finally {
      setBusy(null);
    }
  };

  const startReply = (mode: Exclude<DraftMode, 'new'>, message: Message) => {
    if (!owner) {
      toast({ tone: 'error', message: 'The account this conversation belongs to is no longer connected.' });
      return;
    }
    compose({
      mode,
      accountId: data.accountId,
      threadId: data.id,
      inReplyToMessageId: message.id,
      fields: composeFromMessage(mode, message, owner),
      contextLabel: data.subject,
    });
  };

  const last = data.messages[data.messages.length - 1];
  const sourceRef: SourceRef = {
    kind: 'thread',
    id: data.id,
    accountId: data.accountId,
    title: data.subject || '(no subject)',
    snippet: data.snippet,
    url: data.url,
    occurredAt: data.lastMessageAt,
  };
  const ask = (text: string, send: boolean) => {
    setAssistantSeed({ text, context: [sourceRef], send });
    navigate('#/assistant');
  };

  const accountLabels = boot.labels.filter((label) => label.accountId === data.accountId && label.kind === 'user');
  const threadLabels = accountLabels.filter((label) => data.labelIds.includes(label.id));
  const gmailHref = safeHref(data.url);
  const threadDrafts = drafts.data?.items ?? [];

  return (
    <div className="reader">
      <ReaderBar onBack={onBack}>
        {data.trashed ? (
          <IconButton label="Restore from trash" busy={busy === 'restore'} onClick={() => act({ action: 'restore' })}>
            <RotateCcw size={17} />
          </IconButton>
        ) : (
          <>
            {data.inInbox ? (
              <IconButton label="Archive" busy={busy === 'archive'} onClick={() => act({ action: 'archive' }, 'unarchive')}>
                <Archive size={17} />
              </IconButton>
            ) : (
              <IconButton label="Move to inbox" busy={busy === 'unarchive'} onClick={() => act({ action: 'unarchive' })}>
                <Inbox size={17} />
              </IconButton>
            )}
            <IconButton label="Move to trash" busy={busy === 'trash'} onClick={() => act({ action: 'trash' }, 'restore')}>
              <Trash2 size={17} />
            </IconButton>
          </>
        )}
        <IconButton
          label="Mark unread"
          busy={busy === 'mark_unread'}
          onClick={async () => {
            markedRef.current = data.id;
            await act({ action: 'mark_unread' });
            onBack();
          }}
        >
          <MailOpen size={17} />
        </IconButton>
        <IconButton
          label={data.starred ? 'Remove star' : 'Star'}
          active={data.starred}
          busy={busy === 'star' || busy === 'unstar'}
          onClick={() => act({ action: data.starred ? 'unstar' : 'star' })}
        >
          <Star size={17} fill={data.starred ? 'currentColor' : 'none'} />
        </IconButton>
        <Menu
          label="Labels"
          button={<Tag size={17} />}
          disabled={busy === 'label'}
          items={
            accountLabels.length
              ? accountLabels.map((label) => {
                  const on = data.labelIds.includes(label.id);
                  return {
                    key: label.id,
                    label: label.name,
                    checked: on,
                    onSelect: () => act({ action: 'label', ...(on ? { removeLabelIds: [label.id] } : { addLabelIds: [label.id] }) }),
                  };
                })
              : [{ label: 'This account has no custom labels', disabled: true, onSelect: () => undefined }]
          }
        />
        <span className="reader__bar-gap" />
        <IconButton label="Create a task from this email" onClick={() => setTaskOpen(true)}>
          <ListPlus size={17} />
        </IconButton>
        <Menu
          label="Ask the assistant about this conversation"
          button={<Sparkles size={17} />}
          items={[
            { label: 'Summarize this conversation', onSelect: () => ask('Summarize this conversation and list anything it needs from me.', true) },
            { label: 'Draft a reply', onSelect: () => ask('Draft a reply to this conversation from the account it arrived in.', true) },
            { label: 'Find a time to meet', onSelect: () => ask('Find meeting options for the people in this conversation and draft a reply proposing them.', true) },
            'divider',
            { label: 'Ask something else…', onSelect: () => ask('', false) },
          ]}
        />
        {gmailHref && (
          <a className="icon-btn" href={gmailHref} target="_blank" rel="noopener noreferrer" aria-label="Open in Gmail" title="Open in Gmail">
            <ExternalLink size={16} />
          </a>
        )}
      </ReaderBar>

      <div className="reader__scroll">
        {thread.error && <StaleNotice error={thread.error} onRetry={thread.reload} />}

        <header className="reader__head">
          <h2 className="reader__subject" tabIndex={-1} ref={headingRef}>
            {data.subject || '(no subject)'}
          </h2>
          <div className="reader__meta">
            <AccountBadge accountId={data.accountId} showEmail />
            <span className="reader__count">
              {data.messages.length} {data.messages.length === 1 ? 'message' : 'messages'}
            </span>
            {data.trashed && <Pill tone="danger">In trash</Pill>}
            {threadLabels.map((label) => (
              <Pill key={label.id}>{label.name}</Pill>
            ))}
          </div>
        </header>

        {owner && owner.status === 'reconnect_required' && (
          <div className="notice notice--warn" role="status">
            <span className="notice__text">
              {owner.label} needs to be reconnected. You can read what is cached, but actions and replies will fail until then.
            </span>
            <button type="button" className="link-btn" onClick={() => navigate('#/connections')}>
              Reconnect
            </button>
          </div>
        )}

        <div className="reader__messages">
          {data.messages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              expanded={openIds.has(message.id)}
              onToggle={() => toggle(message.id)}
              ownEmail={owner?.email}
              loadImages={boot.settings.loadRemoteImages}
              onReply={startReply}
            />
          ))}
          {data.messages.length === 0 && (
            <p className="mailtext mailtext--empty">This conversation has no messages the account can read.</p>
          )}
        </div>

        {threadDrafts.map((draft) => (
          <div key={draft.id} className="draftline">
            <PenLine size={15} aria-hidden="true" />
            <span className="draftline__text">
              <strong>
                {draft.status === 'scheduled'
                  ? 'Scheduled reply'
                  : draft.status === 'pending_approval'
                    ? 'Reply waiting for approval'
                    : draft.status === 'failed'
                      ? 'Reply that failed to send'
                      : 'Draft reply'}
              </strong>{' '}
              saved {listTime(draft.updatedAt)} — {draft.bodyText.trim().split('\n')[0]?.slice(0, 90) || 'empty'}
            </span>
            <Button size="sm" onClick={() => compose({ mode: draft.mode, draft, contextLabel: data.subject })}>
              Continue
            </Button>
          </div>
        ))}
        {drafts.error && (
          <p className="reader__drafts-error" role="status">
            Drafts for this conversation could not be checked: {drafts.error.message}
          </p>
        )}

        {last && !data.trashed && (
          <div className="reader__reply">
            <Button variant="outline" icon={<Reply size={15} />} onClick={() => startReply('reply', last)}>
              Reply
            </Button>
            <Button variant="outline" icon={<ReplyAll size={15} />} onClick={() => startReply('reply_all', last)}>
              Reply all
            </Button>
            <Button variant="outline" icon={<Forward size={15} />} onClick={() => startReply('forward', last)}>
              Forward
            </Button>
            <span className="reader__reply-from">
              Replies leave from <AccountBadge accountId={data.accountId} />
            </span>
          </div>
        )}
      </div>

      {taskOpen && (
        <TaskDialog
          onClose={() => setTaskOpen(false)}
          initial={{
            title: data.subject,
            notes: data.snippet,
            accountId: data.accountId,
            source: sourceRef,
          }}
        />
      )}
    </div>
  );
}

function ReaderBar({ onBack, children }: { onBack: () => void; children?: React.ReactNode }) {
  return (
    <div className="reader__bar" role="toolbar" aria-label="Conversation actions">
      <IconButton label="Back to list" onClick={onBack} className="reader__back">
        <ArrowLeft size={18} />
      </IconButton>
      {children}
    </div>
  );
}
