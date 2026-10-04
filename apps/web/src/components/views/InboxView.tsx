'use client';

import clsx from 'clsx';
import {
  Archive,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  PenLine,
  RotateCcw,
  RotateCw,
  Search,
  Star,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { displayName, listTime, plural, shortDateTime } from '@/lib/format';
import { invalidate, routePath, useDebounced, useNow, useResource, type Resource } from '@/lib/hooks';
import type { Draft, Id, ListResult, MailFolder, ThreadAction, ThreadSummary } from '@/lib/types';
import { AccountDot, GapNotice, useApp } from '../AppContext';
import { ThreadReader } from '../mail/ThreadReader';
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, Menu, Pill, SkeletonRows, Spinner, StaleNotice } from '../ui';

const FOLDERS: Array<{ id: MailFolder | 'drafts'; label: string }> = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'unread', label: 'Unread' },
  { id: 'starred', label: 'Starred' },
  { id: 'sent', label: 'Sent' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'all', label: 'All mail' },
  { id: 'trash', label: 'Trash' },
];

const EMPTY_COPY: Record<string, { title: string; text: string }> = {
  inbox: { title: 'Nothing in the inbox', text: 'Every selected account is clear.' },
  unread: { title: 'Nothing unread', text: 'You have read everything in the selected inboxes.' },
  starred: { title: 'No starred conversations', text: 'Star a conversation to keep it within reach.' },
  sent: { title: 'No sent mail', text: 'Messages you send from the selected accounts appear here.' },
  all: { title: 'No mail', text: 'There is no mail in the selected accounts.' },
  trash: { title: 'Trash is empty', text: 'Conversations you delete stay here until Gmail removes them.' },
  label: { title: 'No conversations with this label', text: 'Apply the label from an open conversation.' },
};

function stillBelongs(folder: string, labelId: string | undefined, thread: ThreadSummary): boolean {
  if (folder === 'trash') return thread.trashed;
  if (thread.trashed) return false;
  if (folder === 'inbox') return thread.inInbox;
  if (folder === 'starred') return thread.starred;
  if (labelId) return thread.labelIds.includes(labelId);
  // `unread` keeps a row after it is opened so it does not vanish under the cursor.
  return true;
}

function participantsLabel(thread: ThreadSummary): string {
  const names = thread.participants.map((p) => displayName(p).split(' ')[0] ?? '');
  if (names.length === 0) return '(no sender)';
  if (names.length === 1) return displayName(thread.participants[0]);
  if (names.length <= 3) return names.join(', ');
  return `${names[0]} … ${names[names.length - 2]}, ${names[names.length - 1]}`;
}

export function InboxView({ folder: folderArg, threadId }: { folder?: string; threadId?: string }) {
  const { boot, account, scopeParam, scopeKey, navigate, toast, reportError, refreshBoot, compose } = useApp();
  const folder = folderArg || 'inbox';
  const isDrafts = folder === 'drafts';
  // Label views are addressed as `label:<accountId>:<labelId>` because a label only exists in one mailbox.
  const labelRef = folder.startsWith('label:') ? folder.slice(6) : undefined;
  const labelSplit = labelRef ? labelRef.indexOf(':') : -1;
  const labelAccountId = labelRef && labelSplit > 0 ? labelRef.slice(0, labelSplit) : undefined;
  const labelId = labelRef && labelSplit > 0 ? labelRef.slice(labelSplit + 1) : undefined;
  const listAccounts = labelAccountId ? [labelAccountId] : scopeParam;
  const knownFolder = isDrafts || Boolean(labelId) || FOLDERS.some((f) => f.id === folder);

  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 450);
  const now = useNow();
  const [extra, setExtra] = useState<{ key: string; busy: boolean; error: ApiRequestError | null; pages: number }>({
    key: '',
    busy: false,
    error: null,
    pages: 0,
  });
  const [rowBusy, setRowBusy] = useState<Id | null>(null);
  const [deleteDraft, setDeleteDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const listKey = `threads:${folder}:${scopeKey}:${q}`;
  const morePages = extra.key === listKey ? extra.pages : 0;
  const threads = useResource(
    !isDrafts && knownFolder ? listKey : null,
    (signal) =>
      api.threads(
        {
          accountId: listAccounts,
          q: q || undefined,
          folder: labelId ? 'all' : (folder as MailFolder),
          labelId,
          limit: 40,
        },
        { signal },
      ),
    // Background refresh would collapse extra pages back to the first, so it pauses once more are loaded.
    { refreshMs: morePages > 0 ? undefined : 90_000 },
  );
  const drafts = useResource(isDrafts ? `drafts:list:${scopeKey}` : null, (signal) =>
    api.drafts({ accountId: scopeParam, limit: 60 }, { signal }),
  );

  const loadMore = async () => {
    const cursor = threads.data?.nextCursor;
    if (!cursor) return;
    setExtra({ key: listKey, busy: true, error: null, pages: morePages });
    try {
      const page = await api.threads({
        accountId: listAccounts,
        q: q || undefined,
        folder: labelId ? 'all' : (folder as MailFolder),
        labelId,
        limit: 40,
        cursor,
      });
      threads.mutate((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return {
          items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))],
          nextCursor: page.nextCursor,
          gaps: [...current.gaps, ...page.gaps],
        };
      });
      setExtra({ key: listKey, busy: false, error: null, pages: morePages + 1 });
    } catch (err) {
      setExtra({ key: listKey, busy: false, error: toApiError(err), pages: morePages });
    }
  };

  /** Fold a server-updated summary back into the list. */
  const applySummary = (summary: ThreadSummary) => {
    const present = threads.data?.items.some((item) => item.id === summary.id) ?? false;
    if (!present) {
      if (stillBelongs(folder, labelId, summary)) threads.reload();
      return;
    }
    threads.mutate((current) => ({
      ...current,
      items: stillBelongs(folder, labelId, summary)
        ? current.items.map((item) => (item.id === summary.id ? summary : item))
        : current.items.filter((item) => item.id !== summary.id),
    }));
    invalidate('brief');
  };

  const rowAction = async (thread: ThreadSummary, action: ThreadAction, undo?: ThreadAction) => {
    setRowBusy(thread.id);
    try {
      const summary = await api.threadAction(thread.id, { action });
      applySummary(summary);
      refreshBoot();
      if (undo) {
        toast({
          message: action === 'archive' ? 'Conversation archived.' : action === 'trash' ? 'Moved to trash.' : 'Done.',
          action: {
            label: 'Undo',
            run: () => {
              api.threadAction(thread.id, { action: undo }).then(
                () => {
                  threads.reload();
                  refreshBoot();
                },
                (err) => reportError(err, 'Could not undo'),
              );
            },
          },
        });
      }
    } catch (err) {
      reportError(err, 'That action failed');
    } finally {
      setRowBusy(null);
    }
  };

  const removeDraft = async () => {
    if (!deleteDraft) return;
    setDeleting(true);
    try {
      await api.deleteDraft(deleteDraft.id);
      drafts.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== deleteDraft.id) }));
      refreshBoot();
      toast({ message: 'Draft deleted.' });
      setDeleteDraft(null);
    } catch (err) {
      reportError(err, 'Could not delete the draft');
    } finally {
      setDeleting(false);
    }
  };

  const openFolder = (id: string) => {
    navigate(routePath('inbox', id));
  };

  // List keys: j/k or arrows move between rows, c composes, / focuses search.
  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || event.metaKey || event.ctrlKey || event.altKey) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
    const index = rows.findIndex((row) => row === document.activeElement);
    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault();
      rows[Math.min(index + 1, rows.length - 1)]?.focus();
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === 'c') {
      event.preventDefault();
      compose({ mode: 'new' });
    }
  };

  useEffect(() => {
    if (!knownFolder) navigate('#/inbox/inbox', true);
  }, [knownFolder, navigate]);

  const userLabels = boot.labels.filter(
    (label) => label.kind === 'user' && (!scopeParam || scopeParam.includes(label.accountId)),
  );
  const activeLabel = labelId
    ? boot.labels.find((label) => label.id === labelId && label.accountId === labelAccountId)
    : undefined;
  const items = threads.data?.items ?? [];
  const accountCount = listAccounts?.length ?? boot.connections.length;
  const empty = EMPTY_COPY[labelId ? 'label' : folder] ?? EMPTY_COPY.inbox!;

  return (
    <div className={clsx('inbox', threadId && 'inbox--reading')}>
      <section className="inbox__list" aria-label="Conversations" onKeyDown={onListKey}>
        <div className="inbox__head">
          <div className="inbox__title-row">
            <h1 className="inbox__title">{activeLabel ? activeLabel.name : (FOLDERS.find((f) => f.id === folder)?.label ?? 'Inbox')}</h1>
            <span className="inbox__scope">
              {plural(accountCount, 'account')}
              {folder === 'inbox' && boot.counts.inboxUnread > 0 ? ` · ${boot.counts.inboxUnread} unread` : ''}
            </span>
            <span className="inbox__head-gap" />
            {(threads.refreshing || drafts.refreshing) && <Spinner size={14} label="Refreshing" />}
            <IconButton label="Refresh" onClick={() => (isDrafts ? drafts.reload() : threads.reload())}>
              <RotateCw size={16} />
            </IconButton>
          </div>

          {!isDrafts && (
            <div className="searchfield" role="search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                className="searchfield__input"
                aria-label="Search mail"
                placeholder="Search mail — try from:dana has:attachment"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && text) {
                    event.preventDefault();
                    setText('');
                  }
                }}
              />
              {text && (
                <button type="button" className="searchfield__clear" aria-label="Clear search" onClick={() => setText('')}>
                  <X size={14} />
                </button>
              )}
            </div>
          )}

          <div className="foldertabs" role="tablist" aria-label="Mail folders">
            {FOLDERS.map((item) => {
              const count = item.id === 'inbox' ? boot.counts.inboxUnread : item.id === 'drafts' ? boot.counts.drafts : 0;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={folder === item.id}
                  className={clsx('foldertabs__tab', folder === item.id && 'is-active')}
                  onClick={() => openFolder(item.id)}
                >
                  {item.label}
                  {count > 0 && <span className="foldertabs__count">{count}</span>}
                </button>
              );
            })}
            {userLabels.length > 0 && (
              <Menu
                label="Labels"
                align="start"
                buttonClassName={clsx('foldertabs__tab foldertabs__tab--menu', labelId && 'is-active')}
                button={
                  <>
                    <Tag size={13} aria-hidden="true" /> Labels
                  </>
                }
                items={userLabels.map((label) => ({
                  key: `${label.accountId}:${label.id}`,
                  label: label.name,
                  hint: account(label.accountId)?.label,
                  checked: label.id === labelId && label.accountId === labelAccountId ? true : undefined,
                  onSelect: () => openFolder(`label:${label.accountId}:${label.id}`),
                }))}
              />
            )}
          </div>
        </div>

        <div className="inbox__scroll">
          {q && !isDrafts && (
            <p className="inbox__searchnote">
              Results for <strong>{q}</strong> across {plural(accountCount, 'account')}. Search asks Google directly, so
              mail older than the {boot.capabilities.limits.mailCacheDays}-day cache is included.
            </p>
          )}

          {isDrafts ? (
            <DraftList
              drafts={drafts}
              now={now}
              onOpen={(draft) => compose({ mode: draft.mode, draft })}
              onDelete={setDeleteDraft}
            />
          ) : (
            <>
              {threads.data && <GapNotice gaps={threads.data.gaps} />}
              {threads.error && threads.data && <StaleNotice error={threads.error} onRetry={threads.reload} />}
              {threads.loading && <SkeletonRows count={10} tall />}
              {threads.error && !threads.data && <ErrorState error={threads.error} onRetry={threads.reload} />}
              {threads.data && items.length === 0 && (
                <EmptyState
                  icon={q ? <Search size={22} /> : <InboxIcon size={22} />}
                  title={q ? 'No mail matches that search' : empty.title}
                >
                  {q
                    ? 'Try fewer words, or Gmail operators such as from:, to:, subject:, has:attachment or older_than:30d.'
                    : threads.data.gaps.length
                      ? 'Nothing could be listed from the accounts that were readable. See the notice above.'
                      : empty.text}
                </EmptyState>
              )}
              {items.length > 0 && (
                <ul className="tlist" ref={listRef}>
                  {items.map((thread) => {
                    const owner = account(thread.accountId);
                    const selected = thread.id === threadId;
                    return (
                      <li
                        key={thread.id}
                        className={clsx('trow', thread.unread && 'trow--unread', selected && 'trow--selected')}
                      >
                        <a
                          className="trow__main"
                          href={routePath('inbox', folder, thread.id)}
                          data-row
                          aria-current={selected ? 'true' : undefined}
                        >
                          <span className="trow__flag" aria-hidden="true" />
                          <span className="trow__who">
                            <AccountDot account={owner} />
                            <span className="trow__from">{participantsLabel(thread)}</span>
                            {thread.messageCount > 1 && <span className="trow__n">{thread.messageCount}</span>}
                          </span>
                          <span className="trow__text">
                            <span className="trow__subject">{thread.subject || '(no subject)'}</span>
                            <span className="trow__snippet"> — {thread.snippet}</span>
                          </span>
                          <span className="trow__marks">
                            {thread.hasDraft && <span className="trow__draft">Draft</span>}
                            {thread.hasAttachments && <Paperclip size={13} aria-label="Has attachments" />}
                            {thread.starred && <Star size={13} fill="currentColor" className="trow__star" aria-label="Starred" />}
                          </span>
                          <span className="trow__acct" title={owner?.email}>
                            {owner?.label ?? 'Removed account'}
                          </span>
                          <time className="trow__time" dateTime={thread.lastMessageAt}>
                            {listTime(thread.lastMessageAt, now)}
                          </time>
                          {thread.unread && <span className="sr-only">Unread.</span>}
                        </a>
                        <div className="trow__actions">
                          {rowBusy === thread.id ? (
                            <Spinner size={15} />
                          ) : thread.trashed ? (
                            <IconButton label="Restore" onClick={() => rowAction(thread, 'restore')}>
                              <RotateCcw size={15} />
                            </IconButton>
                          ) : (
                            <>
                              {thread.inInbox ? (
                                <IconButton label="Archive" onClick={() => rowAction(thread, 'archive', 'unarchive')}>
                                  <Archive size={15} />
                                </IconButton>
                              ) : (
                                <IconButton label="Move to inbox" onClick={() => rowAction(thread, 'unarchive')}>
                                  <InboxIcon size={15} />
                                </IconButton>
                              )}
                              <IconButton
                                label={thread.unread ? 'Mark read' : 'Mark unread'}
                                onClick={() => rowAction(thread, thread.unread ? 'mark_read' : 'mark_unread')}
                              >
                                {thread.unread ? <MailOpen size={15} /> : <Mail size={15} />}
                              </IconButton>
                              <IconButton
                                label={thread.starred ? 'Remove star' : 'Star'}
                                active={thread.starred}
                                onClick={() => rowAction(thread, thread.starred ? 'unstar' : 'star')}
                              >
                                <Star size={15} fill={thread.starred ? 'currentColor' : 'none'} />
                              </IconButton>
                              <IconButton label="Move to trash" onClick={() => rowAction(thread, 'trash', 'restore')}>
                                <Trash2 size={15} />
                              </IconButton>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {threads.data?.nextCursor && (
                <div className="inbox__more">
                  <Button busy={extra.key === listKey && extra.busy} onClick={loadMore}>
                    Load older conversations
                  </Button>
                  {extra.key === listKey && extra.error && (
                    <p className="inbox__more-error" role="alert">
                      Couldn’t load more: {extra.error.message}
                    </p>
                  )}
                </div>
              )}
              {threads.data && !threads.data.nextCursor && items.length > 0 && !q && (
                <p className="inbox__end">End of {activeLabel ? activeLabel.name : folder === 'all' ? 'all mail' : folder}.</p>
              )}
            </>
          )}
        </div>
      </section>

      <section className="inbox__reader" aria-label="Conversation">
        {threadId ? (
          <ThreadReader
            key={threadId}
            threadId={threadId}
            onBack={() => navigate(routePath('inbox', folder))}
            onChanged={applySummary}
          />
        ) : (
          <div className="inbox__placeholder">
            <EmptyState icon={<Mail size={24} />} title="Select a conversation">
              Every thread opens in full, in the account it belongs to. Press <kbd className="kbd">c</kbd> to compose,{' '}
              <kbd className="kbd">j</kbd> and <kbd className="kbd">k</kbd> to move through the list.
            </EmptyState>
          </div>
        )}
      </section>

      {deleteDraft && (
        <ConfirmDialog
          title="Delete this draft?"
          confirmLabel="Delete draft"
          danger
          busy={deleting}
          onClose={() => setDeleteDraft(null)}
          onConfirm={removeDraft}
        >
          <p>
            “{deleteDraft.subject || '(no subject)'}” will be removed from {account(deleteDraft.accountId)?.email ?? 'the account'}’s
            Gmail drafts.
            {deleteDraft.status === 'scheduled' ? ' Its scheduled send is cancelled.' : ''}
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function DraftList({
  drafts,
  now,
  onOpen,
  onDelete,
}: {
  drafts: Resource<ListResult<Draft>>;
  now: Date;
  onOpen: (draft: Draft) => void;
  onDelete: (draft: Draft) => void;
}) {
  const { account } = useApp();
  if (drafts.loading) return <SkeletonRows count={6} tall />;
  if (!drafts.data) return drafts.error ? <ErrorState error={drafts.error} onRetry={drafts.reload} /> : null;
  const items = drafts.data.items;
  return (
    <>
      <GapNotice gaps={drafts.data.gaps} />
      {drafts.error && <StaleNotice error={drafts.error} onRetry={drafts.reload} />}
      {items.length === 0 ? (
        <EmptyState icon={<PenLine size={22} />} title="No drafts">
          Drafts you save here are real Gmail drafts, and drafts you start in Gmail appear here.
        </EmptyState>
      ) : (
        <ul className="tlist">
          {items.map((draft) => {
            const owner = account(draft.accountId);
            const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
            return (
              <li key={draft.id} className="trow">
                <button type="button" className="trow__main" data-row onClick={() => onOpen(draft)}>
                  <span className="trow__flag" aria-hidden="true" />
                  <span className="trow__who">
                    <AccountDot account={owner} />
                    <span className="trow__from">
                      {recipients.length ? `To ${recipients.map((r) => displayName(r)).join(', ')}` : 'No recipients yet'}
                    </span>
                  </span>
                  <span className="trow__text">
                    <span className="trow__subject">{draft.subject || '(no subject)'}</span>
                    <span className="trow__snippet"> — {draft.bodyText.trim().split('\n')[0]?.slice(0, 140) || 'empty'}</span>
                  </span>
                  <span className="trow__marks">
                    {draft.status === 'scheduled' && <Pill tone="info">Scheduled {shortDateTime(draft.scheduledAt, now)}</Pill>}
                    {draft.status === 'pending_approval' && <Pill tone="accent">Awaiting approval</Pill>}
                    {draft.status === 'sending' && <Pill tone="info">Sending</Pill>}
                    {draft.status === 'failed' && <Pill tone="danger">Send failed</Pill>}
                    {draft.attachments.length > 0 && <Paperclip size={13} aria-label="Has attachments" />}
                  </span>
                  <span className="trow__acct" title={owner?.email}>
                    {owner?.label ?? 'Removed account'}
                  </span>
                  <time className="trow__time" dateTime={draft.updatedAt}>
                    {listTime(draft.updatedAt, now)}
                  </time>
                </button>
                <div className="trow__actions">
                  <IconButton label="Delete draft" onClick={() => onDelete(draft)}>
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
