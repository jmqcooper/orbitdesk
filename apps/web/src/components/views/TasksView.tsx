'use client';

import clsx from 'clsx';
import { differenceInCalendarDays } from 'date-fns';
import { Check, ChevronDown, CornerDownRight, Link2, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { canAct } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { dueLabel, parseDate, plural, safeHref } from '@/lib/format';
import { invalidate, routePath, useNow, useResource, useShortcuts } from '@/lib/hooks';
import type { Id, Task, TaskList } from '@/lib/types';
import { AccountBadge, AccountDot, GapNotice, useApp } from '../AppContext';
import { AccountFilter } from '../Shell';
import { TaskDialog, type TaskDraft } from '../tasks/TaskDialog';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Menu, Notice, Popover, SkeletonRows } from '../ui';

function byPosition(a: Task, b: Task): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: 'overdue', label: 'Overdue' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Next 7 days' },
  { id: 'later', label: 'Later' },
  { id: 'none', label: 'No date' },
];

function bucketOf(task: Task, now: Date): Bucket {
  const due = parseDate(task.due);
  if (!due) return 'none';
  const days = differenceInCalendarDays(due, now);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

export function TasksView({ listId }: { listId?: string }) {
  const { boot, account, scopeParam, scopeKey, navigate, toast, reportError, refreshBoot, patchBoot } = useApp();
  const now = useNow();
  const lists = boot.taskLists.filter((list) => !scopeParam || scopeParam.includes(list.accountId));
  const selected = listId ? boot.taskLists.find((list) => list.id === listId) : undefined;
  const showAll = !listId;

  const tasks = useResource(
    showAll ? `tasks:all:${scopeKey}` : selected ? `tasks:list:${selected.id}` : null,
    (signal) => (showAll ? api.tasks({ accountId: scopeParam, status: 'open', limit: 100 }, { signal }) : api.tasks({ taskListId: listId, status: 'all', limit: 100 }, { signal })),
    { refreshMs: 120_000 },
  );

  const [dialog, setDialog] = useState<{ task?: Task; initial?: TaskDraft; key: number } | null>(null);
  const [quick, setQuick] = useState('');
  const [quickList, setQuickList] = useState<Id>('');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Set<Id>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [listsOpen, setListsOpen] = useState(false);
  const [listDialog, setListDialog] = useState<{ mode: 'create'; accountId: Id } | { mode: 'rename'; list: TaskList } | null>(null);
  const [deleteList, setDeleteList] = useState<TaskList | null>(null);
  const [deletingList, setDeletingList] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const dialogSeq = useRef(0);
  const quickRef = useRef<HTMLInputElement>(null);

  const openDialog = (value: { task?: Task; initial?: TaskDraft }) => {
    dialogSeq.current += 1;
    setDialog({ ...value, key: dialogSeq.current });
  };

  const fallbackList = lists.find((l) => l.id === boot.settings.defaultTaskListId) ?? lists.find((l) => l.isDefault) ?? lists[0];
  const targetListId = selected?.id ?? (lists.some((l) => l.id === quickList) ? quickList : (fallbackList?.id ?? ''));

  useShortcuts((event) => {
    if (event.key === 'n' || event.key === '/') {
      event.preventDefault();
      quickRef.current?.focus();
    }
  });

  const replaceTask = (task: Task) => {
    tasks.mutate((current) => ({
      ...current,
      items: current.items.some((item) => item.id === task.id) ? current.items.map((item) => (item.id === task.id ? task : item)) : [...current.items, task],
    }));
  };

  const settle = (id: Id) =>
    setPending((set) => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });

  const toggle = async (task: Task) => {
    const completed = !task.completed;
    setPending((set) => new Set(set).add(task.id));
    // Show the tick immediately; the server's version replaces it, or it is rolled back.
    replaceTask({ ...task, completed });
    try {
      replaceTask(await api.updateTask(task.id, { completed }));
      refreshBoot();
      invalidate('brief');
      if (completed) {
        toast({
          message: `Done: ${task.title}`,
          action: {
            label: 'Undo',
            run: () => {
              api.updateTask(task.id, { completed: false }).then(
                (reopened) => {
                  replaceTask(reopened);
                  refreshBoot();
                },
                (err) => reportError(err, 'Could not reopen the task'),
              );
            },
          },
        });
      }
    } catch (err) {
      replaceTask(task);
      reportError(err, completed ? 'Could not complete the task' : 'Could not reopen the task');
    } finally {
      settle(task.id);
    }
  };

  const quickAdd = async () => {
    const title = quick.trim();
    if (!title || !targetListId) return;
    setAdding(true);
    try {
      replaceTask(await api.createTask({ taskListId: targetListId, title }));
      setQuick('');
      refreshBoot();
      invalidate('brief');
    } catch (err) {
      reportError(err, 'Could not add the task');
    } finally {
      setAdding(false);
    }
  };

  const remove = async (task: Task) => {
    setPending((set) => new Set(set).add(task.id));
    try {
      await api.deleteTask(task.id);
      tasks.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== task.id && item.parentId !== task.id) }));
      refreshBoot();
      invalidate('brief');
    } catch (err) {
      reportError(err, 'Could not delete the task');
    } finally {
      settle(task.id);
    }
  };

  const loadMore = async () => {
    const cursor = tasks.data?.nextCursor;
    if (!cursor) return;
    setMoreBusy(true);
    try {
      const page = showAll
        ? await api.tasks({ accountId: scopeParam, status: 'open', limit: 100, cursor })
        : await api.tasks({ taskListId: listId, status: 'all', limit: 100, cursor });
      tasks.mutate((current) => ({
        items: [...current.items, ...page.items.filter((item) => !current.items.some((c) => c.id === item.id))],
        nextCursor: page.nextCursor,
        gaps: [...current.gaps, ...page.gaps],
      }));
    } catch (err) {
      reportError(err, 'Could not load more tasks');
    } finally {
      setMoreBusy(false);
    }
  };

  const removeList = async () => {
    if (!deleteList) return;
    setDeletingList(true);
    try {
      await api.deleteTaskList(deleteList.id);
      patchBoot((current) => ({ ...current, taskLists: current.taskLists.filter((l) => l.id !== deleteList.id) }));
      refreshBoot();
      if (listId === deleteList.id) navigate('#/tasks');
      setDeleteList(null);
    } catch (err) {
      reportError(err, 'Could not delete the list');
    } finally {
      setDeletingList(false);
    }
  };

  const items = tasks.data?.items ?? [];
  const open = items.filter((task) => !task.completed);
  const done = items.filter((task) => task.completed);
  const taskAccounts = boot.connections.filter((c) => canAct(c, 'tasks') && (!scopeParam || scopeParam.includes(c.id)));
  const accountIds = Array.from(new Set([...lists.map((l) => l.accountId), ...taskAccounts.map((c) => c.id)]));
  const listTitle = (id: Id) => boot.taskLists.find((l) => l.id === id)?.title ?? 'List';

  const renderTask = (task: Task, depth: number) => {
    const due = dueLabel(task.due, now);
    const sourceHref = safeHref(task.source?.url);
    const busy = pending.has(task.id);
    return (
      <li key={task.id} className={clsx('task', task.completed && 'task--done', depth > 0 && 'task--child')}>
        <button
          type="button"
          role="checkbox"
          aria-checked={task.completed}
          aria-label={task.completed ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className="check-btn"
          disabled={busy}
          onClick={() => toggle(task)}
        >
          {task.completed && <Check size={11} strokeWidth={3.5} />}
        </button>
        <button type="button" className="task__main" onClick={() => openDialog({ task })}>
          <span className="task__title">{task.title || '(untitled)'}</span>
          {task.source && (
            <span className="task__src" title={`From ${task.source.kind}: ${task.source.title}`}>
              <Link2 size={11} aria-hidden="true" /> {task.source.title}
            </span>
          )}
        </button>
        <span className="task__meta">
          {showAll && (
            <span className="task__list" title={account(task.accountId)?.email}>
              <AccountDot account={account(task.accountId)} size={7} />
              {listTitle(task.taskListId)}
            </span>
          )}
          {due && !task.completed && <span className={clsx('due', `due--${due.tone}`)}>{due.text}</span>}
        </span>
        <span className="task__actions">
          {sourceHref && (
            <a className="icon-btn" href={sourceHref} target="_blank" rel="noopener noreferrer" aria-label="Open the source" title="Open the source">
              <Link2 size={15} />
            </a>
          )}
          {depth === 0 && !task.completed && !showAll && (
            <IconButton label="Add a subtask" onClick={() => openDialog({ initial: { taskListId: task.taskListId, parentId: task.id } })}>
              <CornerDownRight size={15} />
            </IconButton>
          )}
          <IconButton label="Delete" busy={busy} onClick={() => remove(task)}>
            <Trash2 size={15} />
          </IconButton>
        </span>
      </li>
    );
  };

  const renderTree = (pool: Task[]) => {
    const ids = new Set(pool.map((t) => t.id));
    const roots = pool.filter((t) => !t.parentId || !ids.has(t.parentId)).sort(byPosition);
    return roots.flatMap((root) => [
      renderTask(root, 0),
      ...pool
        .filter((t) => t.parentId === root.id)
        .sort(byPosition)
        .map((child) => renderTask(child, 1)),
    ]);
  };

  return (
    <div className="mail">
      <header className="bar">
        <Popover
          open={listsOpen}
          onClose={() => setListsOpen(false)}
          panelClassName="acctlist"
          trigger={
            <button type="button" className="tabs__tab is-active" aria-haspopup="menu" aria-expanded={listsOpen} onClick={() => setListsOpen((value) => !value)}>
              {showAll ? 'All tasks' : (selected?.title ?? 'Tasks')}
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          }
        >
          <div role="menu" aria-label="Task lists">
            <a role="menuitem" className="menu__item" href="#/tasks" onClick={() => setListsOpen(false)}>
              <span className="menu__icon">{showAll && <Check size={14} />}</span>
              <span className="menu__label">All tasks</span>
              <span className="menu__hint num">{lists.reduce((sum, l) => sum + l.openCount, 0) || ''}</span>
            </a>
            {accountIds.map((accountId) => {
              const owner = account(accountId);
              return (
                <div key={accountId}>
                  <div className="menu__divider" role="separator" />
                  <div className="menu__title">{owner?.label ?? 'Account'}</div>
                  {lists
                    .filter((l) => l.accountId === accountId)
                    .map((list) => (
                      <a key={list.id} role="menuitem" className="menu__item" href={routePath('tasks', list.id)} onClick={() => setListsOpen(false)}>
                        <span className="menu__icon">{list.id === listId ? <Check size={14} /> : <AccountDot account={owner} size={7} />}</span>
                        <span className="menu__label">{list.title}</span>
                        <span className="menu__hint num">{list.openCount || ''}</span>
                      </a>
                    ))}
                  <button
                    type="button"
                    role="menuitem"
                    className="menu__item"
                    onClick={() => {
                      setListsOpen(false);
                      setListDialog({ mode: 'create', accountId });
                    }}
                  >
                    <span className="menu__icon">
                      <Plus size={14} />
                    </span>
                    <span className="menu__label muted">New list</span>
                  </button>
                </div>
              );
            })}
          </div>
        </Popover>
        {selected && (
          <Menu
            label="List actions"
            align="start"
            button={<MoreHorizontal size={16} />}
            items={[
              { label: 'Rename list', icon: <Pencil size={14} />, onSelect: () => setListDialog({ mode: 'rename', list: selected }) },
              { label: selected.isDefault ? 'The default list can’t be deleted' : 'Delete list', icon: <Trash2 size={14} />, danger: !selected.isDefault, disabled: selected.isDefault, onSelect: () => setDeleteList(selected) },
            ]}
          />
        )}
        <span className="bar__gap" />
        <AccountFilter />
        <IconButton label="New task with details" disabled={lists.length === 0} onClick={() => openDialog({ initial: { taskListId: targetListId || undefined } })}>
          <Plus size={17} />
        </IconButton>
      </header>

      <div className="scroll">
        <div className="column column--narrow">
          {listId && !selected ? (
            <EmptyState title="That list is gone">
              <a href="#/tasks" className="link-btn">
                Show all tasks
              </a>
            </EmptyState>
          ) : (
            <>
              <form
                className="quickadd"
                onSubmit={(e) => {
                  e.preventDefault();
                  void quickAdd();
                }}
              >
                <Plus size={16} aria-hidden="true" />
                <input
                  ref={quickRef}
                  className="quickadd__input"
                  type="text"
                  aria-label="New task"
                  placeholder={lists.length ? 'Add a task' : 'Connect an account with Google Tasks first'}
                  value={quick}
                  disabled={lists.length === 0 || adding}
                  onChange={(e) => setQuick(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') e.currentTarget.blur();
                  }}
                />
                {showAll && lists.length > 1 && (
                  <select className="quickadd__list" aria-label="List to add to" value={targetListId} onChange={(e) => setQuickList(e.target.value)}>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title} · {account(l.accountId)?.label ?? 'account'}
                      </option>
                    ))}
                  </select>
                )}
              </form>

              {tasks.data && <GapNotice gaps={tasks.data.gaps} />}
              {tasks.loading && <SkeletonRows count={6} />}
              {tasks.error && !tasks.data && <ErrorState error={tasks.error} onRetry={tasks.reload} />}

              {tasks.data && open.length === 0 && (
                <EmptyState icon={<ListChecks size={22} />} title={showAll ? 'Nothing to do' : 'This list is clear'}>
                  Tasks the agent spots in your mail show up as one-click suggestions in the conversation.
                </EmptyState>
              )}

              {tasks.data &&
                open.length > 0 &&
                showAll &&
                BUCKETS.map((bucket) => {
                  const inBucket = open.filter((task) => bucketOf(task, now) === bucket.id).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
                  if (!inBucket.length) return null;
                  return (
                    <section key={bucket.id} className="taskgroup">
                      <h2 className={clsx('taskgroup__title', bucket.id === 'overdue' && 'is-overdue')}>
                        {bucket.label} <span>{inBucket.length}</span>
                      </h2>
                      <ul>{inBucket.map((task) => renderTask(task, 0))}</ul>
                    </section>
                  );
                })}

              {tasks.data && open.length > 0 && !showAll && <ul>{renderTree(open)}</ul>}

              {tasks.data && !showAll && done.length > 0 && (
                <section className="taskgroup">
                  <button type="button" className="taskgroup__title taskgroup__title--toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                    Completed <span>{done.length}</span>
                    <ChevronDown size={13} aria-hidden="true" style={{ transform: showDone ? 'rotate(180deg)' : undefined }} />
                  </button>
                  {showDone && <ul>{done.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')).map((task) => renderTask(task, 0))}</ul>}
                </section>
              )}

              {tasks.data?.nextCursor && (
                <div className="more">
                  <Button size="sm" variant="ghost" busy={moreBusy} onClick={loadMore}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {dialog && (
        <TaskDialog
          key={dialog.key}
          task={dialog.task}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            if (showAll || saved.taskListId === listId) replaceTask(saved);
            else tasks.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== saved.id) }));
          }}
          onDeleted={(id) => tasks.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== id && item.parentId !== id) }))}
        />
      )}

      {listDialog && (
        <ListDialog
          state={listDialog}
          onClose={() => setListDialog(null)}
          onSaved={(list, created) => {
            patchBoot((current) => ({ ...current, taskLists: created ? [...current.taskLists, list] : current.taskLists.map((l) => (l.id === list.id ? list : l)) }));
            refreshBoot();
            if (created) navigate(routePath('tasks', list.id));
          }}
        />
      )}

      {deleteList && (
        <ConfirmDialog title={`Delete “${deleteList.title}”?`} confirmLabel="Delete list" danger busy={deletingList} onClose={() => setDeleteList(null)} onConfirm={removeList}>
          <p>
            The list and its {deleteList.openCount ? plural(deleteList.openCount, 'open task') : 'tasks'} are deleted from Google Tasks in{' '}
            {account(deleteList.accountId)?.email ?? 'the account'}. This cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function ListDialog({
  state,
  onClose,
  onSaved,
}: {
  state: { mode: 'create'; accountId: Id } | { mode: 'rename'; list: TaskList };
  onClose: () => void;
  onSaved: (list: TaskList, created: boolean) => void;
}) {
  const [title, setTitle] = useState(state.mode === 'rename' ? state.list.title : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const accountId = state.mode === 'create' ? state.accountId : state.list.accountId;

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const saved = state.mode === 'create' ? await api.createTaskList({ accountId: state.accountId, title: title.trim() }) : await api.updateTaskList(state.list.id, { title: title.trim() });
      onSaved(saved, state.mode === 'create');
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={state.mode === 'create' ? 'New list' : 'Rename list'}
      size="sm"
      onClose={onClose}
      kicker={<AccountBadge accountId={accountId} showEmail />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={submit}>
            {state.mode === 'create' ? 'Create' : 'Rename'}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </Field>
        {error && <Notice tone="danger">{error.message}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
