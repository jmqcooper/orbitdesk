'use client';

import clsx from 'clsx';
import {
  CalendarDays,
  CornerDownLeft,
  FileText,
  FolderOpen,
  Keyboard,
  ListChecks,
  ListPlus,
  LogOut,
  Mail,
  Moon,
  PenLine,
  Search,
  Settings2,
  Sparkles,
  SquarePen,
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
  agent?: boolean;
  run: () => void;
}

interface Command {
  title: string;
  keywords: string;
  icon: LucideIcon;
  hint?: string;
  run: () => void;
}

/** ⌘K: ask the agent, jump anywhere, or search mail, tasks and files. */
export function CommandPalette({ onClose, onShortcuts, onToggleTheme }: { onClose: () => void; onShortcuts: () => void; onToggleTheme: () => void }) {
  const { boot, navigate, compose, scopeParam, ask, openSettings, signOut, toast, reportError, refreshBoot } = useApp();
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const query = text.trim();
  const q = useDebounced(query, 260);
  const searching = q.length >= 2;
  const agentOn = boot.capabilities.agent.available;

  const mail = useResource(searching ? `palette:threads:${q}` : null, (signal) => api.threads({ q, folder: 'all', limit: 6, accountId: scopeParam }, { signal }));
  const tasks = useResource(searching ? `palette:tasks:${q}` : null, (signal) => api.tasks({ q, status: 'open', limit: 4, accountId: scopeParam }, { signal }));
  const filesOn = boot.capabilities.files.available;
  const files = useResource(searching && filesOn ? `palette:files:${q}` : null, (signal) => api.files({ q, limit: 4, accountId: scopeParam }, { signal }));

  const commands = useMemo<Command[]>(() => {
    const go = (path: string) => () => {
      navigate(path);
      onClose();
    };
    const then = (run: () => void) => () => {
      onClose();
      run();
    };
    return [
      { title: 'Compose', keywords: 'write email mail new message', icon: SquarePen, hint: 'C', run: then(() => compose({ mode: 'new' })) },
      { title: 'Mail', keywords: 'inbox reply lanes', icon: Mail, hint: 'G M', run: go('#/mail') },
      { title: 'Calendar', keywords: 'events week agenda meeting', icon: CalendarDays, hint: 'G C', run: go('#/calendar') },
      { title: 'Tasks', keywords: 'todo list', icon: ListChecks, hint: 'G T', run: go('#/tasks') },
      { title: 'Files', keywords: 'drive docs sheets slides', icon: FolderOpen, hint: 'G F', run: go('#/files') },
      { title: 'Drafts', keywords: 'mail unsent', icon: PenLine, run: go('#/mail/drafts') },
      { title: 'Waiting on others', keywords: 'sent follow up unanswered', icon: Mail, run: go('#/mail/waiting') },
      { title: 'Open the agent', keywords: 'chat ask assistant ai today brief approvals', icon: Sparkles, hint: '⌘J', run: then(() => ask()) },
      {
        title: 'Sort my inbox now',
        keywords: 'triage agent lanes draft',
        icon: Sparkles,
        run: then(() => {
          api.runTriage(scopeParam).then(
            (result) => {
              refreshBoot();
              if (result.sorted || result.drafted) toast({ tone: 'ok', message: `Sorted ${result.sorted}, drafted ${result.drafted}.` });
              else toast(result.error ? { tone: 'error', message: result.error } : { message: 'Nothing new to sort.' });
            },
            (err) => reportError(err, 'The agent could not sort'),
          );
        }),
      },
      { title: 'Settings', keywords: 'accounts connect google voice preferences agent', icon: Settings2, hint: '⌘,', run: then(() => openSettings('accounts')) },
      { title: 'Change my voice', keywords: 'tone persona prompt writing style', icon: Settings2, run: then(() => openSettings('voice')) },
      { title: 'Keyboard shortcuts', keywords: 'keys help', icon: Keyboard, hint: '?', run: then(onShortcuts) },
      { title: 'Switch theme', keywords: 'dark light appearance', icon: Moon, run: then(onToggleTheme) },
      { title: boot.session.mode === 'demo' ? 'Leave the sandbox' : 'Sign out', keywords: 'logout exit', icon: LogOut, run: then(signOut) },
    ];
  }, [ask, boot.session.mode, compose, navigate, onClose, onShortcuts, onToggleTheme, openSettings, refreshBoot, reportError, scopeParam, signOut, toast]);

  const items: Item[] = [];
  const needle = query.toLowerCase();
  if (query && agentOn) {
    items.push({
      id: 'cmd:ask',
      section: 'Agent',
      icon: Sparkles,
      title: query,
      detail: 'Ask the agent',
      agent: true,
      run: () => {
        onClose();
        ask({ text: query, send: true });
      },
    });
  }
  for (const command of commands) {
    if (needle && !`${command.title} ${command.keywords}`.toLowerCase().includes(needle)) continue;
    if (command.icon === Sparkles && !agentOn) continue;
    items.push({ id: `cmd:${command.title}`, section: 'Go', icon: command.icon, title: command.title, meta: command.hint ? <Kbd>{command.hint}</Kbd> : undefined, run: command.run });
  }
  if (query) {
    items.push({ id: 'cmd:new-task', section: 'Go', icon: ListPlus, title: `Add task “${query}”`, run: () => setTaskTitle(query) });
  }
  for (const thread of mail.data?.items ?? []) {
    items.push({
      id: `thread:${thread.id}`,
      section: 'Mail',
      icon: Mail,
      title: thread.subject || '(no subject)',
      detail: `${displayName(thread.participants[0])} · ${thread.triage?.summary || thread.snippet}`,
      meta: (
        <>
          <AccountBadge accountId={thread.accountId} />
          <span>{listTime(thread.lastMessageAt)}</span>
        </>
      ),
      run: () => {
        navigate(routePath('mail', 'all', thread.id));
        onClose();
      },
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
      run: () => {
        navigate(routePath('tasks', task.taskListId));
        onClose();
      },
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
    <Dialog title="Command menu" onClose={onClose} bare size="lg" className="palette">
      <div className="palette__field">
        {busy ? <Spinner size={16} label="Searching" /> : <Search size={16} aria-hidden="true" />}
        <input
          className="palette__input"
          type="text"
          role="combobox"
          aria-label="Ask the agent, search, or run a command"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={items[activeIndex] ? `palette-${activeIndex}` : undefined}
          placeholder={agentOn ? 'Ask the agent, search, or jump to…' : 'Search or jump to…'}
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
        <Kbd>esc</Kbd>
      </div>

      <div className="palette__list" id="palette-list" role="listbox" aria-label="Results" ref={listRef}>
        {items.map((item, index) => {
          const Icon = item.icon;
          const header = item.section !== lastSection && item.section !== 'Go' && item.section !== 'Agent' ? item.section : null;
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
                className={clsx('palette__item', item.agent && 'palette__item--agent', index === activeIndex && 'is-active')}
                onMouseMove={() => setActive(index)}
                onClick={item.run}
              >
                <Icon size={15} aria-hidden="true" />
                <span className="palette__text">
                  <span className="palette__title">{item.title}</span>
                  {item.detail && <span className="palette__detail">{item.detail}</span>}
                </span>
                {item.meta && <span className="palette__meta">{item.meta}</span>}
                {index === activeIndex && !item.meta && <CornerDownLeft size={13} aria-hidden="true" />}
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
    </Dialog>
  );
}
