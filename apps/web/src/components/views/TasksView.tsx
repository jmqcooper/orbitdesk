'use client';

import clsx from 'clsx';
import { differenceInCalendarDays } from 'date-fns';
import { Bell, Check, ChevronDown, ChevronRight, CornerDownRight, Link2, ListChecks, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { canAct } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { dueLabel, parseDate, plural, safeHref, shortDateTime } from '@/lib/format';
import { invalidate, routePath, useNow, useResource } from '@/lib/hooks';
import type { Id, Task, TaskList } from '@/lib/types';
import { AccountBadge, AccountDot, GapNotice, useApp } from '../AppContext';
import { TaskDialog, type TaskDraft } from '../tasks/TaskDialog';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Menu,
  Notice,
  SkeletonRows,
  StaleNotice,
  ViewHeader,
} from '../ui';

function byPosition(a: Task, b: Task): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}

type Bucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'Next 7 days',
  later: 'Later',
  none: 'No due date',
};

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
    (signal) =>
      showAll
        ? api.tasks({ accountId: scopeParam, status: 'open', limit: 200 }, { signal })
        : api.tasks({ taskListId: listId, status: 'all', limit: 200 }, { signal }),
    { refreshMs: 120_000 },
  );

  const [dialog, setDialog] = useState<{ task?: Task; initial?: TaskDraft; key: number } | null>(null);
  const [quick, setQuick] = useState('');
  const [quickDue, setQuickDue] = useState('');
  const [quickList, setQuickList] = useState<Id>('');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Set<Id>>(new Set());
  const [showDone, setShowDone] = useState(false);
  const [listDialog, setListDialog] = useState<{ mode: 'create'; accountId: Id } | { mode: 'rename'; list: TaskList } | null>(null);
  const [deleteList, setDeleteList] = useState<TaskList | null>(null);
  const [deletingList, setDeletingList] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const [dialogSeq, setDialogSeq] = useState(0);

  const openDialog = (value: { task?: Task; initial?: TaskDraft }) => {
    setDialogSeq((n) => n + 1);
    setDialog({ ...value, key: dialogSeq + 1 });
  };

  const fallbackList =
    lists.find((l) => l.id === boot.settings.defaultTaskListId) ?? lists.find((l) => l.isDefault) ?? lists[0];
  const targetListId = selected?.id ?? (lists.some((l) => l.id === quickList) ? quickList : (fallbackList?.id ?? ''));

  const replaceTask = (task: Task) => {
    tasks.mutate((current) => ({
      ...current,
      items: current.items.some((item) => item.id === task.id)
        ? current.items.map((item) => (item.id === task.id ? task : item))
        : [...current.items, task],
    }));
  };

  const toggle = async (task: Task) => {
    const completed = !task.completed;
    setPending((set) => new Set(set).add(task.id));
    // Show the tick immediately; the server's version replaces it, or it is rolled back.
    replaceTask({ ...task, completed });
    try {
      const saved = await api.updateTask(task.id, { completed });
      replaceTask(saved);
      refreshBoot();
      invalidate('brief');
      if (completed) {
        toast({
          message: `Completed “${task.title}”.`,
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
      setPending((set) => {
        const next = new Set(set);
        next.delete(task.id);
        return next;
      });
    }
  };

  const quickAdd = async () => {
    const title = quick.trim();
    if (!title || !targetListId) return;
    setAdding(true);
    try {
      const created = await api.createTask({ taskListId: targetListId, title, due: quickDue || null });
      replaceTask(created);
      setQuick('');
      setQuickDue('');
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
      tasks.mutate((current) => ({
        ...current,
        items: current.items.filter((item) => item.id !== task.id && item.parentId !== task.id),
      }));
      refreshBoot();
      invalidate('brief');
      toast({ message: 'Task deleted.' });
    } catch (err) {
      reportError(err, 'Could not delete the task');
    } finally {
      setPending((set) => {
        const next = new Set(set);
        next.delete(task.id);
        return next;
      });
    }
  };

  const loadMore = async () => {
    const cursor = tasks.data?.nextCursor;
    if (!cursor) return;
    setMoreBusy(true);
    try {
      const page = showAll
        ? await api.tasks({ accountId: scopeParam, status: 'open', limit: 200, cursor })
        : await api.tasks({ taskListId: listId, status: 'all', limit: 200, cursor });
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
      toast({ message: `Deleted the list “${deleteList.title}”.` });
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
  const accountIds = Array.from(new Set(lists.map((l) => l.accountId)));
  const taskAccounts = boot.connections.filter((c) => canAct(c, 'tasks') && (!scopeParam || scopeParam.includes(c.id)));
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
          className="task__check"
          disabled={busy}
          onClick={() => toggle(task)}
        >
          {task.completed && <Check size={13} strokeWidth={3} />}
        </button>
        <button type="button" className="task__main" onClick={() => openDialog({ task })}>
          <span className="task__title">{task.title || '(untitled)'}</span>
          <span className="task__meta">
            {due && !task.completed && <span className={clsx('due', `due--${due.tone}`)}>{due.text}</span>}
            {task.reminderAt && (
              <span className="task__chip" title="Orbitdesk reminder">
                <Bell size={11} aria-hidden="true" /> {shortDateTime(task.reminderAt, now)}
              </span>
            )}
            {task.source && (
              <span className="task__chip" title={`From ${task.source.kind}: ${task.source.title}`}>
                <Link2 size={11} aria-hidden="true" /> {task.source.title}
              </span>
            )}
            {task.assigned && <span className="task__chip">Assigned</span>}
            {showAll && (
              <>
                <AccountBadge accountId={task.accountId} />
                <span className="task__list">{listTitle(task.taskListId)}</span>
              </>
            )}
            {task.notes && <span className="task__notes">{task.notes.split('\n')[0]}</span>}
          </span>
        </button>
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
          <IconButton label="Delete task" busy={busy} onClick={() => remove(task)}>
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

  const buckets: Bucket[] = ['overdue', 'today', 'week', 'later', 'none'];

  return (
    <div className="view view--tasks">
      <ViewHeader
        kicker={`Tasks · ${plural(lists.length, 'list')} in ${plural(accountIds.length, 'account')}`}
        title={showAll ? 'All open tasks' : (selected?.title ?? 'Tasks')}
        aside={
          <Button
            variant="primary"
            icon={<Plus size={15} />}
            disabled={lists.length === 0}
            onClick={() => openDialog({ initial: { taskListId: targetListId || undefined } })}
          >
            New task
          </Button>
        }
      >
        {selected && <AccountBadge accountId={selected.accountId} showEmail />}
      </ViewHeader>

      <div className="tasks">
        <aside className="tasks__lists" aria-label="Task lists">
          <a className={clsx('tasks__list', showAll && 'is-active')} href="#/tasks" aria-current={showAll ? 'page' : undefined}>
            <ListChecks size={15} aria-hidden="true" />
            <span className="tasks__list-name">All open tasks</span>
            <span className="tasks__list-count">{lists.reduce((sum, l) => sum + l.openCount, 0) || ''}</span>
          </a>
          {taskAccounts.length === 0 && lists.length === 0 && (
            <p className="tasks__none">No connected account has Google Tasks access.</p>
          )}
          {Array.from(new Set([...accountIds, ...taskAccounts.map((c) => c.id)])).map((accountId) => {
            const owner = account(accountId);
            return (
              <div key={accountId} className="tasks__group">
                <div className="tasks__owner">
                  <AccountDot account={owner} />
                  <span className="tasks__owner-name">{owner?.label ?? 'Account'}</span>
                  <IconButton label={`New list in ${owner?.label ?? 'this account'}`} onClick={() => setListDialog({ mode: 'create', accountId })}>
                    <Plus size={14} />
                  </IconButton>
                </div>
                {lists
                  .filter((l) => l.accountId === accountId)
                  .map((list) => {
                    const active = list.id === listId;
                    return (
                      <div key={list.id} className={clsx('tasks__list', active && 'is-active')}>
                        <a className="tasks__list-link" href={routePath('tasks', list.id)} aria-current={active ? 'page' : undefined}>
                          <span className="tasks__list-name">{list.title}</span>
                          <span className="tasks__list-count">{list.openCount || ''}</span>
                        </a>
                        <Menu
                          label={`Actions for ${list.title}`}
                          button={<MoreHorizontal size={15} />}
                          buttonClassName="icon-btn icon-btn--sm tasks__list-menu"
                          items={[
                            { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setListDialog({ mode: 'rename', list }) },
                            {
                              label: list.isDefault ? 'Default list can’t be deleted' : 'Delete list',
                              icon: <Trash2 size={14} />,
                              danger: !list.isDefault,
                              disabled: list.isDefault,
                              onSelect: () => setDeleteList(list),
                            },
                          ]}
                        />
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </aside>

        <section className="tasks__main" aria-label={showAll ? 'All open tasks' : (selected?.title ?? 'Tasks')}>
          {listId && !selected ? (
            <EmptyState title="That list is not available">
              It may have been deleted, or its account was disconnected.{' '}
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
                <Plus size={16} aria-hidden="true" className="quickadd__icon" />
                <input
                  className="quickadd__input"
                  type="text"
                  aria-label="New task title"
                  placeholder={lists.length ? 'Add a task and press Enter' : 'Connect an account with Google Tasks to add tasks'}
                  value={quick}
                  disabled={lists.length === 0}
                  onChange={(e) => setQuick(e.target.value)}
                />
                <input
                  className="quickadd__date"
                  type="date"
                  aria-label="Due date"
                  value={quickDue}
                  disabled={lists.length === 0}
                  onChange={(e) => setQuickDue(e.target.value)}
                />
                {showAll && lists.length > 0 && (
                  <select className="quickadd__list" aria-label="List to add to" value={targetListId} onChange={(e) => setQuickList(e.target.value)}>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.title} — {account(l.accountId)?.label ?? 'account'}
                      </option>
                    ))}
                  </select>
                )}
                <Button type="submit" size="sm" variant="primary" busy={adding} disabled={!quick.trim() || !targetListId}>
                  Add
                </Button>
              </form>

              {tasks.data && <GapNotice gaps={tasks.data.gaps} />}
              {tasks.error && tasks.data && <StaleNotice error={tasks.error} onRetry={tasks.reload} />}
              {tasks.loading && <SkeletonRows count={7} />}
              {tasks.error && !tasks.data && <ErrorState error={tasks.error} onRetry={tasks.reload} />}

              {tasks.data && open.length === 0 && (
                <EmptyState icon={<ListChecks size={22} />} title={showAll ? 'No open tasks' : 'This list is clear'}>
                  {tasks.data.gaps.length
                    ? 'Some lists could not be read — see the notice above.'
                    : 'Add one above, or create a task from an email with the “Create task” button in any conversation.'}
                </EmptyState>
              )}

              {tasks.data && open.length > 0 && showAll && (
                <div className="taskgroups">
                  {buckets.map((bucket) => {
                    const inBucket = open.filter((task) => bucketOf(task, now) === bucket).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
                    if (!inBucket.length) return null;
                    return (
                      <section key={bucket} className={clsx('taskgroup', `taskgroup--${bucket}`)}>
                        <h2 className="taskgroup__title">
                          {BUCKET_LABEL[bucket]} <span>{inBucket.length}</span>
                        </h2>
                        <ul className="tasklist">{inBucket.map((task) => renderTask(task, 0))}</ul>
                      </section>
                    );
                  })}
                </div>
              )}

              {tasks.data && open.length > 0 && !showAll && <ul className="tasklist">{renderTree(open)}</ul>}

              {tasks.data && !showAll && done.length > 0 && (
                <section className="taskdone">
                  <button type="button" className="taskdone__toggle" aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
                    {showDone ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    Completed <span>{done.length}</span>
                  </button>
                  {showDone && (
                    <ul className="tasklist">
                      {done
                        .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))
                        .map((task) => renderTask(task, 0))}
                    </ul>
                  )}
                </section>
              )}

              {tasks.data?.nextCursor && (
                <div className="inbox__more">
                  <Button busy={moreBusy} onClick={loadMore}>
                    Load more tasks
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
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
          onDeleted={(id) =>
            tasks.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== id && item.parentId !== id) }))
          }
        />
      )}

      {listDialog && (
        <ListDialog
          state={listDialog}
          onClose={() => setListDialog(null)}
          onSaved={(list, created) => {
            patchBoot((current) => ({
              ...current,
              taskLists: created ? [...current.taskLists, list] : current.taskLists.map((l) => (l.id === list.id ? list : l)),
            }));
            refreshBoot();
            if (created) navigate(routePath('tasks', list.id));
          }}
        />
      )}

      {deleteList && (
        <ConfirmDialog
          title={`Delete “${deleteList.title}”?`}
          confirmLabel="Delete list"
          danger
          busy={deletingList}
          onClose={() => setDeleteList(null)}
          onConfirm={removeList}
        >
          <p>
            The list and its {deleteList.openCount ? plural(deleteList.openCount, 'open task') : 'tasks'} are deleted from
            Google Tasks in {account(deleteList.accountId)?.email ?? 'the account'}. This cannot be undone.
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
      const saved =
        state.mode === 'create'
          ? await api.createTaskList({ accountId: state.accountId, title: title.trim() })
          : await api.updateTaskList(state.list.id, { title: title.trim() });
      onSaved(saved, state.mode === 'create');
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={state.mode === 'create' ? 'New task list' : 'Rename list'}
      size="sm"
      onClose={onClose}
      kicker={<AccountBadge accountId={accountId} showEmail />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!title.trim()} onClick={submit}>
            {state.mode === 'create' ? 'Create list' : 'Rename'}
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
        <Field label="List name" hint="The list is created in Google Tasks for this account.">
          <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus />
        </Field>
        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
