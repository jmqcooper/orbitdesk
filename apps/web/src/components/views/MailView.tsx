'use client';

import clsx from 'clsx';
import {
  Archive,
  Check,
  ChevronDown,
  Inbox,
  MailOpen,
  Paperclip,
  PenLine,
  RotateCcw,
  Search,
  Sparkles,
  SquarePen,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { displayName, listTime, plural, shortDateTime } from '@/lib/format';
import { invalidate, routePath, useDebounced, useNow, useResource, useShortcuts } from '@/lib/hooks';
import type { Draft, Id, MailFolder, MailLane, ThreadAction, ThreadSummary } from '@/lib/types';
import { AccountDot, GapNotice, useApp } from '../AppContext';
import { Thread } from '../mail/Thread';
import { AccountFilter } from '../Shell';
import { Button, ConfirmDialog, EmptyState, ErrorState, IconButton, Kbd, Popover, SkeletonRows, Spinner } from '../ui';

type Lane = MailLane | 'unsorted';
const LANES: Array<{ id: Lane; label: string }> = [
  { id: 'reply', label: 'Reply' },
  { id: 'fyi', label: 'FYI' },
  { id: 'other', label: 'Other' },
  { id: 'unsorted', label: 'Unsorted' },
];
const FOLDERS: Array<{ id: string; label: string }> = [
  { id: 'waiting', label: 'Waiting on others' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'sent', label: 'Sent' },
  { id: 'starred', label: 'Starred' },
  { id: 'all', label: 'All mail' },
  { id: 'trash', label: 'Trash' },
];

const EMPTY: Record<string, { title: string; text: string }> = {
  reply: { title: 'Nobody is waiting on you', text: 'New mail that needs an answer lands here with a draft ready.' },
  fyi: { title: 'Nothing to read', text: 'Updates worth knowing about show up here.' },
  other: { title: 'No noise', text: 'Newsletters and automated mail collect here.' },
  unsorted: { title: 'Everything is sorted', text: '' },
  inbox: { title: 'Inbox zero', text: 'Every selected account is clear.' },
  waiting: { title: 'Not waiting on anyone', text: 'Mail you sent that still expects an answer is tracked here.' },
  drafts: { title: 'No drafts', text: 'Drafts are real Gmail drafts, so they follow you everywhere.' },
  sent: { title: 'Nothing sent', text: '' },
  starred: { title: 'Nothing starred', text: '' },
  all: { title: 'No mail', text: '' },
  trash: { title: 'Trash is empty', text: '' },
  label: { title: 'Nothing with this label', text: '' },
};

interface Query {
  folder: MailFolder;
  lane?: Lane;
  labelId?: Id;
  accountId?: Id;
}

/** `label:<accountId>:<labelId>` because a label only exists inside one mailbox. */
function queryFor(view: string): Query | null {
  if (view === 'reply' || view === 'fyi' || view === 'other' || view === 'unsorted') return { folder: 'inbox', lane: view };
  if (view === 'waiting') return { folder: 'all', lane: 'waiting' };
  if (view === 'inbox' || view === 'sent' || view === 'starred' || view === 'all' || view === 'trash') return { folder: view };
  if (view.startsWith('label:')) {
    const rest = view.slice(6);
    const split = rest.indexOf(':');
    if (split > 0) return { folder: 'all', accountId: rest.slice(0, split), labelId: rest.slice(split + 1) };
  }
  return null;
}

function belongs(view: string, query: Query, thread: ThreadSummary): boolean {
  if (view === 'trash') return thread.trashed;
  if (thread.trashed) return false;
  if (query.lane === 'waiting') return thread.triage?.lane === 'waiting';
  if (query.lane === 'unsorted') return thread.inInbox && !thread.triage;
  if (query.lane) return thread.inInbox && thread.triage?.lane === query.lane;
  if (view === 'inbox') return thread.inInbox;
  if (view === 'starred') return thread.starred;
  if (query.labelId) return thread.labelIds.includes(query.labelId);
  return true;
}

function sender(thread: ThreadSummary): string {
  const people = thread.participants;
  if (people.length === 0) return '(no sender)';
  if (people.length === 1) return displayName(people[0]);
  const first = people.map((p) => displayName(p).split(' ')[0] ?? '');
  return first.length <= 3 ? first.join(', ') : `${first[0]}, ${first[1]} +${first.length - 2}`;
}

export function MailView({ view: viewArg, threadId }: { view?: string; threadId?: string }) {
  const { boot, account, scopeParam, scopeKey, navigate, toast, reportError, refreshBoot, compose, ask } = useApp();
  const lanes = boot.counts.lanes;
  const sorted = lanes.reply + lanes.fyi + lanes.other > 0;
  const home = sorted ? 'reply' : 'inbox';
  const view = viewArg || home;
  const query = queryFor(view);
  const isDrafts = view === 'drafts';

  const [searching, setSearching] = useState(false);
  const [text, setText] = useState('');
  const q = useDebounced(searching ? text.trim() : '', 400);
  const now = useNow();
  const [cursor, setCursor] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [extra, setExtra] = useState<{ key: string; busy: boolean; error: ApiRequestError | null; pages: number }>({ key: '', busy: false, error: null, pages: 0 });
  const [busyRow, setBusyRow] = useState<Id | null>(null);
  const [clearing, setClearing] = useState(false);
  const [sorting, setSorting] = useState(false);
  const [deleteDraft, setDeleteDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Search always looks through all mail; Google decides what matches.
  const active: Query | null = q ? { folder: 'all' } : query;
  const listAccounts = active?.accountId ? [active.accountId] : scopeParam;
  const listKey = `threads:${q ? 'search' : view}:${scopeKey}:${q}`;
  const morePages = extra.key === listKey ? extra.pages : 0;
  const request = (cursorToken?: string) =>
    api.threads({
      accountId: listAccounts,
      q: q || undefined,
      folder: active!.folder,
      lane: active!.lane,
      labelId: active!.labelId,
      limit: 50,
      cursor: cursorToken,
    });
  const threads = useResource(
    active && !(isDrafts && !q) ? listKey : null,
    (signal) =>
      api.threads(
        { accountId: listAccounts, q: q || undefined, folder: active!.folder, lane: active!.lane, labelId: active!.labelId, limit: 50 },
        { signal },
      ),
    // A background refresh would collapse extra pages back to the first, so it pauses once more are loaded.
    { refreshMs: morePages > 0 ? undefined : 60_000 },
  );
  const drafts = useResource(isDrafts && !q ? `drafts:list:${scopeKey}` : null, (signal) => api.drafts({ accountId: scopeParam, limit: 100 }, { signal }));

  const items = useMemo(() => threads.data?.items ?? [], [threads.data]);
  const index = Math.min(cursor, Math.max(items.length - 1, 0));

  useEffect(() => {
    const laneView = view === 'reply' || view === 'fyi' || view === 'other' || view === 'unsorted';
    if (!viewArg || (!query && !isDrafts)) navigate(routePath('mail', home), true);
    // Lanes only exist once something is sorted, and replace the plain inbox when they do.
    else if (!threadId && ((laneView && !sorted) || (view === 'inbox' && sorted))) navigate(routePath('mail', home), true);
  }, [viewArg, view, query, isDrafts, home, sorted, threadId, navigate]);

  useEffect(() => {
    setCursor(0);
  }, [listKey]);

  // The agent sorts in the background; pull its work in as the counts move.
  const laneTotal = lanes.reply + lanes.fyi + lanes.other + lanes.waiting + lanes.unsorted + boot.counts.draftsReady;
  const seenTotal = useRef(laneTotal);
  useEffect(() => {
    if (seenTotal.current === laneTotal) return;
    seenTotal.current = laneTotal;
    if (query?.lane || view === 'inbox') threads.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneTotal]);

  useEffect(() => {
    if (threadId) return;
    listRef.current?.querySelector('[data-cursor="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, threadId]);

  const open = (id: Id) => navigate(routePath('mail', view, id));
  const closeThread = () => navigate(routePath('mail', view));

  /** Fold a server-updated summary back into the list. */
  const applySummary = (summary: ThreadSummary) => {
    if (!threads.data || !active) return;
    const keep = q ? true : belongs(view, active, summary);
    const present = threads.data.items.some((item) => item.id === summary.id);
    if (!present) {
      if (keep) threads.reload();
      return;
    }
    threads.mutate((current) => ({
      ...current,
      items: keep ? current.items.map((item) => (item.id === summary.id ? summary : item)) : current.items.filter((item) => item.id !== summary.id),
    }));
    invalidate('brief');
  };

  const act = async (thread: ThreadSummary, action: ThreadAction, undo?: ThreadAction) => {
    setBusyRow(thread.id);
    try {
      applySummary(await api.threadAction(thread.id, { action }));
      refreshBoot();
      if (undo) {
        toast({
          message: action === 'archive' ? 'Archived.' : action === 'trash' ? 'Moved to trash.' : 'Done.',
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
      reportError(err, 'That did not work');
    } finally {
      setBusyRow(null);
    }
  };

  /** Archive everything listed in the Other lane, one mailbox request at a time. */
  const clearLane = async () => {
    const batch = items.slice(0, 50);
    if (!batch.length) return;
    setClearing(true);
    const done: ThreadSummary[] = [];
    try {
      for (const thread of batch) {
        await api.threadAction(thread.id, { action: 'archive' });
        done.push(thread);
      }
    } catch (err) {
      reportError(err, `Stopped after ${done.length} of ${batch.length}`);
    } finally {
      setClearing(false);
      threads.reload();
      refreshBoot();
    }
    if (done.length) {
      toast({
        tone: 'ok',
        message: `Archived ${plural(done.length, 'conversation')}.`,
        durationMs: 9000,
        action: {
          label: 'Undo',
          run: () => {
            Promise.all(done.map((thread) => api.threadAction(thread.id, { action: 'unarchive' }))).then(
              () => {
                threads.reload();
                refreshBoot();
              },
              (err) => reportError(err, 'Could not undo everything'),
            );
          },
        },
      });
    }
  };

  const sortNow = async () => {
    setSorting(true);
    try {
      const result = await api.runTriage(scopeParam);
      refreshBoot();
      threads.reload();
      if (result.sorted || result.drafted) {
        toast({ tone: 'ok', message: `Sorted ${result.sorted}, drafted ${result.drafted}.${result.remaining ? ` ${result.remaining} to go.` : ''}` });
      } else {
        toast(result.error ? { tone: 'error', message: result.error } : { message: 'Nothing new to sort.' });
      }
    } catch (err) {
      reportError(err, 'The agent could not sort');
    } finally {
      setSorting(false);
    }
  };

  const loadMore = async () => {
    const token = threads.data?.nextCursor;
    if (!token || !active) return;
    setExtra({ key: listKey, busy: true, error: null, pages: morePages });
    try {
      const page = await request(token);
      threads.mutate((current) => {
        const seen = new Set(current.items.map((item) => item.id));
        return { items: [...current.items, ...page.items.filter((item) => !seen.has(item.id))], nextCursor: page.nextCursor, gaps: [...current.gaps, ...page.gaps] };
      });
      setExtra({ key: listKey, busy: false, error: null, pages: morePages + 1 });
    } catch (err) {
      setExtra({ key: listKey, busy: false, error: toApiError(err), pages: morePages });
    }
  };

  const removeDraft = async () => {
    if (!deleteDraft) return;
    setDeleting(true);
    try {
      await api.deleteDraft(deleteDraft.id);
      drafts.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== deleteDraft.id) }));
      refreshBoot();
      setDeleteDraft(null);
    } catch (err) {
      reportError(err, 'Could not delete the draft');
    } finally {
      setDeleting(false);
    }
  };

  const tabs = sorted ? LANES.filter((lane) => lane.id !== 'unsorted' || lanes.unsorted > 0) : [];
  const goLane = (step: number) => {
    if (!tabs.length) return;
    const at = tabs.findIndex((tab) => tab.id === view);
    navigate(routePath('mail', tabs[(at + step + tabs.length) % tabs.length]!.id));
  };

  useShortcuts((event) => {
    if (threadId) return;
    const current = items[index];
    switch (event.key) {
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        setCursor(Math.min(index + 1, Math.max(items.length - 1, 0)));
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        setCursor(Math.max(index - 1, 0));
        break;
      case 'Enter':
      case 'o':
        if (current) {
          event.preventDefault();
          open(current.id);
        }
        break;
      case 'e':
        if (current && !current.trashed && current.inInbox) void act(current, 'archive', 'unarchive');
        break;
      case '#':
        if (current && !current.trashed) void act(current, 'trash', 'restore');
        break;
      case 's':
        if (current) void act(current, current.starred ? 'unstar' : 'star');
        break;
      case 'u':
        if (current) void act(current, current.unread ? 'mark_read' : 'mark_unread');
        break;
      case 'Tab':
        if (tabs.length) {
          event.preventDefault();
          goLane(event.shiftKey ? -1 : 1);
        }
        break;
      case '/':
        event.preventDefault();
        setSearching(true);
        requestAnimationFrame(() => searchRef.current?.focus());
        break;
      default:
    }
  });

  const activeLabel = query?.labelId ? boot.labels.find((label) => label.id === query.labelId && label.accountId === query.accountId) : undefined;
  const folderTitle = activeLabel?.name ?? FOLDERS.find((folder) => folder.id === view)?.label ?? (view === 'inbox' ? 'Inbox' : null);
  const inLane = tabs.some((tab) => tab.id === view);
  const userLabels = boot.labels.filter((label) => label.kind === 'user' && (!scopeParam || scopeParam.includes(label.accountId)));
  const empty = EMPTY[query?.labelId ? 'label' : view] ?? EMPTY.inbox!;
  const queue = boot.counts.agentQueue;
  const queued = boot.capabilities.agent.available && queue.sort + queue.draft > 0;
  // With the worker running this clears by itself; the button is there for when it does not.
  const background = boot.capabilities.triage.available;
  const queueLabel = queue.sort
    ? background
      ? `Sorting ${plural(queue.sort, 'conversation')}…`
      : `${plural(queue.sort, 'conversation')} not sorted yet.`
    : background
      ? `Drafting ${plural(queue.draft, 'reply', 'replies')}…`
      : `${plural(queue.draft, 'reply', 'replies')} not drafted yet.`;
  const position = threadId ? items.findIndex((item) => item.id === threadId) : -1;

  return (
    <>
      <div className="mail" hidden={Boolean(threadId)}>
        <header className="bar">
          {searching ? (
            <div className="searchbar" role="search">
              <Search size={15} aria-hidden="true" />
              <input
                ref={searchRef}
                className="searchbar__input"
                type="search"
                aria-label="Search all mail"
                placeholder="Search all mail — try from:lena has:attachment"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setSearching(false);
                    setText('');
                  } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
              />
              {threads.loading && q ? <Spinner size={14} /> : null}
              <IconButton
                label="Close search"
                onClick={() => {
                  setSearching(false);
                  setText('');
                }}
              >
                <X size={15} />
              </IconButton>
            </div>
          ) : (
            <>
              <nav className="tabs" aria-label="Inbox lanes">
                {tabs.length ? (
                  tabs.map((tab) => (
                    <a key={tab.id} href={routePath('mail', tab.id)} className={clsx('tabs__tab', view === tab.id && 'is-active')} aria-current={view === tab.id ? 'page' : undefined}>
                      {tab.label}
                      {lanes[tab.id] > 0 && <span className="tabs__count">{lanes[tab.id]}</span>}
                    </a>
                  ))
                ) : (
                  <a href={routePath('mail', 'inbox')} className={clsx('tabs__tab', view === 'inbox' && 'is-active')}>
                    Inbox
                    {boot.counts.inboxUnread > 0 && <span className="tabs__count">{boot.counts.inboxUnread}</span>}
                  </a>
                )}
                <Popover
                  open={moreOpen}
                  onClose={() => setMoreOpen(false)}
                  panelClassName="menu"
                  trigger={
                    <button
                      type="button"
                      className={clsx('tabs__tab', !inLane && view !== 'inbox' && 'is-active')}
                      aria-haspopup="menu"
                      aria-expanded={moreOpen}
                      onClick={() => setMoreOpen((value) => !value)}
                    >
                      {!inLane && view !== 'inbox' && folderTitle ? folderTitle : 'More'}
                      <ChevronDown size={13} aria-hidden="true" />
                    </button>
                  }
                >
                  <div role="menu" aria-label="Folders">
                    {FOLDERS.map((folder) => {
                      const count = folder.id === 'waiting' ? lanes.waiting : folder.id === 'drafts' ? boot.counts.drafts : 0;
                      return (
                        <a key={folder.id} role="menuitem" className="menu__item" href={routePath('mail', folder.id)} onClick={() => setMoreOpen(false)}>
                          <span className="menu__icon">{view === folder.id && <Check size={14} />}</span>
                          <span className="menu__label">{folder.label}</span>
                          {count > 0 && <span className="menu__hint num">{count}</span>}
                        </a>
                      );
                    })}
                    {userLabels.length > 0 && <div className="menu__divider" role="separator" />}
                    {userLabels.slice(0, 14).map((label) => {
                      const id = `label:${label.accountId}:${label.id}`;
                      return (
                        <a key={id} role="menuitem" className="menu__item" href={routePath('mail', id)} onClick={() => setMoreOpen(false)}>
                          <span className="menu__icon">{view === id ? <Check size={14} /> : <AccountDot account={account(label.accountId)} size={7} />}</span>
                          <span className="menu__label">{label.name}</span>
                        </a>
                      );
                    })}
                  </div>
                </Popover>
              </nav>
              <span className="bar__gap" />
              {view === 'other' && items.length > 0 && (
                <Button size="sm" variant="ghost" icon={<Archive size={14} />} busy={clearing} onClick={clearLane}>
                  Archive all
                </Button>
              )}
              <AccountFilter />
              <IconButton
                label="Search  ·  /"
                onClick={() => {
                  setSearching(true);
                  requestAnimationFrame(() => searchRef.current?.focus());
                }}
              >
                <Search size={16} />
              </IconButton>
              <IconButton label="Compose  ·  C" onClick={() => compose({ mode: 'new' })}>
                <SquarePen size={16} />
              </IconButton>
            </>
          )}
        </header>

        <div className="scroll">
          <div className="column">
            {queued && !q && (
              <div className="agentline" role="status">
                <Sparkles size={14} aria-hidden="true" className={clsx((background || sorting) && 'is-pulsing')} />
                <span className="agentline__text">{sorting ? 'Working on it…' : queueLabel}</span>
                <Button size="sm" variant="agent" busy={sorting} onClick={sortNow}>
                  {queue.sort ? 'Sort now' : 'Draft now'}
                </Button>
              </div>
            )}

            {isDrafts && !q ? (
              <DraftList
                loading={drafts.loading}
                error={drafts.error}
                items={drafts.data?.items}
                now={now}
                onRetry={drafts.reload}
                onOpen={(draft) => (draft.threadId ? navigate(routePath('mail', 'all', draft.threadId)) : compose({ mode: draft.mode, draft }))}
                onDelete={setDeleteDraft}
              />
            ) : (
              <>
                {threads.data && <GapNotice gaps={threads.data.gaps} />}
                {threads.loading && <SkeletonRows count={9} />}
                {threads.error && !threads.data && <ErrorState error={threads.error} onRetry={threads.reload} />}
                {threads.data && items.length === 0 && (
                  <EmptyState
                    icon={q ? <Search size={22} /> : view === 'reply' ? <Check size={22} /> : <Inbox size={22} />}
                    title={q ? 'No mail matches' : empty.title}
                    action={
                      !q && view === 'reply' && boot.capabilities.agent.available ? (
                        <Button variant="agent" size="sm" icon={<Sparkles size={14} />} onClick={() => ask({ text: 'What else needs my attention today?', send: true })}>
                          Ask what else needs you
                        </Button>
                      ) : undefined
                    }
                  >
                    {q ? 'Try fewer words, or Gmail operators like from:, subject: or older_than:30d.' : empty.text}
                  </EmptyState>
                )}
                {items.length > 0 && (
                  <ul className="rows" ref={listRef} aria-label="Conversations">
                    {items.map((thread, at) => {
                      const owner = account(thread.accountId);
                      const triage = thread.triage;
                      const drafted = triage?.draft.state === 'ready' && thread.hasDraft;
                      // "Pending" only means work is under way when the background worker is there to do it.
                      const drafting = triage?.draft.state === 'drafting' || (triage?.draft.state === 'pending' && background);
                      return (
                        <li key={thread.id} className={clsx('row', thread.unread && 'row--unread', at === index && 'is-cursor')} data-cursor={at === index}>
                          <a className="row__main" href={routePath('mail', view, thread.id)} onMouseMove={() => at !== index && setCursor(at)} title={owner?.email}>
                            <AccountDot account={owner} size={7} />
                            <span className="row__from">
                              {sender(thread)}
                              {thread.messageCount > 1 && <span className="row__n">{thread.messageCount}</span>}
                            </span>
                            <span className="row__text">
                              <span className="row__subject">{thread.subject || '(no subject)'}</span>
                              <span className="row__summary">{triage?.summary || thread.snippet}</span>
                            </span>
                            <span className="row__marks">
                              {triage?.urgent && <span className="mark mark--urgent">Urgent</span>}
                              {drafted ? (
                                <span className="mark mark--agent">
                                  <PenLine size={11} aria-hidden="true" /> Draft ready
                                </span>
                              ) : drafting ? (
                                <span className="mark mark--agent mark--working">Drafting…</span>
                              ) : thread.hasDraft ? (
                                <span className="mark">Draft</span>
                              ) : null}
                              {thread.hasAttachments && <Paperclip size={13} aria-label="Has attachments" />}
                              {thread.starred && <Star size={13} fill="currentColor" aria-label="Starred" />}
                            </span>
                            <time className="row__time num" dateTime={thread.lastMessageAt}>
                              {listTime(thread.lastMessageAt, now)}
                            </time>
                          </a>
                          <div className="row__actions">
                            {busyRow === thread.id ? (
                              <Spinner size={14} />
                            ) : thread.trashed ? (
                              <IconButton label="Restore" onClick={() => act(thread, 'restore')}>
                                <RotateCcw size={15} />
                              </IconButton>
                            ) : (
                              <>
                                {thread.inInbox && (
                                  <IconButton label="Archive  ·  E" onClick={() => act(thread, 'archive', 'unarchive')}>
                                    <Archive size={15} />
                                  </IconButton>
                                )}
                                <IconButton label={thread.unread ? 'Mark read  ·  U' : 'Mark unread  ·  U'} onClick={() => act(thread, thread.unread ? 'mark_read' : 'mark_unread')}>
                                  <MailOpen size={15} />
                                </IconButton>
                                <IconButton label="Trash  ·  #" onClick={() => act(thread, 'trash', 'restore')}>
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
                  <div className="more">
                    <Button size="sm" variant="ghost" busy={extra.key === listKey && extra.busy} onClick={loadMore}>
                      Load older
                    </Button>
                    {extra.key === listKey && extra.error && <span className="field__error">{extra.error.message}</span>}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <footer className="hints" aria-hidden="true">
          <span>
            <Kbd>J</Kbd>
            <Kbd>K</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>E</Kbd> archive
          </span>
          {tabs.length > 0 && (
            <span>
              <Kbd>Tab</Kbd> next lane
            </span>
          )}
          <span className="spacer" />
          <span>
            <Kbd>⌘K</Kbd> commands
          </span>
          <span>
            <Kbd>⌘J</Kbd> agent
          </span>
        </footer>
      </div>

      {threadId && (
        <Thread
          key={threadId}
          threadId={threadId}
          position={position >= 0 ? { at: position + 1, of: items.length } : null}
          onBack={closeThread}
          onChanged={applySummary}
          onStep={(step) => {
            const next = items[position + step];
            if (position >= 0 && next) open(next.id);
          }}
          onDone={() => {
            // Move to whatever now sits in this conversation's place, or back to the list.
            const next = position >= 0 ? (items[position + 1] ?? items[position - 1]) : undefined;
            if (next && inLane) open(next.id);
            else closeThread();
          }}
        />
      )}

      {deleteDraft && (
        <ConfirmDialog title="Delete this draft?" confirmLabel="Delete" danger busy={deleting} onClose={() => setDeleteDraft(null)} onConfirm={removeDraft}>
          <p>
            “{deleteDraft.subject || '(no subject)'}” is removed from {account(deleteDraft.accountId)?.email ?? 'the account'}’s Gmail drafts.
            {deleteDraft.status === 'scheduled' ? ' Its scheduled send is cancelled.' : ''}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

function DraftList({
  loading,
  error,
  items,
  now,
  onRetry,
  onOpen,
  onDelete,
}: {
  loading: boolean;
  error: ApiRequestError | null;
  items: Draft[] | undefined;
  now: Date;
  onRetry: () => void;
  onOpen: (draft: Draft) => void;
  onDelete: (draft: Draft) => void;
}) {
  const { account } = useApp();
  if (loading) return <SkeletonRows count={6} />;
  if (!items) return error ? <ErrorState error={error} onRetry={onRetry} /> : null;
  if (items.length === 0) {
    return (
      <EmptyState icon={<PenLine size={22} />} title={EMPTY.drafts!.title}>
        {EMPTY.drafts!.text}
      </EmptyState>
    );
  }
  return (
    <ul className="rows" aria-label="Drafts">
      {items.map((draft) => {
        const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
        return (
          <li key={draft.id} className="row">
            <button type="button" className="row__main" onClick={() => onOpen(draft)}>
              <AccountDot account={account(draft.accountId)} size={7} />
              <span className="row__from">{recipients.length ? recipients.map((r) => displayName(r)).join(', ') : 'No recipients'}</span>
              <span className="row__text">
                <span className="row__subject">{draft.subject || '(no subject)'}</span>
                <span className="row__summary">{draft.bodyText.trim().split('\n')[0]?.slice(0, 140)}</span>
              </span>
              <span className="row__marks">
                {draft.status === 'scheduled' && <span className="mark mark--agent">Sends {shortDateTime(draft.scheduledAt, now)}</span>}
                {draft.status === 'pending_approval' && <span className="mark mark--agent">Needs your OK</span>}
                {draft.status === 'failed' && <span className="mark mark--urgent">Send failed</span>}
                {draft.attachments.length > 0 && <Paperclip size={13} aria-label="Has attachments" />}
              </span>
              <time className="row__time num" dateTime={draft.updatedAt}>
                {listTime(draft.updatedAt, now)}
              </time>
            </button>
            <div className="row__actions">
              <IconButton label="Delete draft" onClick={() => onDelete(draft)}>
                <Trash2 size={15} />
              </IconButton>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
