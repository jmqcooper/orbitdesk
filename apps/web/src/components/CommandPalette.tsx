'use client';

import clsx from 'clsx';
import {
  CalendarDays,
  CornerDownLeft,
  FileText,
  FolderOpen,
  Inbox,
  ListChecks,
  ListPlus,
  Mail,
  Repeat,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquarePen,
  Sun,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { displayName, dueLabel, listTime, safeHref } from '@/lib/format';
import { routePath, useDebounced, useResource } from '@/lib/hooks';
import { AccountBadge, useApp } from './AppContext';
import { TaskDialog } from './tasks/TaskDialog';
import { Dialog, Kbd, Spinner } from './ui';

interface Item {
  id: string;
  section: string;
  icon: LucideIcon;
  title: string;
  detail?: ReactNode;
  meta?: ReactNode;
  run: () => void;
}

interface Command {
  title: string;
  keywords: string;
  icon: LucideIcon;
  run: () => void;
}

/** ⌘K: jump to a view, start something, or search mail, tasks and files through the API. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { boot, navigate, compose, scopeParam, setAssistantSeed } = useApp();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const query = text.trim();
  const q = useDebounced(query, 260);
  const searching = q.length >= 2;

  const mail = useResource(searching ? `palette:threads:${q}` : null, (signal) =>
    api.threads({ q, folder: 'all', limit: 6, accountId: scopeParam }, { signal }),
  );
  const tasks = useResource(searching ? `palette:tasks:${q}` : null, (signal) =>
    api.tasks({ q, status: 'open', limit: 5, accountId: scopeParam }, { signal }),
  );
  const filesOn = boot.capabilities.files.available;
  const files = useResource(searching && filesOn ? `palette:files:${q}` : null, (signal) =>
    api.files({ q, limit: 5, accountId: scopeParam }, { signal }),
  );

  const go = (path: string) => {
    navigate(path);
    onClose();
  };

  const commands = useMemo<Command[]>(
    () => [
      {
        title: 'Compose a new message',
        keywords: 'write email mail new compose',
        icon: SquarePen,
        run: () => {
          compose({ mode: 'new' });
          onClose();
        },
      },
      { title: 'Go to Today', keywords: 'brief home daily', icon: Sun, run: () => go('#/today') },
      { title: 'Go to Inbox', keywords: 'mail email', icon: Inbox, run: () => go('#/inbox') },
      { title: 'Go to Drafts', keywords: 'mail email draft', icon: Mail, run: () => go('#/inbox/drafts') },
      { title: 'Go to Calendar', keywords: 'events week agenda meeting', icon: CalendarDays, run: () => go('#/calendar') },
      { title: 'Go to Tasks', keywords: 'todo list', icon: ListChecks, run: () => go('#/tasks') },
      { title: 'Go to Assistant', keywords: 'chat ask agent ai', icon: Sparkles, run: () => go('#/assistant') },
      { title: 'Go to Files', keywords: 'drive docs sheets slides', icon: FolderOpen, run: () => go('#/files') },
      { title: 'Go to Approvals', keywords: 'actions pending scheduled history activity', icon: ShieldCheck, run: () => go('#/approvals') },
      { title: 'Go to Automations', keywords: 'schedule brief follow-up triage', icon: Repeat, run: () => go('#/automations') },
      { title: 'Go to Connections', keywords: 'accounts google link reconnect permissions', icon: Settings2, run: () => go('#/connections') },
      { title: 'Go to Preferences', keywords: 'settings timezone working hours defaults', icon: Settings2, run: () => go('#/settings') },
    ],
    // `go` and `compose` only close over stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compose, navigate, onClose],
  );

  const items: Item[] = [];
  const needle = query.toLowerCase();
  for (const command of commands) {
    if (needle && !`${command.title} ${command.keywords}`.toLowerCase().includes(needle)) continue;
    items.push({ id: `cmd:${command.title}`, section: 'Go to', icon: command.icon, title: command.title, run: command.run });
  }
  if (query) {
    items.push({
      id: 'cmd:new-task',
      section: 'Create',
      icon: ListPlus,
      title: `New task “${query}”`,
      run: () => setTaskTitle(query),
    });
    if (boot.capabilities.agent.available) {
      items.push({
        id: 'cmd:ask',
        section: 'Create',
        icon: Sparkles,
        title: `Ask the assistant “${query}”`,
        run: () => {
          setAssistantSeed({ text: query, send: true });
          go('#/assistant');
        },
      });
    }
  }
  for (const thread of mail.data?.items ?? []) {
    items.push({
      id: `thread:${thread.id}`,
      section: 'Mail',
      icon: Mail,
      title: thread.subject || '(no subject)',
      detail: `${displayName(thread.participants[0])} — ${thread.snippet}`,
      meta: (
        <>
          <AccountBadge accountId={thread.accountId} />
          <span>{listTime(thread.lastMessageAt)}</span>
        </>
      ),
      run: () => go(routePath('inbox', 'all', thread.id)),
    });
  }
  for (const task of tasks.data?.items ?? []) {
    const due = dueLabel(task.due);
    items.push({
      id: `task:${task.id}`,
      section: 'Tasks',
      icon: ListChecks,
      title: task.title,
      detail: due ? `Due ${due.text}` : undefined,
      meta: <AccountBadge accountId={task.accountId} />,
      run: () => go(routePath('tasks', task.taskListId)),
    });
  }
  for (const file of files.data?.items ?? []) {
    const href = safeHref(file.url);
    items.push({
      id: `file:${file.id}`,
      section: 'Files',
      icon: FileText,
      title: file.name,
      meta: <AccountBadge accountId={file.accountId} />,
      run: () => {
        if (href) window.open(href, '_blank', 'noopener');
        else navigate('#/files');
        onClose();
      },
    });
  }

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, items.length]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive(items.length ? (activeIndex + 1) % items.length : 0);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(items.length ? (activeIndex - 1 + items.length) % items.length : 0);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items[activeIndex]?.run();
    }
  };

  if (taskTitle !== null) {
    return <TaskDialog initial={{ title: taskTitle }} onClose={onClose} />;
  }

  const lookups = [
    { name: 'mail', resource: mail, on: searching },
    { name: 'tasks', resource: tasks, on: searching },
    { name: 'files', resource: files, on: searching && filesOn },
  ].filter((lookup) => lookup.on);
  const busy = lookups.some((lookup) => lookup.resource.loading);
  const failures = lookups.filter((lookup) => lookup.resource.error);

  let lastSection = '';

  return (
    <Dialog title="Search and commands" onClose={onClose} bare size="lg" className="palette">
      <div className="palette__field">
        <Search size={18} aria-hidden="true" />
        <input
          className="palette__input"
          type="text"
          role="combobox"
          aria-label="Search mail, tasks and files, or type a command"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[activeIndex] ? `palette-${activeIndex}` : undefined}
          placeholder="Search mail, tasks and files — or type a command"
          data-autofocus
          autoComplete="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {busy ? <Spinner size={16} label="Searching" /> : <Kbd>esc</Kbd>}
      </div>

      <div className="palette__list" id="palette-list" role="listbox" aria-label="Results" ref={listRef}>
        {items.map((item, index) => {
          const Icon = item.icon;
          const header = item.section !== lastSection ? item.section : null;
          lastSection = item.section;
          return (
            <div key={item.id}>
              {header && (
                <div className="palette__section" role="presentation">
                  {header}
                </div>
              )}
              <div
                id={`palette-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                className={clsx('palette__item', index === activeIndex && 'is-active')}
                onMouseMove={() => setActive(index)}
                onClick={item.run}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="palette__text">
                  <span className="palette__title">{item.title}</span>
                  {item.detail && <span className="palette__detail">{item.detail}</span>}
                </span>
                {item.meta && <span className="palette__meta">{item.meta}</span>}
                {index === activeIndex && <CornerDownLeft size={14} className="palette__enter" aria-hidden="true" />}
              </div>
            </div>
          );
        })}
        {items.length === 0 && <p className="palette__empty">Nothing matches “{query}”.</p>}
        {failures.map((lookup) => (
          <p key={lookup.name} className="palette__error" role="status">
            Searching {lookup.name} failed: {lookup.resource.error?.message}
          </p>
        ))}
      </div>

      <div className="palette__foot">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>↵</Kbd> to open
        </span>
        <span className="palette__scope">
          {searching ? `Searching ${scopeParam ? `${scopeParam.length} selected` : 'all'} accounts` : 'Type two or more letters to search your accounts'}
        </span>
      </div>
    </Dialog>
  );
}
