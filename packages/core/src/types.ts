/**
 * Orbitdesk HTTP API contract — shared wire types.
 *
 * This file is the machine-readable half of docs/API-CONTRACT.md. Every JSON
 * body that crosses /api/* is described here. It has no imports and no runtime
 * dependencies; the `as const` tuples exist so handlers can build validators
 * (for example `z.enum(THREAD_ACTIONS)`) from the same source as the types.
 *
 * Conventions
 * - Success bodies are `{ data: T }`, failures are `{ error: { code, message } }`.
 * - Ids are opaque, workspace-unique strings minted by the app. They are never
 *   raw provider ids, so one id resolves to exactly one mailbox resource.
 * - `accountId` always means `Connection.id` (one linked Google account).
 * - Timestamps are RFC 3339 strings with an offset or `Z`. Dates are `YYYY-MM-DD`.
 * - Optional request fields may be omitted; response fields are always present
 *   and use `null` for "no value".
 */

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

export type Id = string;
/** RFC 3339 date-time with offset or `Z`, e.g. `2026-10-04T09:30:00-07:00`. */
export type IsoDateTime = string;
/** Calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;
/** Local wall-clock time, `HH:mm` (24h). */
export type LocalTime = string;

export const ERROR_CODES = [
  'unauthenticated', // 401 — no valid session cookie
  'forbidden', // 403 — resource belongs to another workspace or role is insufficient
  'demo_restricted', // 403 — operation is not offered inside the sandbox demo
  'not_found', // 404
  'validation_failed', // 422 — body or query failed validation; details.fields may list problems
  'conflict', // 409 — stale version, changed content hash, duplicate, or invalid state transition
  'too_large', // 413 — attachment or body limit exceeded
  'rate_limited', // 429 — app or provider quota; details.retryAfterSeconds when known
  'reconnect_required', // 409 — the Google connection must be re-authorised first
  'permission_missing', // 403 — the connection lacks the Google scope for this feature
  'not_configured', // 503 — the deployment lacks configuration (OAuth client, model key, worker)
  'provider_error', // 502 — Google or the model provider failed
  'internal', // 500
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiError {
  code: ErrorCode;
  /** Safe to show to the user. */
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiSuccess<T> {
  data: T;
}
export interface ApiFailure {
  error: ApiError;
}
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const RESOURCE_KINDS = ['mail', 'calendar', 'tasks', 'contacts', 'files'] as const;
/** A Google capability area. Also used as the per-connection permission key. */
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * A source that could not be read while building a list. Lists never pretend an
 * unreadable account or calendar is empty; they report it here instead.
 */
export interface SourceGap {
  accountId: Id | null;
  resource: ResourceKind;
  /** Calendar id or task-list id when the gap is narrower than the account. */
  resourceId: Id | null;
  code: ErrorCode;
  message: string;
}

/** Every list endpoint returns this shape. All three keys are always present. */
export interface ListResult<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page; `null` when exhausted. */
  nextCursor: string | null;
  gaps: SourceGap[];
}

export interface Deleted {
  id: Id;
}

export interface Address {
  name: string | null;
  email: string;
}

/**
 * A pointer to the Workspace resource an answer, task, or action came from.
 * `id` is the app id for `kind` (usable with the matching endpoint).
 */
export interface SourceRef {
  kind: 'thread' | 'message' | 'draft' | 'event' | 'task' | 'file' | 'contact';
  id: Id;
  accountId: Id | null;
  title: string;
  snippet: string | null;
  /** Link into the Google product, when one exists. */
  url: string | null;
  occurredAt: IsoDateTime | null;
}

/* ------------------------------------------------------------------ */
/* Session and capabilities                                            */
/* ------------------------------------------------------------------ */

/** `demo` sessions only ever touch simulated sandbox data. */
export type SessionMode = 'demo' | 'real';

export interface SessionUser {
  id: Id;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface Session {
  mode: SessionMode;
  user: SessionUser;
  workspaceId: Id;
  createdAt: IsoDateTime;
  expiresAt: IsoDateTime | null;
}

export interface Capability {
  available: boolean;
  /** Why it is unavailable (or a caveat while available). Shown verbatim. */
  reason: string | null;
}

/** What the sign-in screen may offer. Readable without a session. */
export interface AuthConfig {
  google: Capability;
  demo: Capability;
  inviteOnly: boolean;
}

/** GET /api/session */
export interface SessionResponse {
  session: Session | null;
  auth: AuthConfig;
}

/** POST /api/auth/logout */
export interface LogoutResponse {
  ok: true;
}

/** Query-string codes appended as `?auth_error=<code>` after a failed OAuth round trip. */
export const AUTH_ERROR_CODES = [
  'access_denied', // user cancelled or denied consent
  'not_invited', // beta allow-list does not include this Google account
  'not_configured', // OAuth client is not configured on this deployment
  'state_mismatch', // expired or forged state; start again
  'scope_denied', // consent granted without the required scopes
  'already_linked', // the Google account is linked to a different workspace
  'account_limit', // plan or beta limit on connected accounts reached
  'admin_restricted', // Workspace administrator blocks the app or a scope
  'session_required', // mode=connect without an app session
  'server_error',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface Capabilities {
  /** Linking real Google accounts (OAuth client configured, not a demo session). */
  googleConnect: Capability;
  /** A model provider is configured and the assistant can answer. */
  agent: Capability;
  mail: Capability;
  calendar: Capability;
  tasks: Capability;
  contacts: Capability;
  /** Drive/Docs/Sheets/Slides operations. */
  files: Capability;
  /** The worker is running schedules. */
  automations: Capability;
  scheduledSend: Capability;
  /** Model identifier shown in the assistant, or `null` when `agent` is unavailable. */
  agentModel: string | null;
  limits: {
    /** Total attachment bytes per message (decoded). */
    attachmentBytesPerMessage: number;
    maxAccounts: number | null;
    /** Days of mail kept in the local cache; older mail is fetched on demand. */
    mailCacheDays: number;
  };
}

/* ------------------------------------------------------------------ */
/* Connections (linked Google accounts)                                */
/* ------------------------------------------------------------------ */

export const CONNECTION_STATUSES = ['active', 'syncing', 'reconnect_required', 'error', 'paused'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_GROUPS = ['personal', 'company', 'client', 'other'] as const;
export type ConnectionGroup = (typeof CONNECTION_GROUPS)[number];

export const PERMISSION_STATES = ['granted', 'denied', 'not_requested', 'admin_restricted'] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

export interface ConnectionPermission {
  resource: ResourceKind;
  state: PermissionState;
  /** OAuth scopes backing this feature (granted ones when `state` is `granted`). */
  scopes: string[];
  /** Human explanation for anything other than a plain grant. */
  detail: string | null;
}

export interface ConnectionSync {
  resource: 'mail' | 'calendar' | 'tasks';
  status: 'ok' | 'syncing' | 'error' | 'never';
  lastSuccessAt: IsoDateTime | null;
  /** Last failure message, cleared on the next success. */
  error: string | null;
}

export interface SendAsIdentity {
  email: string;
  name: string | null;
  isDefault: boolean;
}

export interface Connection {
  id: Id;
  /** Verified Google email for this identity. */
  email: string;
  name: string | null;
  avatarUrl: string | null;
  /** User-chosen label; defaults to the email's local part. */
  label: string;
  group: ConnectionGroup;
  /** `#rrggbb` used for the account dot and calendar tint. */
  color: string;
  kind: 'consumer' | 'workspace';
  /** True for simulated sandbox accounts. */
  demo: boolean;
  /** True when this Google identity is also the app sign-in identity. */
  isLogin: boolean;
  status: ConnectionStatus;
  /** Why the status is not `active`, in plain language. */
  statusDetail: string | null;
  /** Most recent successful sync across resources. */
  lastSyncAt: IsoDateTime | null;
  sync: ConnectionSync[];
  permissions: ConnectionPermission[];
  /** Whether the assistant may read this account. */
  assistantAccess: boolean;
  signature: string | null;
  /** Free-text tone guidance the assistant uses for drafts from this account. */
  writingPreferences: string | null;
  sendAs: SendAsIdentity[];
  createdAt: IsoDateTime;
}

/** PATCH /api/connections/:id */
export interface ConnectionUpdateRequest {
  label?: string;
  group?: ConnectionGroup;
  color?: string;
  assistantAccess?: boolean;
  signature?: string | null;
  writingPreferences?: string | null;
}

/** DELETE /api/connections/:id */
export interface ConnectionDeleted {
  id: Id;
  /** Pending actions cancelled because they targeted this connection. */
  canceledActions: number;
}

/* ------------------------------------------------------------------ */
/* Bootstrap, counts, settings                                         */
/* ------------------------------------------------------------------ */

export interface Counts {
  inboxUnread: number;
  drafts: number;
  /** Actions in `proposed` or `needs_review`. */
  pendingActions: number;
  /** Actions approved and waiting for their scheduled time. */
  scheduledActions: number;
  /** Open tasks due today or overdue. */
  tasksDue: number;
  eventsToday: number;
  unreadByAccount: Record<Id, number>;
}

export interface WorkingHours {
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  start: LocalTime;
  end: LocalTime;
}

export interface Settings {
  /** IANA timezone used for briefs, schedules and availability. */
  timezone: string;
  weekStartsOn: 0 | 1;
  workingHours: WorkingHours;
  meetingBufferMinutes: number;
  defaultMeetingMinutes: number;
  /** Sending account for new mail. */
  defaultAccountId: Id | null;
  defaultCalendarId: Id | null;
  defaultTaskListId: Id | null;
  /** When false, remote images in mail stay blocked until the reader asks. */
  loadRemoteImages: boolean;
  /** Opt-in People API lookup for recipient suggestions. */
  contactLookup: boolean;
}

export interface CalendarPreference {
  calendarId: Id;
  visible?: boolean;
  includeInAvailability?: boolean;
}

/** PATCH /api/settings */
export interface SettingsUpdateRequest extends Partial<Settings> {
  calendars?: CalendarPreference[];
}

/** PATCH /api/settings response */
export interface SettingsResponse {
  settings: Settings;
  calendars: Calendar[];
}

/** GET /api/bootstrap */
export interface Bootstrap {
  session: Session;
  connections: Connection[];
  calendars: Calendar[];
  taskLists: TaskList[];
  labels: MailLabel[];
  counts: Counts;
  capabilities: Capabilities;
  settings: Settings;
}

/* ------------------------------------------------------------------ */
/* Mail                                                                */
/* ------------------------------------------------------------------ */

export const MAIL_FOLDERS = ['inbox', 'unread', 'starred', 'sent', 'all', 'trash'] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/**
 * A Gmail label. `id` is only guaranteed unique within its account, so any
 * request that names a label also carries that label's `accountId`.
 */
export interface MailLabel {
  id: Id;
  accountId: Id;
  name: string;
  kind: 'system' | 'user';
  color: string | null;
}

/** GET /api/threads query. `accountId` may repeat or be comma-separated. */
export interface ThreadListQuery {
  accountId?: Id | Id[];
  /** Free text or Gmail query syntax (`from:`, `has:attachment`, `older_than:` …). */
  q?: string;
  /** Defaults to `inbox`. */
  folder?: MailFolder;
  /** Restrict to one label. Sent with that label's `accountId` and `folder=all` for a label view. */
  labelId?: Id;
  cursor?: string;
  /** 1–100, default 40. */
  limit?: number;
}

export interface ThreadSummary {
  id: Id;
  accountId: Id;
  subject: string;
  snippet: string;
  /** Distinct correspondents, oldest first, excluding the mailbox owner where possible. */
  participants: Address[];
  messageCount: number;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  inInbox: boolean;
  trashed: boolean;
  /** Ids of `MailLabel`s on the thread (system and user). */
  labelIds: Id[];
  lastMessageAt: IsoDateTime;
}

export interface Attachment {
  id: Id;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  /** Same-origin, session-authorised URL, or `null` when the bytes are unavailable. */
  downloadUrl: string | null;
}

export interface Message {
  id: Id;
  threadId: Id;
  accountId: Id;
  from: Address;
  to: Address[];
  cc: Address[];
  /** Only present on messages the mailbox owner sent. */
  bcc: Address[];
  replyTo: Address[];
  subject: string;
  sentAt: IsoDateTime;
  snippet: string;
  bodyText: string | null;
  /**
   * Server-sanitised HTML with `cid:` references rewritten to `downloadUrl`s.
   * The client sanitises again and renders it in a sandboxed frame.
   */
  bodyHtml: string | null;
  attachments: Attachment[];
  unread: boolean;
  starred: boolean;
  /** Sent from one of this account's own identities. */
  outgoing: boolean;
}

/** GET /api/threads/:id — the whole conversation, never truncated by the cache window. */
export interface ThreadDetail extends ThreadSummary {
  messages: Message[];
  /** Link to the conversation in Gmail. */
  url: string | null;
}

export const THREAD_ACTIONS = [
  'archive',
  'unarchive',
  'mark_read',
  'mark_unread',
  'star',
  'unstar',
  'trash',
  'restore',
  'label',
] as const;
export type ThreadAction = (typeof THREAD_ACTIONS)[number];

/** POST /api/threads/:id/actions → updated `ThreadSummary`. */
export interface ThreadActionRequest {
  action: ThreadAction;
  /** Required for `label`; at least one of the two must be non-empty. */
  addLabelIds?: Id[];
  removeLabelIds?: Id[];
  /** Apply `star`/`unstar`/`mark_*` to one message instead of the whole thread. */
  messageId?: Id;
}

/* ------------------------------------------------------------------ */
/* Drafts and sending                                                  */
/* ------------------------------------------------------------------ */

export const DRAFT_MODES = ['new', 'reply', 'reply_all', 'forward'] as const;
export type DraftMode = (typeof DRAFT_MODES)[number];

export const DRAFT_STATUSES = ['draft', 'pending_approval', 'scheduled', 'sending', 'sent', 'failed'] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export interface Draft {
  id: Id;
  accountId: Id;
  mode: DraftMode;
  /** Conversation being replied to or forwarded; `null` for new mail. */
  threadId: Id | null;
  /** The specific message being answered or forwarded. */
  inReplyToMessageId: Id | null;
  /** Sending identity: the account email or one of its `sendAs` addresses. */
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  /** The editable body, including any quoted text. */
  bodyText: string;
  /** Present when the draft was authored as rich text elsewhere (for example in Gmail). */
  bodyHtml: string | null;
  attachments: Attachment[];
  status: DraftStatus;
  scheduledAt: IsoDateTime | null;
  /** The send action tied to this draft while pending, scheduled, sending or failed. */
  actionId: Id | null;
  /**
   * Opaque content version. Send it back on PATCH and send; a mismatch is a
   * `conflict` whose `details.current` holds the latest `Draft`.
   */
  version: string;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface AttachmentUpload {
  filename: string;
  mimeType: string;
  /** Standard base64 (no data: prefix). */
  dataBase64: string;
}

/** POST /api/drafts */
export interface DraftCreateRequest {
  accountId: Id;
  mode: DraftMode;
  /** Required unless `mode` is `new`. Must belong to `accountId`. */
  threadId?: Id | null;
  inReplyToMessageId?: Id | null;
  /** One of the account's identities; defaults to its default send-as. */
  fromEmail?: string;
  to: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  bodyText: string;
  addAttachments?: AttachmentUpload[];
  /** `forward` only: carry over the original message's attachments. */
  includeOriginalAttachments?: boolean;
}

/** PATCH /api/drafts/:id */
export interface DraftUpdateRequest {
  /** The `version` this edit was based on. */
  version: string;
  /** Overwrite even if `version` is stale. Only sent after the user saw the conflict. */
  force?: boolean;
  fromEmail?: string;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  subject?: string;
  bodyText?: string;
  addAttachments?: AttachmentUpload[];
  removeAttachmentIds?: Id[];
}

/**
 * POST /api/drafts/:id/send
 *
 * `intent: 'send'` — the click is the approval. The server records an Action
 * that is already approved and either executes it or queues it for
 * `scheduleAt`.
 *
 * `intent: 'preview'` — nothing is sent. The server records a `proposed`
 * Action holding the exact recipients, identity and content hash, to be
 * approved later through POST /api/actions/:id/approve.
 */
export interface DraftSendRequest {
  version: string;
  intent: 'send' | 'preview';
  /** Future instant. Omit or `null` to send now. */
  scheduleAt?: IsoDateTime | null;
}

export interface DraftSendResponse {
  action: Action;
  /** The draft after the request; `null` once Gmail has consumed it by sending. */
  draft: Draft | null;
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

export const CALENDAR_ACCESS_ROLES = ['owner', 'writer', 'reader', 'freeBusyReader'] as const;
export type CalendarAccessRole = (typeof CALENDAR_ACCESS_ROLES)[number];

export interface Calendar {
  id: Id;
  accountId: Id;
  name: string;
  /** `#rrggbb`. */
  color: string;
  timezone: string;
  accessRole: CalendarAccessRole;
  /** The account's primary calendar. */
  primary: boolean;
  /** Shown in agenda and week views. */
  visible: boolean;
  /** Counts toward availability. */
  includeInAvailability: boolean;
  /** Set when the calendar cannot currently be read. */
  error: string | null;
}

export const RESPONSE_STATUSES = ['needsAction', 'accepted', 'tentative', 'declined'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export interface Attendee {
  email: string;
  name: string | null;
  responseStatus: ResponseStatus;
  optional: boolean;
  organizer: boolean;
  /** This attendee is the connected account. */
  self: boolean;
}

export interface CalendarEvent {
  id: Id;
  calendarId: Id;
  accountId: Id;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  /** `IsoDateTime` for timed events; `IsoDate` when `allDay`. */
  start: string;
  /** Exclusive end. `IsoDate` (the day after the last day) when `allDay`. */
  end: string;
  timezone: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** Whether the event blocks availability. */
  busy: boolean;
  organizer: Address | null;
  attendees: Attendee[];
  /** The connected account's own response, when it is an attendee. */
  myResponse: ResponseStatus | null;
  /** The connection may change event details (organizer or writer on the calendar). */
  canEdit: boolean;
  canRsvp: boolean;
  /** RRULE/EXDATE lines of the series, on masters and instances alike. */
  recurrence: string[] | null;
  /** Series master id when this is an occurrence of a recurring event. */
  recurringEventId: Id | null;
  meetUrl: string | null;
  /** Link to the event in Google Calendar. */
  url: string | null;
  reminderMinutes: number[];
  /** Opaque provider version for conflict checks. */
  version: string;
  updatedAt: IsoDateTime;
}

/** GET /api/events query. */
export interface EventListQuery {
  timeMin: IsoDateTime;
  timeMax: IsoDateTime;
  accountId?: Id | Id[];
  calendarId?: Id | Id[];
  q?: string;
}

export type RecurrenceScope = 'this' | 'series';

export interface AttendeeInput {
  email: string;
  name?: string | null;
  optional?: boolean;
}

/** POST /api/events */
export interface EventCreateRequest {
  calendarId: Id;
  title: string;
  description?: string | null;
  location?: string | null;
  allDay: boolean;
  start: string;
  end: string;
  /** IANA zone for timed events; defaults to `Settings.timezone`. */
  timezone?: string;
  attendees?: AttendeeInput[];
  /** Attach a new Google Meet link. */
  addMeet?: boolean;
  recurrence?: string[] | null;
  reminderMinutes?: number[];
  /** Email attendees about the change. Defaults to true when there are attendees. */
  notify?: boolean;
}

/** PATCH /api/events/:id — only the supplied fields change; conference data is preserved. */
export interface EventUpdateRequest extends Partial<Omit<EventCreateRequest, 'calendarId'>> {
  /** Recurring events: this occurrence or the whole series. Defaults to `this`. */
  scope?: RecurrenceScope;
  /** When supplied and stale, the server answers `conflict`. */
  version?: string;
}

/** DELETE /api/events/:id query. */
export interface EventDeleteQuery {
  scope?: RecurrenceScope;
  notify?: boolean;
}

/** POST /api/events/:id/rsvp */
export interface EventRsvpRequest {
  response: Exclude<ResponseStatus, 'needsAction'>;
  scope?: RecurrenceScope;
  comment?: string;
}

/** POST /api/availability */
export interface AvailabilityRequest {
  timeMin: IsoDateTime;
  timeMax: IsoDateTime;
  durationMinutes: number;
  /** Defaults to every calendar with `includeInAvailability`. */
  calendarIds?: Id[];
  /** Apply `Settings.workingHours` and `meetingBufferMinutes`. Defaults to true. */
  withinWorkingHours?: boolean;
  /** Maximum slots to return, default 12. */
  limit?: number;
}

export interface TimeSlot {
  start: IsoDateTime;
  end: IsoDateTime;
}

export interface BusyInterval extends TimeSlot {
  calendarId: Id;
}

export interface AvailabilityResult {
  slots: TimeSlot[];
  /** Busy blocks behind the answer. Carries no titles. */
  busy: BusyInterval[];
  /** False when any requested calendar could not be read; see `gaps`. */
  complete: boolean;
  gaps: SourceGap[];
  timezone: string;
  /** Calendars that were actually consulted. */
  calendarIds: Id[];
  checkedAt: IsoDateTime;
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export interface TaskList {
  id: Id;
  accountId: Id;
  title: string;
  /** The account's default Google list. */
  isDefault: boolean;
  openCount: number;
  updatedAt: IsoDateTime;
}

export interface Task {
  id: Id;
  taskListId: Id;
  accountId: Id;
  title: string;
  notes: string | null;
  /** Google Tasks stores a date only. */
  due: IsoDate | null;
  completed: boolean;
  completedAt: IsoDateTime | null;
  /** Parent task id for subtasks. */
  parentId: Id | null;
  /** Lexicographic sort key within its parent, as Google returns it. */
  position: string;
  /** Email or event the task came from, kept by the app. */
  source: SourceRef | null;
  /** App reminder, separate from the Google due date. */
  reminderAt: IsoDateTime | null;
  /** Assigned from Docs/Chat; Google restricts some edits. */
  assigned: boolean;
  /** Link to the task in Google. */
  url: string | null;
  updatedAt: IsoDateTime;
}

/** GET /api/tasks query. */
export interface TaskListQuery {
  taskListId?: Id;
  accountId?: Id | Id[];
  /** Defaults to `open`. */
  status?: 'open' | 'completed' | 'all';
  q?: string;
  /** Only tasks due on or before this date. */
  dueBefore?: IsoDate;
  cursor?: string;
  limit?: number;
}

/** POST /api/tasks */
export interface TaskCreateRequest {
  taskListId: Id;
  title: string;
  notes?: string | null;
  due?: IsoDate | null;
  parentId?: Id | null;
  reminderAt?: IsoDateTime | null;
  source?: SourceRef | null;
}

/** PATCH /api/tasks/:id */
export interface TaskUpdateRequest {
  title?: string;
  notes?: string | null;
  due?: IsoDate | null;
  completed?: boolean;
  /** Move to another list of the same account. */
  taskListId?: Id;
  parentId?: Id | null;
  /** Reorder: place after this sibling; `null` moves to the top. */
  previousId?: Id | null;
  reminderAt?: IsoDateTime | null;
}

/** POST /api/task-lists */
export interface TaskListCreateRequest {
  accountId: Id;
  title: string;
}

/** PATCH /api/task-lists/:id */
export interface TaskListUpdateRequest {
  title: string;
}

/* ------------------------------------------------------------------ */
/* Actions and approvals                                               */
/* ------------------------------------------------------------------ */

export const ACTION_STATES = [
  'proposed', // waiting for the user's decision
  'approved', // approved, not yet picked up
  'queued', // waiting for the worker or for `scheduledAt`
  'running',
  'succeeded',
  'failed',
  'canceled', // user cancelled before execution
  'rejected', // user declined the proposal
  'needs_review', // outcome uncertain or content changed; needs a fresh decision
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

export const ACTION_KINDS = [
  'send_email',
  'create_event',
  'update_event',
  'cancel_event',
  'rsvp_event',
  'create_task',
  'update_task',
  'delete_task',
  'modify_threads',
  'file_operation',
  'other',
] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface FieldChange {
  field: string;
  from: string | null;
  to: string | null;
}

export interface PreviewField {
  label: string;
  value: string;
}

export interface SendEmailPreview {
  kind: 'send_email';
  draftId: Id | null;
  mode: DraftMode;
  threadId: Id | null;
  from: Address;
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
  attachments: Array<{ filename: string; size: number }>;
}

export interface EventPreview {
  kind: 'create_event' | 'update_event';
  eventId: Id | null;
  calendarId: Id;
  calendarName: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  timezone: string | null;
  location: string | null;
  description: string | null;
  attendees: Address[];
  addMeet: boolean;
  recurrence: string[] | null;
  notifiesAttendees: boolean;
  /** For `update_event`: what differs from the current event. */
  changes: FieldChange[];
}

export interface CancelEventPreview {
  kind: 'cancel_event';
  eventId: Id;
  calendarName: string;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  scope: RecurrenceScope;
  attendees: Address[];
  notifiesAttendees: boolean;
}

export interface RsvpPreview {
  kind: 'rsvp_event';
  eventId: Id;
  title: string;
  allDay: boolean;
  start: string;
  end: string;
  organizer: Address | null;
  response: Exclude<ResponseStatus, 'needsAction'>;
  comment: string | null;
}

export interface TaskPreview {
  kind: 'create_task' | 'update_task' | 'delete_task';
  taskId: Id | null;
  taskListId: Id;
  taskListTitle: string;
  title: string;
  notes: string | null;
  due: IsoDate | null;
  source: SourceRef | null;
  changes: FieldChange[];
}

export interface ModifyThreadsPreview {
  kind: 'modify_threads';
  operation: ThreadAction;
  /** Label names being added/removed, already resolved for display. */
  addLabels: string[];
  removeLabels: string[];
  /** Total threads affected; `threads` may be a bounded sample. */
  count: number;
  threads: Array<{ id: Id; subject: string; from: Address | null }>;
}

export interface FileOperationPreview {
  kind: 'file_operation';
  operation: FileOperation;
  fileId: Id | null;
  fileName: string;
  fields: PreviewField[];
}

export interface OtherPreview {
  kind: 'other';
  fields: PreviewField[];
}

/** The exact payload the user is asked to approve. `preview.kind === action.kind`. */
export type ActionPreview =
  | SendEmailPreview
  | EventPreview
  | CancelEventPreview
  | RsvpPreview
  | TaskPreview
  | ModifyThreadsPreview
  | FileOperationPreview
  | OtherPreview;

export interface ActionStep {
  id: Id;
  label: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  detail: string | null;
  /** Link to the created or changed Google resource. */
  url: string | null;
}

export interface Action {
  id: Id;
  kind: ActionKind;
  state: ActionState;
  /** One line, e.g. "Send reply to Dana Whitfield". */
  title: string;
  /** Why the action is proposed or what happened. */
  summary: string | null;
  /** The account that will act; `null` only for app-internal actions. */
  accountId: Id | null;
  origin: 'user' | 'agent' | 'automation';
  preview: ActionPreview;
  /** Hash of the exact payload. Approval is bound to it. */
  contentHash: string;
  scheduledAt: IsoDateTime | null;
  steps: ActionStep[];
  result: { message: string; url: string | null } | null;
  error: { code: ErrorCode; message: string } | null;
  conversationId: Id | null;
  automationId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** When it was approved, rejected or cancelled. */
  decidedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
}

/** GET /api/actions query. */
export interface ActionListQuery {
  /**
   * `pending` = proposed + needs_review; `scheduled` = approved + queued + running;
   * `done` = succeeded + failed + canceled + rejected. Omit for all.
   */
  status?: 'pending' | 'scheduled' | 'done';
  accountId?: Id | Id[];
  cursor?: string;
  limit?: number;
}

/** POST /api/actions/:id/approve */
export interface ActionApproveRequest {
  /** The `contentHash` the user saw. A mismatch is a `conflict`. */
  contentHash: string;
}

/** POST /api/actions/:id/reject */
export interface ActionRejectRequest {
  reason?: string;
}

/* ------------------------------------------------------------------ */
/* Assistant                                                           */
/* ------------------------------------------------------------------ */

export interface AgentConversation {
  id: Id;
  title: string;
  updatedAt: IsoDateTime;
}

export interface ToolCall {
  id: Id;
  /** Tool identifier, e.g. `mail.search`. */
  name: string;
  /** Human sentence, e.g. "Searched 3 inboxes for unread mail". */
  label: string;
  status: 'ok' | 'error';
  accountId: Id | null;
  /** Short result summary or error message. */
  detail: string | null;
  durationMs: number | null;
}

export interface AgentMessage {
  id: Id;
  conversationId: Id;
  role: 'user' | 'assistant';
  /** Markdown subset: paragraphs, lists, **bold**, *italic*, `code`, [links](https://…). */
  text: string;
  /** Accounts the turn was allowed to read. */
  accountIds: Id[];
  /** Tools the model called, in order. Empty for user messages. */
  tools: ToolCall[];
  /** Assistant: resources the answer relied on. User: the `context` sent with the question. */
  sources: SourceRef[];
  /** Actions proposed by this reply, in their current state. */
  actions: Action[];
  model: string | null;
  createdAt: IsoDateTime;
}

/** GET /api/agent/messages */
export interface AgentMessagesResponse {
  /** `null` when no `conversationId` was requested. */
  conversation: AgentConversation | null;
  messages: AgentMessage[];
  /** Recent conversations, newest first. */
  conversations: AgentConversation[];
}

/** POST /api/agent/messages */
export interface AgentSendRequest {
  /** Omit or `null` to start a conversation. */
  conversationId?: Id | null;
  text: string;
  /** Accounts the assistant may read for this turn. Must be non-empty. */
  accountIds: Id[];
  /** Resources the user attached to the question (the open thread, an event …). */
  context?: SourceRef[];
}

export interface AgentSendResponse {
  conversation: AgentConversation;
  userMessage: AgentMessage;
  reply: AgentMessage;
}

/* ------------------------------------------------------------------ */
/* Daily brief                                                         */
/* ------------------------------------------------------------------ */

export interface BriefMailItem {
  thread: ThreadSummary;
  /** Why it is listed, e.g. "Asked for a decision by Friday". */
  reason: string;
}

export interface Brief {
  date: IsoDate;
  timezone: string;
  generatedAt: IsoDateTime;
  /** `model` when the prose was written by the assistant; `rules` when assembled without a model. */
  generatedBy: 'model' | 'rules';
  headline: string | null;
  /** Short prose summary; `null` when no model is configured. */
  summary: string | null;
  meetings: CalendarEvent[];
  /** Open tasks due today or overdue. */
  tasks: Task[];
  needsReply: BriefMailItem[];
  /** Sent threads still waiting on someone else. */
  waitingOn: BriefMailItem[];
  gaps: SourceGap[];
}

/* ------------------------------------------------------------------ */
/* Automations                                                         */
/* ------------------------------------------------------------------ */

export const AUTOMATION_TEMPLATES = ['daily_brief', 'follow_up', 'triage'] as const;
export type AutomationTemplate = (typeof AUTOMATION_TEMPLATES)[number];

export interface AutomationSchedule {
  time: LocalTime;
  /** 0 = Sunday … 6 = Saturday. */
  days: number[];
  timezone: string;
}

export interface AutomationConfig {
  /** `follow_up`: remind when a sent thread has no reply after this many days. */
  followUpAfterDays?: number;
  /** `triage`: plain-language rule the suggestions follow. */
  triageInstruction?: string;
}

export interface Automation {
  id: Id;
  template: AutomationTemplate;
  name: string;
  enabled: boolean;
  /** Empty means every account with `assistantAccess`. */
  accountIds: Id[];
  schedule: AutomationSchedule;
  config: AutomationConfig;
  lastRunAt: IsoDateTime | null;
  lastRunStatus: 'ok' | 'failed' | null;
  lastRunDetail: string | null;
  nextRunAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** POST /api/automations — one automation per template; a duplicate is a `conflict`. */
export interface AutomationCreateRequest {
  template: AutomationTemplate;
  name?: string;
  enabled?: boolean;
  accountIds?: Id[];
  schedule: AutomationSchedule;
  config?: AutomationConfig;
}

/** PATCH /api/automations/:id */
export interface AutomationUpdateRequest {
  name?: string;
  enabled?: boolean;
  accountIds?: Id[];
  schedule?: AutomationSchedule;
  config?: AutomationConfig;
}

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export const FILE_KINDS = ['doc', 'sheet', 'slides', 'pdf', 'image', 'folder', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_OPERATIONS = ['create', 'rename', 'copy', 'trash', 'summarize'] as const;
export type FileOperation = (typeof FILE_OPERATIONS)[number];

export interface DriveFile {
  id: Id;
  accountId: Id;
  name: string;
  kind: FileKind;
  mimeType: string;
  owner: Address | null;
  shared: boolean;
  size: number | null;
  modifiedAt: IsoDateTime;
  /** Link that opens the file in Google. */
  url: string | null;
}

/** GET /api/files query. */
export interface FileListQuery {
  accountId?: Id | Id[];
  q?: string;
  kind?: FileKind;
  cursor?: string;
  limit?: number;
}

/** POST /api/files/actions */
export type FileActionRequest =
  | { action: 'create'; accountId: Id; kind: 'doc' | 'sheet' | 'slides'; name: string }
  | { action: 'rename'; fileId: Id; name: string }
  | { action: 'copy'; fileId: Id; name?: string }
  | { action: 'trash'; fileId: Id }
  | { action: 'summarize'; fileId: Id };

export interface FileActionResult {
  /** The created, renamed or copied file; the summarised file; `null` after `trash`. */
  file: DriveFile | null;
  /** Model-written summary for `summarize`, else `null`. */
  summary: string | null;
  /** Id removed from listings by `trash`, else `null`. */
  removedFileId: Id | null;
}

/* ------------------------------------------------------------------ */
/* Contacts, activity, account, health                                 */
/* ------------------------------------------------------------------ */

export interface Contact {
  id: Id;
  accountId: Id;
  name: string | null;
  email: string;
  photoUrl: string | null;
  /** `contacts` = People API; `recent` = seen in cached mail headers. */
  origin: 'contacts' | 'recent';
}

/** GET /api/contacts query. */
export interface ContactListQuery {
  q: string;
  accountId?: Id | Id[];
  /** 1–25, default 8. */
  limit?: number;
}

export interface ActivityEntry {
  id: Id;
  at: IsoDateTime;
  actor: 'user' | 'agent' | 'automation' | 'system';
  /** Dotted machine key, e.g. `action.succeeded`, `connection.sync_failed`. */
  kind: string;
  /** Redacted, human-readable line. Never contains message bodies. */
  title: string;
  detail: string | null;
  outcome: 'ok' | 'failed' | 'pending' | 'info';
  accountId: Id | null;
  actionId: Id | null;
}

/** GET /api/activity query. */
export interface ActivityListQuery {
  accountId?: Id | Id[];
  cursor?: string;
  limit?: number;
}

/** POST /api/account/delete */
export interface AccountDeleteRequest {
  /** Must equal the signed-in user's email. */
  confirmEmail: string;
}

export interface AccountDeleteResponse {
  deleted: true;
}

/** GET /api/health — unauthenticated. */
export interface Health {
  status: 'ok' | 'degraded' | 'down';
  version: string;
  time: IsoDateTime;
  checks: {
    database: 'ok' | 'down';
    /** `stale` when the worker heartbeat is older than expected. */
    worker: 'ok' | 'stale' | 'unknown';
    googleOAuth: 'configured' | 'missing';
    model: 'configured' | 'missing';
  };
}
