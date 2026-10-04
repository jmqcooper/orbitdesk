'use client';

import { ExternalLink, Link2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { parseDate, safeHref, toDateTimeInput, toIso } from '@/lib/format';
import { invalidate } from '@/lib/hooks';
import type { Id, SourceRef, Task } from '@/lib/types';
import { AccountBadge, useApp } from '../AppContext';
import { Button, Dialog, Field, Notice } from '../ui';

export interface TaskDraft {
  title?: string;
  notes?: string;
  due?: string | null;
  taskListId?: Id;
  /** Prefer a list in this account when no list is given. */
  accountId?: Id;
  parentId?: Id | null;
  source?: SourceRef | null;
}

/**
 * Create or edit one Google task. In edit mode the list can only change
 * within the task's own account, which is what Google allows.
 */
export function TaskDialog({
  task,
  initial,
  onClose,
  onSaved,
  onDeleted,
}: {
  task?: Task;
  initial?: TaskDraft;
  onClose: () => void;
  onSaved?: (task: Task) => void;
  onDeleted?: (id: Id) => void;
}) {
  const { boot, toast, refreshBoot, navigate } = useApp();
  const lists = task ? boot.taskLists.filter((list) => list.accountId === task.accountId) : boot.taskLists;

  const pickList = (): Id => {
    if (task) return task.taskListId;
    if (initial?.taskListId && lists.some((l) => l.id === initial.taskListId)) return initial.taskListId;
    const inAccount = initial?.accountId ? lists.filter((l) => l.accountId === initial.accountId) : [];
    const preferred =
      inAccount.find((l) => l.isDefault) ??
      inAccount[0] ??
      lists.find((l) => l.id === boot.settings.defaultTaskListId) ??
      lists.find((l) => l.isDefault) ??
      lists[0];
    return preferred?.id ?? '';
  };

  const [title, setTitle] = useState(task?.title ?? initial?.title ?? '');
  const [notes, setNotes] = useState(task?.notes ?? initial?.notes ?? '');
  const [due, setDue] = useState(task?.due ?? initial?.due ?? '');
  const [taskListId, setTaskListId] = useState<Id>(pickList);
  const [reminder, setReminder] = useState(() => {
    const date = parseDate(task?.reminderAt);
    return date ? toDateTimeInput(date) : '';
  });
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const source = task?.source ?? initial?.source ?? null;
  const selectedList = lists.find((l) => l.id === taskListId);
  const accountIds = Array.from(new Set(lists.map((l) => l.accountId)));

  const submit = async () => {
    if (!title.trim() || !taskListId) return;
    setBusy('save');
    setError(null);
    const reminderDate = reminder ? new Date(reminder) : null;
    const reminderAt = reminderDate && !Number.isNaN(reminderDate.getTime()) ? toIso(reminderDate) : null;
    try {
      const saved = task
        ? await api.updateTask(task.id, {
            title: title.trim(),
            notes: notes.trim() ? notes : null,
            due: due || null,
            reminderAt,
            taskListId: taskListId !== task.taskListId ? taskListId : undefined,
          })
        : await api.createTask({
            taskListId,
            title: title.trim(),
            notes: notes.trim() ? notes : null,
            due: due || null,
            reminderAt,
            parentId: initial?.parentId ?? null,
            source,
          });
      invalidate('tasks', 'brief');
      refreshBoot();
      onSaved?.(saved);
      if (!task) {
        toast({
          tone: 'ok',
          message: `Task added to ${selectedList?.title ?? 'the list'}.`,
          action: { label: 'View', run: () => navigate(`#/tasks/${encodeURIComponent(saved.taskListId)}`) },
        });
      }
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!task) return;
    setBusy('delete');
    setError(null);
    try {
      await api.deleteTask(task.id);
      invalidate('tasks', 'brief');
      refreshBoot();
      onDeleted?.(task.id);
      toast({ message: 'Task deleted.' });
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(null);
    }
  };

  const sourceHref = safeHref(source?.url);

  return (
    <Dialog
      title={task ? 'Edit task' : source ? 'Create task from email' : 'New task'}
      onClose={onClose}
      kicker={selectedList ? <AccountBadge accountId={selectedList.accountId} showEmail /> : undefined}
      footer={
        <>
          {task && (
            <Button variant="ghost" icon={<Trash2 size={15} />} busy={busy === 'delete'} disabled={busy !== null} onClick={remove} className="dialog__foot-left">
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy === 'save'} disabled={busy !== null || !title.trim() || !taskListId} onClick={submit}>
            {task ? 'Save task' : 'Add task'}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {lists.length === 0 && (
          <Notice tone="warn">
            No task lists are available. Connect an account with Google Tasks access, or create a list in the Tasks view.
          </Notice>
        )}
        {task?.assigned && (
          <Notice tone="info">This task was assigned from another Google app. Google may refuse some edits.</Notice>
        )}
        <Field label="Title">
          <input className="input" type="text" value={title} onChange={(e) => setTitle(e.target.value)} data-autofocus required />
        </Field>
        <div className="form__row">
          <Field label="List" hint={task ? 'A task can move between lists of the same account.' : undefined}>
            <select className="input" value={taskListId} onChange={(e) => setTaskListId(e.target.value)} disabled={lists.length === 0}>
              {accountIds.map((accountId) => {
                const owner = boot.connections.find((c) => c.id === accountId);
                return (
                  <optgroup key={accountId} label={owner ? `${owner.label} — ${owner.email}` : 'Account'}>
                    {lists
                      .filter((l) => l.accountId === accountId)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {l.title}
                        </option>
                      ))}
                  </optgroup>
                );
              })}
            </select>
          </Field>
          <Field label="Due date" hint="Google Tasks stores a date, not a time.">
            <input className="input" type="date" value={due ?? ''} onChange={(e) => setDue(e.target.value)} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="input input--area" rows={4} value={notes ?? ''} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <Field label="Orbitdesk reminder" hint="Optional. Kept in Orbitdesk and separate from the Google due date.">
          <input className="input" type="datetime-local" value={reminder} onChange={(e) => setReminder(e.target.value)} />
        </Field>

        {source && (
          <div className="sourceline">
            <Link2 size={14} aria-hidden="true" />
            <span className="sourceline__text">
              <span className="sourceline__kind">From {source.kind}</span> {source.title}
            </span>
            {sourceHref && (
              <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="link-btn">
                Open <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </div>
        )}

        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
          </Notice>
        )}
        {/* Enter in a text field submits the form. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
