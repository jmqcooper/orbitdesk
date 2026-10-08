'use client';

import clsx from 'clsx';
import { format } from 'date-fns';
import { ArrowUp, CalendarDays, Check, FileText, History, ListChecks, Mail, PenLine, Plus, Sparkles, Square, User, Video, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, ApiRequestError, isAbort, toApiError } from '@/lib/api';
import { clockTime, eventTimeLabel, parseDate, plural, relativeTime, safeHref } from '@/lib/format';
import { invalidate, routePath, useResource } from '@/lib/hooks';
import type { Action, AgentMessage, Id, SourceRef, Task } from '@/lib/types';
import { ActionCard } from '../actions/ActionCard';
import { AccountDot, useApp } from '../AppContext';
import { Markdown } from '../assistant/Markdown';
import { Button, ErrorState, IconButton, Menu, Spinner } from '../ui';

const STARTERS: Array<{ title: string; prompt: string }> = [
  { title: 'What needs me today?', prompt: 'What needs my attention today? Use my inbox lanes, calendar and tasks. Be brief and rank by urgency.' },
  { title: 'Find 30 minutes this week', prompt: 'Find three 30-minute slots this week that are free on all my availability calendars.' },
  { title: 'Who hasn’t replied to me?', prompt: 'Which conversations am I still waiting on? Suggest which deserve a follow-up and draft those follow-ups.' },
  { title: 'Clear out the noise', prompt: 'Look at the Other lane of my inbox and propose archiving everything that is safe to archive, one account at a time.' },
];

const SOURCE_ICON = { thread: Mail, message: Mail, draft: PenLine, event: CalendarDays, task: ListChecks, file: FileText, contact: User } as const;

interface Turn {
  text: string;
  accountIds: Id[];
  context: SourceRef[];
  startedAt: number;
}

function Sources({ sources }: { sources: SourceRef[] }) {
  const { navigate } = useApp();
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, 4);
  return (
    <ul className="sources" aria-label="Sources">
      {shown.map((source) => {
        const Icon = SOURCE_ICON[source.kind] ?? FileText;
        const external = safeHref(source.url);
        const inApp = source.kind === 'thread' ? routePath('mail', 'all', source.id) : source.kind === 'task' ? '#/tasks' : source.kind === 'event' ? '#/calendar' : source.kind === 'draft' ? '#/mail/drafts' : source.kind === 'file' ? '#/files' : null;
        const body = (
          <>
            <Icon size={12} aria-hidden="true" />
            <span className="source__title">{source.title}</span>
          </>
        );
        return (
          <li key={`${source.kind}-${source.id}`}>
            {inApp ? (
              <button type="button" className="source" onClick={() => navigate(inApp)}>
                {body}
              </button>
            ) : external ? (
              <a className="source" href={external} target="_blank" rel="noopener noreferrer">
                {body}
              </a>
            ) : (
              <span className="source">{body}</span>
            )}
          </li>
        );
      })}
      {sources.length > shown.length && (
        <li>
          <button type="button" className="source source--more" onClick={() => setAll(true)}>
            +{sources.length - shown.length}
          </button>
        </li>
      )}
    </ul>
  );
}

function Reply({ message, onActionChange }: { message: AgentMessage; onActionChange: (action: Action) => void }) {
  const failed = message.tools.filter((tool) => tool.status === 'error').length;
  return (
    <article className="turn turn--agent" aria-label="Agent">
      {message.tools.length > 0 && (
        <details className="trace" open={failed > 0}>
          <summary>
            <Check size={12} aria-hidden="true" />
            {plural(message.tools.length, 'step')}
            {failed > 0 ? ` · ${failed} failed` : ''}
          </summary>
          <ol className="trace__list">
            {message.tools.map((tool) => (
              <li key={tool.id} className={clsx(tool.status === 'error' && 'is-error')}>
                <code>{tool.name}</code>
                <span>{tool.detail}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      <div className="turn__text md">{message.text ? <Markdown text={message.text} /> : <p className="muted">No answer came back.</p>}</div>
      {message.sources.length > 0 && <Sources sources={message.sources} />}
      {message.actions.map((action) => (
        <ActionCard key={action.id} action={action} onChange={onActionChange} defaultOpen />
      ))}
    </article>
  );
}

function Working({ turn, onStop }: { turn: Turn; onStop: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - turn.startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [turn.startedAt]);
  return (
    <div className="working" role="status" aria-live="polite">
      <Sparkles size={13} className="is-pulsing" aria-hidden="true" />
      <span>Working{seconds >= 3 ? ` · ${seconds}s` : '…'}</span>
      <button type="button" className="working__stop" onClick={onStop} aria-label="Stop waiting" title="Stop waiting">
        <Square size={10} fill="currentColor" />
      </button>
    </div>
  );
}

/** Today at a glance: the agent's home state before a conversation starts. */
function Day() {
  const { scopeParam, scopeKey, account, navigate, reportError, refreshBoot, boot } = useApp();
  const brief = useResource(`brief:${scopeKey}`, (signal) => api.brief({ accountId: scopeParam }, { signal }), { refreshMs: 300_000 });
  const [writing, setWriting] = useState(false);
  const [done, setDone] = useState<Set<Id>>(new Set());

  const write = async () => {
    setWriting(true);
    try {
      const next = await api.brief({ accountId: scopeParam, refresh: true });
      brief.mutate(() => next);
    } catch (err) {
      reportError(err, 'Could not write the brief');
    } finally {
      setWriting(false);
    }
  };

  const complete = async (task: Task) => {
    setDone((set) => new Set(set).add(task.id));
    try {
      await api.updateTask(task.id, { completed: true });
      refreshBoot();
      invalidate('tasks');
    } catch (err) {
      setDone((set) => {
        const next = new Set(set);
        next.delete(task.id);
        return next;
      });
      reportError(err, 'Could not complete the task');
    }
  };

  const data = brief.data;
  const now = Date.now();
  const meetings = (data?.meetings ?? []).filter((event) => event.allDay || (parseDate(event.end)?.getTime() ?? 0) > now);

  return (
    <section className="day" aria-label="Today">
      <h2 className="agent__h">
        {format(new Date(), 'EEEE, MMM d')}
        {boot.capabilities.agent.available && (
          <button type="button" className="agent__hlink" disabled={writing} onClick={write}>
            {writing ? 'Writing…' : data?.summary ? 'Rewrite brief' : 'Brief me'}
          </button>
        )}
      </h2>
      {brief.loading && <p className="day__empty">Looking at today…</p>}
      {brief.error && !data && <p className="day__empty">Today could not be loaded. {brief.error.message}</p>}
      {data?.summary && <p className="day__brief">{data.summary}</p>}
      {data && (
        <ul className="day__list">
          {meetings.map((event) => (
            <li key={event.id}>
              <button type="button" className="day__item" onClick={() => navigate('#/calendar')}>
                <span className="day__time num" title={eventTimeLabel(event)}>
                  {event.allDay ? 'All day' : clockTime(parseDate(event.start) ?? new Date())}
                </span>
                <span className="day__title">{event.title || '(no title)'}</span>
                {event.meetUrl && <Video size={12} className="muted" aria-label="Has a Meet link" />}
                <AccountDot account={account(event.accountId)} size={7} />
              </button>
            </li>
          ))}
          {data.tasks
            .filter((task) => !done.has(task.id))
            .map((task) => (
              <li key={task.id} className="day__task">
                <button type="button" role="checkbox" aria-checked="false" aria-label={`Complete ${task.title}`} className="check-btn" onClick={() => complete(task)} />
                <button type="button" className="day__item" onClick={() => navigate(routePath('tasks'))}>
                  <span className="day__title">{task.title}</span>
                  <AccountDot account={account(task.accountId)} size={7} />
                </button>
              </li>
            ))}
          {meetings.length === 0 && data.tasks.length === 0 && <li className="day__empty">Nothing left on the calendar and no tasks due.</li>}
        </ul>
      )}
    </section>
  );
}

export function AgentPanel() {
  const { boot, scope, assistantSeed, setAssistantSeed, setAgentOpen, refreshBoot } = useApp();
  const agent = boot.capabilities.agent;

  const conversations = useResource('agent:conversations', (signal) => api.agentMessages(null, { signal }));
  const waiting = useResource('actions:pending', (signal) => api.actions({ status: 'pending', limit: 20 }, { signal }), { refreshMs: 60_000 });
  const scheduled = useResource('actions:scheduled', (signal) => api.actions({ status: 'scheduled', limit: 20 }, { signal }), { refreshMs: 60_000 });
  const [convo, setConvo] = useState<{ id: Id | null; messages: AgentMessage[] }>({ id: null, messages: [] });
  const [load, setLoad] = useState<{ busy: boolean; error: ApiRequestError | null }>({ busy: false, error: null });
  const [input, setInput] = useState('');
  const [attached, setAttached] = useState<SourceRef[]>([]);
  const [pending, setPending] = useState<Turn | null>(null);
  const [failed, setFailed] = useState<{ turn: Turn; error: ApiRequestError | null } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const seedRef = useRef<object | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The agent reads every account that allows it, narrowed by the account filter.
  const selected = boot.connections
    .filter((c) => c.assistantAccess && c.status !== 'reconnect_required' && (scope.length === 0 || scope.includes(c.id)))
    .map((c) => c.id);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && (convo.messages.length || pending || failed)) el.scrollTop = el.scrollHeight;
  }, [convo.messages.length, pending, failed]);

  const openConversation = (id: Id) => {
    setLoad({ busy: true, error: null });
    setFailed(null);
    api.agentMessages(id).then(
      (result) => {
        setConvo({ id, messages: result.messages });
        setLoad({ busy: false, error: null });
      },
      (err) => setLoad({ busy: false, error: toApiError(err) }),
    );
  };

  const newChat = () => {
    abortRef.current?.abort();
    setConvo({ id: null, messages: [] });
    setFailed(null);
    setLoad({ busy: false, error: null });
    inputRef.current?.focus();
  };

  const send = async (rawText: string, context: SourceRef[]) => {
    const text = rawText.trim();
    if (!text || pending || !agent.available || selected.length === 0) return;
    const turn: Turn = { text, accountIds: selected, context, startedAt: Date.now() };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setFailed(null);
    setPending(turn);
    setInput('');
    setAttached([]);
    try {
      const result = await api.agentSend({ conversationId: convo.id, text, accountIds: turn.accountIds, context: context.length ? context : undefined }, { signal: ctrl.signal });
      setConvo((current) => ({
        id: result.conversation.id,
        messages: [...(current.id === result.conversation.id || current.id === null ? current.messages : []), result.userMessage, result.reply],
      }));
      conversations.reload();
      // The agent may have written drafts or prepared changes along the way.
      refreshBoot();
      invalidate('drafts', 'threads', 'thread:');
      if (result.reply.actions.length) waiting.reload();
    } catch (err) {
      setFailed({ turn, error: isAbort(err) ? null : toApiError(err) });
    } finally {
      abortRef.current = null;
      setPending(null);
    }
  };

  // A question handed over from elsewhere (a conversation, the command menu).
  useEffect(() => {
    if (!assistantSeed || seedRef.current === assistantSeed) return;
    seedRef.current = assistantSeed;
    const seed = assistantSeed;
    setAssistantSeed(null);
    if (seed.send && seed.text) void send(seed.text, seed.context ?? []);
    else {
      setInput(seed.text ?? '');
      setAttached(seed.context ?? []);
      inputRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantSeed]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(input, attached);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setAgentOpen(false);
    }
  };

  const updateAction = (messageId: Id, action: Action) => {
    setConvo((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId ? { ...message, actions: message.actions.map((item) => (item.id === action.id ? action : item)) } : message,
      ),
    }));
    waiting.reload();
    scheduled.reload();
  };

  const recent = conversations.data?.conversations ?? [];
  const home = convo.messages.length === 0 && !pending && !failed && !load.busy && !load.error;
  // Proposals from the open conversation are shown with their answer, not twice.
  const inConversation = new Set(convo.messages.flatMap((message) => message.actions.map((action) => action.id)));
  const needsOk = (waiting.data?.items ?? []).filter((action) => !inConversation.has(action.id));
  const queue = scheduled.data?.items ?? [];
  const settle = (list: typeof waiting) => (action: Action) => {
    list.mutate((current) => ({ ...current, items: current.items.map((item) => (item.id === action.id ? action : item)) }));
    waiting.reload();
    scheduled.reload();
  };

  return (
    <aside className="agent" aria-label="Agent">
      <header className="bar">
        <Sparkles size={15} className="agent__spark" aria-hidden="true" />
        <span className="bar__title">Agent</span>
        <span className="bar__gap" />
        {!home && (
          <IconButton label="New chat" onClick={newChat}>
            <Plus size={16} />
          </IconButton>
        )}
        {recent.length > 0 && (
          <Menu
            label="Earlier chats"
            button={<History size={16} />}
            items={recent.slice(0, 12).map((item) => ({ key: item.id, label: item.title || 'Untitled', hint: relativeTime(item.updatedAt).replace(' ago', ''), checked: item.id === convo.id ? true : undefined, onSelect: () => openConversation(item.id) }))}
          />
        )}
        <IconButton label="Close  ·  ⌘J" onClick={() => setAgentOpen(false)}>
          <X size={16} />
        </IconButton>
      </header>

      <div className="scroll agent__scroll" ref={scrollRef}>
        {!agent.available && (
          <div className="notice notice--warn" role="status">
            <span className="notice__text">
              <strong>The agent is off.</strong> {agent.reason ?? 'No model is configured on this deployment.'}
            </span>
          </div>
        )}

        {home && <Day />}

        {needsOk.length > 0 && (
          <section aria-label="Needs your OK">
            <h2 className="agent__h">Needs your OK</h2>
            {needsOk.map((action) => (
              <ActionCard key={action.id} action={action} onChange={settle(waiting)} defaultOpen={needsOk.length <= 2} />
            ))}
          </section>
        )}
        {home && queue.length > 0 && (
          <section aria-label="Scheduled">
            <h2 className="agent__h">Scheduled</h2>
            {queue.map((action) => (
              <ActionCard key={action.id} action={action} onChange={settle(scheduled)} defaultOpen={false} />
            ))}
          </section>
        )}

        {home && agent.available && (
          <ul className="starters">
            {STARTERS.map((starter) => (
              <li key={starter.title}>
                <button type="button" className="starter" disabled={selected.length === 0} onClick={() => void send(starter.prompt, [])}>
                  {starter.title}
                </button>
              </li>
            ))}
          </ul>
        )}

        {load.busy && (
          <p className="working">
            <Spinner size={13} /> Opening
          </p>
        )}
        {load.error && <ErrorState compact error={load.error} />}

        {convo.messages.map((message) =>
          message.role === 'user' ? (
            <article key={message.id} className="turn turn--user" aria-label="You">
              {message.sources.length > 0 && <span className="turn__about">{message.sources.map((source) => source.title).join(' · ')}</span>}
              <p>{message.text}</p>
            </article>
          ) : (
            <Reply key={message.id} message={message} onActionChange={(action) => updateAction(message.id, action)} />
          ),
        )}

        {(pending || failed) && (
          <article className="turn turn--user" aria-label="You">
            {(pending ?? failed!.turn).context.length > 0 && <span className="turn__about">{(pending ?? failed!.turn).context.map((source) => source.title).join(' · ')}</span>}
            <p>{(pending ?? failed!.turn).text}</p>
          </article>
        )}
        {pending && <Working turn={pending} onStop={() => abortRef.current?.abort()} />}
        {failed && !pending && (
          <div className="turn turn--agent" role="alert">
            {failed.error ? <ErrorState compact error={failed.error} /> : <p className="muted">Stopped waiting. If the agent finishes, its answer is saved in this chat.</p>}
            <Button size="sm" onClick={() => void send(failed.turn.text, failed.turn.context)}>
              Try again
            </Button>
          </div>
        )}
      </div>

      <form
        className="askbox"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input, attached);
        }}
      >
        {attached.length > 0 && (
          <ul className="askbox__ctx" aria-label="About">
            {attached.map((source) => (
              <li key={`${source.kind}-${source.id}`} className="chip">
                <Mail size={11} aria-hidden="true" />
                <span className="chip__text">{source.title}</span>
                <button type="button" className="chip__x" aria-label={`Remove ${source.title}`} onClick={() => setAttached(attached.filter((item) => item !== source))}>
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="askbox__row">
          <textarea
            ref={inputRef}
            className="askbox__input"
            rows={1}
            aria-label="Ask or tell the agent"
            placeholder={!agent.available ? 'The agent is off' : selected.length === 0 ? 'No account lets the agent read it' : attached.length ? 'Ask about this conversation' : 'Ask, or tell the agent what to do'}
            value={input}
            disabled={!agent.available || selected.length === 0}
            onChange={(event) => {
              setInput(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="askbox__send" aria-label="Send" disabled={!agent.available || !input.trim() || pending !== null}>
            <ArrowUp size={15} />
          </button>
        </div>
        <p className="askbox__note">
          Reads {selected.length === boot.connections.length ? 'all' : selected.length} {selected.length === 1 ? 'account' : 'accounts'} · never sends without you
        </p>
      </form>
    </aside>
  );
}
