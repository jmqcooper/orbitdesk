import type {
  AccountDeleteRequest,
  AccountDeleteResponse,
  Action,
  ActionApproveRequest,
  ActionListQuery,
  ActionRejectRequest,
  ActivityEntry,
  ActivityListQuery,
  AgentMessagesResponse,
  AgentSendRequest,
  AgentSendResponse,
  Automation,
  AutomationCreateRequest,
  AutomationUpdateRequest,
  AvailabilityRequest,
  AvailabilityResult,
  Bootstrap,
  Brief,
  CalendarEvent,
  Connection,
  ConnectionDeleted,
  ConnectionUpdateRequest,
  Contact,
  ContactListQuery,
  Deleted,
  Draft,
  DraftCreateRequest,
  DraftSendRequest,
  DraftSendResponse,
  DraftUpdateRequest,
  DriveFile,
  EventCreateRequest,
  EventDeleteQuery,
  EventListQuery,
  EventRsvpRequest,
  EventUpdateRequest,
  FileActionRequest,
  FileActionResult,
  FileListQuery,
  Health,
  Id,
  ListResult,
  LogoutResponse,
  ResourceKind,
  Session,
  SessionResponse,
  SettingsResponse,
  SettingsUpdateRequest,
  Task,
  TaskCreateRequest,
  TaskList,
  TaskListCreateRequest,
  TaskListQuery,
  TaskListUpdateRequest,
  TaskUpdateRequest,
  ThreadActionRequest,
  ThreadDetail,
  ThreadListQuery,
  ThreadSummary,
} from './types';

/** Fired on `window` when any endpoint other than /api/session answers 401. */
export const SIGNED_OUT_EVENT = 'orbitdesk:signed-out';

/**
 * A failed request. `code` is the contract's ErrorCode, or one of the
 * client-side codes `network`, `timeout`, `not_implemented`.
 */
export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly path: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, status: number, path: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.path = path;
    this.details = details;
  }
}

export function toApiError(err: unknown): ApiRequestError {
  if (err instanceof ApiRequestError) return err;
  const message = err instanceof Error && err.message ? err.message : 'Something went wrong.';
  return new ApiRequestError('internal', message, 0, '');
}

export function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

type QueryValue = string | number | boolean | null | undefined | string[];
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== '') params.append(key, item);
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(method: Method, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? 30_000);
  const forwardAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener('abort', forwardAbort, { once: true });
  }

  const hasBody = method !== 'GET' && method !== 'DELETE';
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: hasBody
        ? { Accept: 'application/json', 'Content-Type': 'application/json' }
        : { Accept: 'application/json' },
      body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch (err) {
    if (opts.signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (timedOut) {
      throw new ApiRequestError('timeout', 'The server took too long to respond. Try again.', 0, path);
    }
    throw new ApiRequestError(
      'network',
      'Could not reach the Orbitdesk server. Check your connection and try again.',
      0,
      path,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', forwardAbort);
  }

  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (isRecord(payload) && isRecord(payload.error)) {
    const raw = payload.error;
    const code = typeof raw.code === 'string' ? raw.code.toLowerCase() : 'internal';
    const message =
      typeof raw.message === 'string' && raw.message ? raw.message : `The request failed (HTTP ${res.status}).`;
    if (res.status === 401 && path !== '/api/session' && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
    }
    throw new ApiRequestError(code, message, res.status, path, isRecord(raw.details) ? raw.details : undefined);
  }

  if (isRecord(payload) && 'data' in payload) return payload.data as T;

  if (res.status === 401 && path !== '/api/session' && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SIGNED_OUT_EVENT));
    throw new ApiRequestError('unauthenticated', 'Your session has ended. Sign in again.', 401, path);
  }
  if (res.status === 404 || res.status === 405) {
    throw new ApiRequestError(
      'not_implemented',
      `The server has no handler for ${method} ${path} yet.`,
      res.status,
      path,
    );
  }
  throw new ApiRequestError(
    'internal',
    `The server returned an unexpected response (HTTP ${res.status}).`,
    res.status,
    path,
  );
}

const enc = encodeURIComponent;
type Sig = { signal?: AbortSignal };

function ids(value: Id | Id[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export const api = {
  health: (o: Sig = {}) => request<Health>('GET', '/api/health', { ...o, timeoutMs: 10_000 }),
  session: (o: Sig = {}) => request<SessionResponse>('GET', '/api/session', o),
  startDemo: () => request<Session>('POST', '/api/auth/demo'),
  logout: () => request<LogoutResponse>('POST', '/api/auth/logout'),
  bootstrap: (o: Sig = {}) => request<Bootstrap>('GET', '/api/bootstrap', o),
  brief: (q: { refresh?: boolean; accountId?: Id | Id[] }, o: Sig = {}) =>
    request<Brief>('GET', '/api/brief', {
      ...o,
      query: { refresh: q.refresh ? 1 : undefined, accountId: ids(q.accountId) },
      timeoutMs: 90_000,
    }),

  threads: (q: ThreadListQuery, o: Sig = {}) =>
    request<ListResult<ThreadSummary>>('GET', '/api/threads', {
      ...o,
      query: { ...q, accountId: ids(q.accountId) },
    }),
  thread: (id: Id, o: Sig = {}) => request<ThreadDetail>('GET', `/api/threads/${enc(id)}`, o),
  threadAction: (id: Id, body: ThreadActionRequest) =>
    request<ThreadSummary>('POST', `/api/threads/${enc(id)}/actions`, { body }),

  drafts: (q: { accountId?: Id | Id[]; threadId?: Id; cursor?: string; limit?: number }, o: Sig = {}) =>
    request<ListResult<Draft>>('GET', '/api/drafts', { ...o, query: { ...q, accountId: ids(q.accountId) } }),
  createDraft: (body: DraftCreateRequest) => request<Draft>('POST', '/api/drafts', { body, timeoutMs: 90_000 }),
  updateDraft: (id: Id, body: DraftUpdateRequest) =>
    request<Draft>('PATCH', `/api/drafts/${enc(id)}`, { body, timeoutMs: 90_000 }),
  deleteDraft: (id: Id) => request<Deleted>('DELETE', `/api/drafts/${enc(id)}`),
  sendDraft: (id: Id, body: DraftSendRequest) =>
    request<DraftSendResponse>('POST', `/api/drafts/${enc(id)}/send`, { body, timeoutMs: 90_000 }),

  events: (q: EventListQuery, o: Sig = {}) =>
    request<ListResult<CalendarEvent>>('GET', '/api/events', {
      ...o,
      query: { ...q, accountId: ids(q.accountId), calendarId: ids(q.calendarId) },
    }),
  createEvent: (body: EventCreateRequest) => request<CalendarEvent>('POST', '/api/events', { body }),
  updateEvent: (id: Id, body: EventUpdateRequest) =>
    request<CalendarEvent>('PATCH', `/api/events/${enc(id)}`, { body }),
  deleteEvent: (id: Id, q: EventDeleteQuery) =>
    request<Deleted>('DELETE', `/api/events/${enc(id)}`, { query: { scope: q.scope, notify: q.notify } }),
  rsvp: (id: Id, body: EventRsvpRequest) =>
    request<CalendarEvent>('POST', `/api/events/${enc(id)}/rsvp`, { body }),
  availability: (body: AvailabilityRequest) =>
    request<AvailabilityResult>('POST', '/api/availability', { body, timeoutMs: 60_000 }),

  tasks: (q: TaskListQuery, o: Sig = {}) =>
    request<ListResult<Task>>('GET', '/api/tasks', { ...o, query: { ...q, accountId: ids(q.accountId) } }),
  createTask: (body: TaskCreateRequest) => request<Task>('POST', '/api/tasks', { body }),
  updateTask: (id: Id, body: TaskUpdateRequest) => request<Task>('PATCH', `/api/tasks/${enc(id)}`, { body }),
  deleteTask: (id: Id) => request<Deleted>('DELETE', `/api/tasks/${enc(id)}`),
  taskLists: (accountId?: Id | Id[], o: Sig = {}) =>
    request<ListResult<TaskList>>('GET', '/api/task-lists', { ...o, query: { accountId: ids(accountId) } }),
  createTaskList: (body: TaskListCreateRequest) => request<TaskList>('POST', '/api/task-lists', { body }),
  updateTaskList: (id: Id, body: TaskListUpdateRequest) =>
    request<TaskList>('PATCH', `/api/task-lists/${enc(id)}`, { body }),
  deleteTaskList: (id: Id) => request<Deleted>('DELETE', `/api/task-lists/${enc(id)}`),

  agentMessages: (conversationId: Id | null, o: Sig = {}) =>
    request<AgentMessagesResponse>('GET', '/api/agent/messages', {
      ...o,
      query: { conversationId: conversationId ?? undefined },
    }),
  agentSend: (body: AgentSendRequest, o: Sig = {}) =>
    request<AgentSendResponse>('POST', '/api/agent/messages', { ...o, body, timeoutMs: 120_000 }),

  actions: (q: ActionListQuery, o: Sig = {}) =>
    request<ListResult<Action>>('GET', '/api/actions', { ...o, query: { ...q, accountId: ids(q.accountId) } }),
  approveAction: (id: Id, body: ActionApproveRequest) =>
    request<Action>('POST', `/api/actions/${enc(id)}/approve`, { body, timeoutMs: 90_000 }),
  rejectAction: (id: Id, body: ActionRejectRequest = {}) =>
    request<Action>('POST', `/api/actions/${enc(id)}/reject`, { body }),
  cancelAction: (id: Id) => request<Action>('POST', `/api/actions/${enc(id)}/cancel`),

  connections: (o: Sig = {}) => request<ListResult<Connection>>('GET', '/api/connections', o),
  updateConnection: (id: Id, body: ConnectionUpdateRequest) =>
    request<Connection>('PATCH', `/api/connections/${enc(id)}`, { body }),
  deleteConnection: (id: Id) => request<ConnectionDeleted>('DELETE', `/api/connections/${enc(id)}`),
  syncConnection: (id: Id) => request<Connection>('POST', `/api/connections/${enc(id)}/sync`),

  automations: (o: Sig = {}) => request<ListResult<Automation>>('GET', '/api/automations', o),
  createAutomation: (body: AutomationCreateRequest) => request<Automation>('POST', '/api/automations', { body }),
  updateAutomation: (id: Id, body: AutomationUpdateRequest) =>
    request<Automation>('PATCH', `/api/automations/${enc(id)}`, { body }),

  files: (q: FileListQuery, o: Sig = {}) =>
    request<ListResult<DriveFile>>('GET', '/api/files', { ...o, query: { ...q, accountId: ids(q.accountId) } }),
  fileAction: (body: FileActionRequest) =>
    request<FileActionResult>('POST', '/api/files/actions', { body, timeoutMs: 90_000 }),

  contacts: (q: ContactListQuery, o: Sig = {}) =>
    request<ListResult<Contact>>('GET', '/api/contacts', { ...o, query: { ...q, accountId: ids(q.accountId) } }),
  updateSettings: (body: SettingsUpdateRequest) => request<SettingsResponse>('PATCH', '/api/settings', { body }),
  activity: (q: ActivityListQuery, o: Sig = {}) =>
    request<ListResult<ActivityEntry>>('GET', '/api/activity', {
      ...o,
      query: { ...q, accountId: ids(q.accountId) },
    }),
  deleteAccount: (body: AccountDeleteRequest) =>
    request<AccountDeleteResponse>('POST', '/api/account/delete', { body, timeoutMs: 60_000 }),
};

/** The Google round trip is a top-level navigation, never a fetch. */
export function googleAuthUrl(
  mode: 'login' | 'connect',
  opts: { returnTo?: string; accountId?: Id; features?: ResourceKind[] } = {},
): string {
  return buildUrl('/api/auth/google', {
    mode,
    returnTo: opts.returnTo,
    accountId: opts.accountId,
    features: opts.features?.join(','),
  });
}
