'use client';

import clsx from 'clsx';
import { format } from 'date-fns';
import {
  ArrowUp,
  CalendarDays,
  CircleCheck,
  CircleX,
  ExternalLink,
  FileText,
  ListChecks,
  Lock,
  Mail,
  MessageSquarePlus,
  PenLine,
  Sparkles,
  Square,
  User,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { needsAttention } from '@/lib/accounts';
import { api, ApiRequestError, isAbort, toApiError } from '@/lib/api';
import { parseDate, plural, relativeTime, safeHref } from '@/lib/format';
import { invalidate, routePath, useMediaQuery, useResource } from '@/lib/hooks';
import type { Action, AgentMessage, Id, SourceRef } from '@/lib/types';
import { ActionCard } from '../actions/ActionCard';
import { AccountBadge, AccountDot, useApp } from '../AppContext';
import { Markdown } from '../assistant/Markdown';
import { Button, ErrorState, IconButton, LoadingBlock, Notice, OrbitMark } from '../ui';

const STARTERS: Array<{ title: string; prompt: string }> = [
  {
    title: 'Summarize my unread mail',
    prompt: 'Summarize the unread mail across the selected accounts. Group it by account and link each thread.',
  },
  {
    title: 'What needs a reply today?',
    prompt: 'Which conversations are waiting on a reply from me? List them by urgency with the account each belongs to.',
  },
  {
    title: 'Find 30 minutes this week',
    prompt: 'Find three 30-minute slots this week that are free on all my availability calendars.',
  },
  {
    title: 'Turn starred mail into tasks',
    prompt: 'Look at my starred conversations and propose a task for each one that still needs action.',
  },
  {
    title: 'Who hasn’t replied to me?',
    prompt: 'Which threads did I send in the last two weeks that have had no reply? Suggest which to follow up on.',
  },
  {
    title: 'Suggest an inbox tidy-up',
    prompt: 'Suggest a bounded set of inbox conversations I could archive or label, and show me exactly which ones.',
  },
];

const SOURCE_ICON = {
  thread: Mail,
  message: Mail,
  draft: PenLine,
  event: CalendarDays,
  task: ListChecks,
  file: FileText,
  contact: User,
} as const;

interface Turn {
  text: string;
  accountIds: Id[];
  context: SourceRef[];
  startedAt: number;
}

/**
 * Reveals already-received text a few characters at a time once `started`.
 * Purely presentational: the full reply is in hand before the first character shows.
 */
function useTypewriter(text: string, animate: boolean, started: boolean, onDone: () => void): string {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  const doneRef = useRef(onDone);
  useEffect(() => {
    doneRef.current = onDone;
  });
  useEffect(() => {
    if (!animate || !started) return;
    const step = Math.max(2, Math.ceil(text.length / 80));
    let count = 0;
    const timer = setInterval(() => {
      count = Math.min(text.length, count + step);
      setShown(count);
      if (count >= text.length) {
        clearInterval(timer);
        doneRef.current();
      }
    }, 22);
    return () => clearInterval(timer);
  }, [text, animate, started]);
  return animate ? text.slice(0, shown) : text;
}

function SourceLink({ source, index }: { source: SourceRef; index: number }) {
  const { navigate } = useApp();
  const Icon = SOURCE_ICON[source.kind] ?? FileText;
  const external = safeHref(source.url);
  const inApp =
    source.kind === 'thread' || source.kind === 'message'
      ? source.kind === 'thread'
        ? routePath('inbox', 'all', source.id)
        : null
      : source.kind === 'task'
        ? '#/tasks'
        : source.kind === 'event'
          ? '#/calendar'
          : source.kind === 'draft'
            ? '#/inbox/drafts'
            : source.kind === 'file'
              ? '#/files'
              : null;
  const date = parseDate(source.occurredAt);
  const body = (
    <>
      <span className="source__no">{index + 1}</span>
      <Icon size={13} aria-hidden="true" />
      <span className="source__text">
        <span className="source__title">{source.title}</span>
        {source.snippet && <span className="source__snippet">{source.snippet}</span>}
      </span>
      <span className="source__meta">
        <AccountBadge accountId={source.accountId} />
        {date && <span>{format(date, 'MMM d')}</span>}
      </span>
    </>
  );
  // Threads open inside Orbitdesk; anything without an in-app view opens in Google.
  if (source.kind === 'thread' && inApp) {
    return (
      <li>
        <button type="button" className="source" onClick={() => navigate(inApp)}>
          {body}
        </button>
      </li>
    );
  }
  if (external) {
    return (
      <li>
        <a className="source" href={external} target="_blank" rel="noopener noreferrer">
          {body}
          <ExternalLink size={12} aria-hidden="true" className="source__ext" />
        </a>
      </li>
    );
  }
  if (inApp) {
    return (
      <li>
        <button type="button" className="source" onClick={() => navigate(inApp)}>
          {body}
        </button>
      </li>
    );
  }
  return (
    <li>
      <span className="source source--static">{body}</span>
    </li>
  );
}

function AssistantReply({
  message,
  animate,
  onActionChange,
  onRevealed,
}: {
  message: AgentMessage;
  animate: boolean;
  onActionChange: (action: Action) => void;
  onRevealed: () => void;
}) {
  const { account } = useApp();
  const toolCount = message.tools.length;
  const [toolsShown, setToolsShown] = useState(animate ? 0 : toolCount);
  const [textDone, setTextDone] = useState(!animate);
  const toolsDone = toolsShown >= toolCount;

  useEffect(() => {
    if (!animate || toolsDone) return;
    const timer = setTimeout(() => setToolsShown((n) => n + 1), 260);
    return () => clearTimeout(timer);
  }, [animate, toolsDone, toolsShown]);

  const text = useTypewriter(message.text, animate, toolsDone, () => {
    setTextDone(true);
    onRevealed();
  });
  const totalMs = message.tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  const failedTools = message.tools.filter((tool) => tool.status === 'error').length;

  return (
    <article className="turn turn--assistant" aria-label="Assistant reply">
      <header className="turn__who">
        <OrbitMark size={16} />
        <span>Orbitdesk</span>
        {message.model && <span className="turn__model">{message.model}</span>}
        <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
      </header>

      {toolCount > 0 && (
        <details className="trace" open={animate || failedTools > 0}>
          <summary>
            <Wrench size={13} aria-hidden="true" />
            <span>
              {plural(toolCount, 'tool call')}
              {totalMs > 0 ? ` · ${(totalMs / 1000).toFixed(1)} s` : ''}
              {failedTools > 0 ? ` · ${failedTools} failed` : ''}
            </span>
          </summary>
          <ol className="trace__list">
            {message.tools.slice(0, toolsShown).map((tool) => (
              <li key={tool.id} className={clsx('trace__item', tool.status === 'error' && 'trace__item--error')}>
                {tool.status === 'ok' ? <CircleCheck size={14} aria-label="Succeeded" /> : <CircleX size={14} aria-label="Failed" />}
                <span className="trace__body">
                  <span className="trace__label">{tool.label}</span>
                  {tool.detail && <span className="trace__detail">{tool.detail}</span>}
                </span>
                <span className="trace__meta">
                  {tool.accountId && (
                    <span className="trace__acct">
                      <AccountDot account={account(tool.accountId)} /> {account(tool.accountId)?.label ?? 'account'}
                    </span>
                  )}
                  <code>{tool.name}</code>
                  {tool.durationMs !== null && <span>{tool.durationMs} ms</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}

      {toolsDone && (
        <div className={clsx('turn__text', animate && !textDone && 'is-typing')}>
          {text ? <Markdown text={text} /> : textDone && <p className="turn__empty">The assistant returned no text.</p>}
        </div>
      )}

      {textDone && message.sources.length > 0 && (
        <section className="sources" aria-label="Sources">
          <h3 className="sources__title">Sources</h3>
          <ol className="sources__list">
            {message.sources.map((source, index) => (
              <SourceLink key={`${source.kind}-${source.id}`} source={source} index={index} />
            ))}
          </ol>
        </section>
      )}

      {textDone && message.actions.length > 0 && (
        <section className="turn__actions" aria-label="Proposed actions">
          <h3 className="sources__title">
            {message.actions.length === 1 ? 'Proposed action' : `${message.actions.length} proposed actions`} — nothing happens until you
            approve
          </h3>
          {message.actions.map((action) => (
            <ActionCard key={action.id} action={action} onChange={onActionChange} defaultOpen />
          ))}
        </section>
      )}
    </article>
  );
}

function Working({ turn, onStop }: { turn: Turn; onStop: () => void }) {
  const { account } = useApp();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - turn.startedAt) / 1000)), 500);
    return () => clearInterval(timer);
  }, [turn.startedAt]);
  return (
    <article className="turn turn--assistant turn--working" role="status" aria-live="polite">
      <header className="turn__who">
        <OrbitMark size={16} className="is-spinning" />
        <span>Orbitdesk is working</span>
        <span className="turn__model">{seconds}s</span>
      </header>
      <div className="working">
        <div className="working__bar" aria-hidden="true" />
        <p className="working__text">
          Reading{' '}
          {turn.accountIds.map((id, index) => (
            <span key={id}>
              {index > 0 && ', '}
              <span className="working__acct">
                <AccountDot account={account(id)} /> {account(id)?.label ?? 'account'}
              </span>
            </span>
          ))}{' '}
          with the tools it has been given.{' '}
          {seconds >= 10
            ? 'Calls to Google and the model can take a little while — the steps it took will be listed with the answer.'
            : 'The steps it takes are listed with the answer.'}
        </p>
        <Button size="sm" variant="ghost" icon={<Square size={12} />} onClick={onStop}>
          Stop waiting
        </Button>
      </div>
    </article>
  );
}

export function AssistantView({ conversationId }: { conversationId?: string }) {
  const { boot, scope, navigate, assistantSeed, setAssistantSeed, refreshBoot } = useApp();
  const agent = boot.capabilities.agent;
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');

  const conversations = useResource('agent:conversations', (signal) => api.agentMessages(null, { signal }));
  const [convo, setConvo] = useState<{ id: Id | null; messages: AgentMessage[] }>({ id: null, messages: [] });
  const [load, setLoad] = useState<{ busy: boolean; error: ApiRequestError | null }>({ busy: false, error: null });
  const [reloadTick, setReloadTick] = useState(0);
  const [input, setInput] = useState('');
  const [attached, setAttached] = useState<SourceRef[]>([]);
  const [picked, setPicked] = useState<Id[] | null>(null);
  const [pending, setPending] = useState<Turn | null>(null);
  const [failed, setFailed] = useState<{ turn: Turn; error: ApiRequestError | null; stopped: boolean } | null>(null);
  const [freshId, setFreshId] = useState<Id | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const loadedRef = useRef<Id | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const seedRef = useRef<object | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const eligible = boot.connections.filter((c) => c.assistantAccess);
  const defaultPicked = eligible
    .filter((c) => c.status !== 'reconnect_required' && (scope.length === 0 || scope.includes(c.id)))
    .map((c) => c.id);
  const selected = (picked ?? defaultPicked).filter((id) => eligible.some((c) => c.id === id));

  // Load the conversation named in the URL, unless it is the one already on screen.
  useEffect(() => {
    const target = conversationId ?? null;
    if (target === loadedRef.current) return;
    if (target === null) {
      loadedRef.current = null;
      setConvo({ id: null, messages: [] });
      setLoad({ busy: false, error: null });
      setFailed(null);
      return;
    }
    const ctrl = new AbortController();
    setLoad({ busy: true, error: null });
    api.agentMessages(target, { signal: ctrl.signal }).then(
      (result) => {
        loadedRef.current = target;
        setConvo({ id: target, messages: result.messages });
        setLoad({ busy: false, error: null });
        setFailed(null);
      },
      (err) => {
        if (isAbort(err)) return;
        setLoad({ busy: false, error: toApiError(err) });
      },
    );
    return () => ctrl.abort();
  }, [conversationId, reloadTick]);

  const scrollToEnd = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  useEffect(scrollToEnd, [convo.messages.length, pending, failed]);

  const send = async (rawText: string, context: SourceRef[]) => {
    const text = rawText.trim();
    if (!text || pending) return;
    if (!agent.available) return;
    if (selected.length === 0) {
      setProblem('Select at least one account for the assistant to read.');
      return;
    }
    const turn: Turn = { text, accountIds: selected, context, startedAt: Date.now() };
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProblem(null);
    setFailed(null);
    setPending(turn);
    setInput('');
    setAttached([]);
    try {
      const result = await api.agentSend(
        { conversationId: convo.id, text, accountIds: turn.accountIds, context: context.length ? context : undefined },
        { signal: ctrl.signal },
      );
      loadedRef.current = result.conversation.id;
      setConvo((current) => ({
        id: result.conversation.id,
        messages: [...(current.id === result.conversation.id || current.id === null ? current.messages : []), result.userMessage, result.reply],
      }));
      setFreshId(result.reply.id);
      conversations.reload();
      if (conversationId !== result.conversation.id) navigate(routePath('assistant', result.conversation.id), true);
      if (result.reply.actions.length) {
        refreshBoot();
        invalidate('actions', 'drafts');
      }
    } catch (err) {
      if (isAbort(err)) setFailed({ turn, error: null, stopped: true });
      else setFailed({ turn, error: toApiError(err), stopped: false });
    } finally {
      abortRef.current = null;
      setPending(null);
    }
  };

  // A question handed over from another view (for example "Summarize this conversation").
  useEffect(() => {
    if (!assistantSeed || seedRef.current === assistantSeed) return;
    seedRef.current = assistantSeed;
    const seed = assistantSeed;
    setAssistantSeed(null);
    if (seed.send && seed.text) {
      void send(seed.text, seed.context ?? []);
    } else {
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
    }
  };

  const updateAction = (messageId: Id, action: Action) => {
    setConvo((current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId
          ? { ...message, actions: message.actions.map((item) => (item.id === action.id ? action : item)) }
          : message,
      ),
    }));
  };

  const toggleAccount = (id: Id) => {
    setPicked(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
    setProblem(null);
  };

  const recent = conversations.data?.conversations ?? [];
  const activeTitle = recent.find((c) => c.id === convo.id)?.title;
  const emptyConversation = convo.messages.length === 0 && !pending && !failed && !load.busy && !load.error;

  return (
    <div className="assistant">
      <aside className="assistant__side" aria-label="Conversations">
        <a className="btn btn--outline assistant__new" href="#/assistant">
          <MessageSquarePlus size={15} aria-hidden="true" />
          <span>New conversation</span>
        </a>
        <p className="kicker assistant__side-title">Recent</p>
        {conversations.loading && <LoadingBlock label="Loading conversations" />}
        {conversations.error && !conversations.data && <ErrorState compact error={conversations.error} onRetry={conversations.reload} />}
        {conversations.data && recent.length === 0 && <p className="assistant__none">Your conversations will be listed here.</p>}
        <ul className="assistant__convos">
          {recent.map((item) => (
            <li key={item.id}>
              <a
                href={routePath('assistant', item.id)}
                className={clsx('assistant__convo', item.id === convo.id && 'is-active')}
                aria-current={item.id === convo.id ? 'page' : undefined}
              >
                <span className="assistant__convo-title">{item.title || 'Untitled'}</span>
                <span className="assistant__convo-time">{relativeTime(item.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <section className="assistant__main" aria-label="Assistant">
        <header className="assistant__head">
          <div>
            <p className="kicker">
              Assistant{boot.capabilities.agentModel ? ` · ${boot.capabilities.agentModel}` : ''}
            </p>
            <h1 className="assistant__title">{activeTitle ?? 'Ask about your mail, calendar and tasks'}</h1>
          </div>
          <div className="scopechips" role="group" aria-label="Accounts the assistant may read for this question">
            <span className="scopechips__label">May read</span>
            {boot.connections.map((connection) => {
              const allowed = connection.assistantAccess;
              const on = selected.includes(connection.id);
              return (
                <button
                  key={connection.id}
                  type="button"
                  className={clsx('scopechip', on && 'is-on', !allowed && 'is-locked')}
                  aria-pressed={on}
                  disabled={!allowed || pending !== null}
                  title={
                    allowed
                      ? `${connection.email}${needsAttention(connection) ? ' — needs attention, reads may fail' : ''}`
                      : `${connection.email} — assistant access is off for this account. Change it in Connections.`
                  }
                  onClick={() => toggleAccount(connection.id)}
                >
                  {allowed ? <AccountDot account={connection} /> : <Lock size={11} aria-hidden="true" />}
                  <span>{connection.label}</span>
                </button>
              );
            })}
            {boot.connections.length === 0 && <span className="scopechips__none">No accounts connected</span>}
          </div>
        </header>

        <div className="assistant__scroll" ref={scrollRef}>
          {!agent.available && (
            <Notice tone="warn" action={<a className="link-btn" href="#/settings/data">System status</a>}>
              <strong>The assistant is not available.</strong> {agent.reason ?? 'No model provider is configured on this deployment.'}
            </Notice>
          )}
          {load.busy && <LoadingBlock label="Loading the conversation" />}
          {load.error && (
            <ErrorState
              error={load.error}
              onRetry={() => {
                loadedRef.current = null;
                setReloadTick((n) => n + 1);
              }}
            />
          )}

          {emptyConversation && (
            <div className="starters">
              <OrbitMark size={34} className="starters__mark" />
              <h2 className="starters__title">What would you like to know?</h2>
              <p className="starters__text">
                The assistant answers from the accounts selected above and shows the threads and events it used. It can
                prepare drafts, events and tasks — each one waits for your approval.
              </p>
              <div className="starters__grid">
                {STARTERS.map((starter) => (
                  <button
                    key={starter.title}
                    type="button"
                    className="starter"
                    disabled={!agent.available || selected.length === 0}
                    onClick={() => void send(starter.prompt, [])}
                  >
                    <Sparkles size={14} aria-hidden="true" />
                    <span className="starter__title">{starter.title}</span>
                    <span className="starter__prompt">{starter.prompt}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {convo.messages.map((message) =>
            message.role === 'user' ? (
              <article key={message.id} className="turn turn--user" aria-label="Your message">
                <header className="turn__who">
                  <span>You</span>
                  <time dateTime={message.createdAt}>{relativeTime(message.createdAt)}</time>
                  <span className="turn__scope">
                    {message.accountIds.map((id) => (
                      <AccountBadge key={id} accountId={id} />
                    ))}
                  </span>
                </header>
                <p className="turn__ask">{message.text}</p>
                {message.sources.length > 0 && (
                  <p className="turn__attached">
                    About: {message.sources.map((source) => source.title).join(' · ')}
                  </p>
                )}
              </article>
            ) : (
              <AssistantReply
                key={message.id}
                message={message}
                animate={message.id === freshId && !reducedMotion}
                onActionChange={(action) => updateAction(message.id, action)}
                onRevealed={scrollToEnd}
              />
            ),
          )}

          {(pending || failed) && (
            <article className="turn turn--user" aria-label="Your message">
              <header className="turn__who">
                <span>You</span>
                <span className="turn__scope">
                  {(pending ?? failed!.turn).accountIds.map((id) => (
                    <AccountBadge key={id} accountId={id} />
                  ))}
                </span>
              </header>
              <p className="turn__ask">{(pending ?? failed!.turn).text}</p>
              {(pending ?? failed!.turn).context.length > 0 && (
                <p className="turn__attached">
                  About: {(pending ?? failed!.turn).context.map((source) => source.title).join(' · ')}
                </p>
              )}
            </article>
          )}
          {pending && <Working turn={pending} onStop={() => abortRef.current?.abort()} />}
          {failed && !pending && (
            <article className="turn turn--assistant turn--failed" role="alert">
              {failed.stopped ? (
                <Notice tone="info">
                  Stopped waiting. If the assistant finishes anyway, its reply is saved and appears when this conversation is
                  reloaded.
                </Notice>
              ) : (
                failed.error && <ErrorState compact error={failed.error} />
              )}
              <div className="turn__retry">
                <Button size="sm" variant="primary" onClick={() => void send(failed.turn.text, failed.turn.context)}>
                  Ask again
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setInput(failed.turn.text);
                    setAttached(failed.turn.context);
                    setFailed(null);
                    inputRef.current?.focus();
                  }}
                >
                  Edit the question
                </Button>
                {convo.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setFailed(null);
                      loadedRef.current = null;
                      setReloadTick((n) => n + 1);
                    }}
                  >
                    Reload conversation
                  </Button>
                )}
              </div>
            </article>
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
            <ul className="askbox__ctx" aria-label="Attached context">
              {attached.map((source) => (
                <li key={`${source.kind}-${source.id}`} className="chip">
                  <Mail size={12} aria-hidden="true" />
                  <span className="chip__text">{source.title}</span>
                  <button
                    type="button"
                    className="chip__x"
                    aria-label={`Remove ${source.title}`}
                    onClick={() => setAttached(attached.filter((item) => item !== source))}
                  >
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem && (
            <p className="askbox__problem" role="alert">
              {problem}
            </p>
          )}
          <div className="askbox__row">
            <textarea
              ref={inputRef}
              className="askbox__input"
              rows={2}
              aria-label="Message the assistant"
              placeholder={agent.available ? 'Ask a question, or describe what you want prepared…' : 'The assistant is not configured on this deployment'}
              value={input}
              disabled={!agent.available}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
            />
            <IconButton
              type="submit"
              label="Send"
              className="askbox__send"
              disabled={!agent.available || !input.trim() || pending !== null}
            >
              <ArrowUp size={18} />
            </IconButton>
          </div>
          <p className="askbox__note">
            Reads {selected.length ? plural(selected.length, 'selected account') : 'no accounts'}. Sending, inviting, cancelling and
            deleting always wait for your approval. <kbd className="kbd">Enter</kbd> sends, <kbd className="kbd">Shift Enter</kbd> adds a line.
          </p>
        </form>
      </section>
    </div>
  );
}
