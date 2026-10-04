# Orbitdesk API contract

Version 1 · JSON over HTTP under `/api` · no websocket.

The TypeScript shapes named here live in [`packages/core/src/types.ts`](../packages/core/src/types.ts) and are importable as `@orbitdesk/core/types`. That file is the source of truth for field names; this document says which shape goes with which endpoint and what the server must do.

## 1. Conventions

**Envelope.** Every response is JSON with exactly one top-level key.

```jsonc
// success — HTTP 200 (201 for creates)
{ "data": <T> }

// failure — HTTP 4xx/5xx
{ "error": { "code": "conflict", "message": "This draft changed in Gmail.", "details": { } } }
```

`message` is shown to the user verbatim, so write it for a person. `details` is optional.

**Transport.** The browser calls every endpoint with `credentials: "same-origin"` and `Accept: application/json`. Requests with a body send `Content-Type: application/json`. The session is an HttpOnly cookie; no token is ever placed in JavaScript. Mutating handlers should reject requests whose `Origin` is not the app origin.

**Ids.** Every `id` is an opaque string unique within the workspace, so an id can only resolve to one mailbox's resource. The one exception is `MailLabel.id`, which is unique within its account and is always used together with `accountId`. The client treats ids as opaque and passes them through `encodeURIComponent` in paths.

**`accountId`.** Always a `Connection.id` — one linked Google account. As a query parameter it may repeat (`?accountId=a&accountId=b`) or be comma-separated (`?accountId=a,b`). Omitted means every connection in the workspace.

**Time.** Timestamps are RFC 3339 with an offset or `Z`. Dates are `YYYY-MM-DD`. All-day events use dates with an exclusive `end`.

**Lists.** Every list endpoint returns `ListResult<T>`:

```jsonc
{ "data": { "items": [ … ], "nextCursor": null, "gaps": [ ] } }
```

`nextCursor` is passed back as `?cursor=`. `gaps` names any account, calendar or list that could not be read (`SourceGap`). A list that could not consult a source must report the gap; it must not return an empty result that looks complete. A failing account never fails the whole request — only a failure of every requested source is an error.

**Nulls.** Response fields are always present; "no value" is `null`. Request fields marked `?` may be omitted. In PATCH bodies an omitted field is unchanged and an explicit `null` clears it.

**Demo and real.** `Session.mode` is `demo` or `real`. A demo session is created by `POST /api/auth/demo`, owns an isolated workspace of simulated accounts (`Connection.demo = true`), and never calls Google or delivers mail. Every endpoint works in both modes with the same shapes. Operations that cannot exist in the sandbox answer `403 demo_restricted`.

**No client fallbacks.** The frontend holds no fixture data. When a request fails it shows the error and a retry; when a capability is unavailable it shows `Capability.reason`.

### Error codes

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `unauthenticated` | 401 | No valid session. The client returns to the sign-in screen. |
| `forbidden` | 403 | Resource is outside the caller's workspace or selection. |
| `demo_restricted` | 403 | Not offered inside the sandbox demo. |
| `permission_missing` | 403 | The connection lacks the Google scope for this feature. |
| `not_found` | 404 | Unknown id (also used for ids owned by another workspace). |
| `conflict` | 409 | Stale `version`, changed `contentHash`, duplicate, or invalid state transition. |
| `reconnect_required` | 409 | The Google connection must be re-authorised first. `details.accountId`. |
| `too_large` | 413 | Attachment or body limit exceeded. `details.limitBytes`. |
| `validation_failed` | 422 | Body or query failed validation. `details.fields: { [path]: message }`. |
| `rate_limited` | 429 | App or provider quota. `details.retryAfterSeconds` when known. |
| `internal` | 500 | Unexpected failure. |
| `provider_error` | 502 | Google or the model provider failed. |
| `not_configured` | 503 | The deployment lacks configuration (OAuth client, model key, worker). |

The client lower-cases `code` before comparing, and treats an unknown code as `internal`.

## 2. Endpoint index

| Method | Path | Request | `data` |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `Health` |
| GET | `/api/session` | — | `SessionResponse` |
| POST | `/api/auth/demo` | `{}` | `Session` |
| GET | `/api/auth/google` | query `mode`, `returnTo`, `accountId`, `features` | 302 redirect |
| POST | `/api/auth/logout` | `{}` | `LogoutResponse` |
| GET | `/api/bootstrap` | — | `Bootstrap` |
| GET | `/api/brief` | query `refresh`, `accountId` | `Brief` |
| GET | `/api/threads` | `ThreadListQuery` | `ListResult<ThreadSummary>` |
| GET | `/api/threads/:id` | — | `ThreadDetail` |
| POST | `/api/threads/:id/actions` | `ThreadActionRequest` | `ThreadSummary` |
| GET | `/api/drafts` | query `accountId`, `threadId`, `cursor`, `limit` | `ListResult<Draft>` |
| POST | `/api/drafts` | `DraftCreateRequest` | `Draft` (201) |
| PATCH | `/api/drafts/:id` | `DraftUpdateRequest` | `Draft` |
| DELETE | `/api/drafts/:id` | — | `Deleted` |
| POST | `/api/drafts/:id/send` | `DraftSendRequest` | `DraftSendResponse` |
| GET | `/api/events` | `EventListQuery` | `ListResult<CalendarEvent>` |
| POST | `/api/events` | `EventCreateRequest` | `CalendarEvent` (201) |
| PATCH | `/api/events/:id` | `EventUpdateRequest` | `CalendarEvent` |
| DELETE | `/api/events/:id` | `EventDeleteQuery` | `Deleted` |
| POST | `/api/events/:id/rsvp` | `EventRsvpRequest` | `CalendarEvent` |
| POST | `/api/availability` | `AvailabilityRequest` | `AvailabilityResult` |
| GET | `/api/tasks` | `TaskListQuery` | `ListResult<Task>` |
| POST | `/api/tasks` | `TaskCreateRequest` | `Task` (201) |
| PATCH | `/api/tasks/:id` | `TaskUpdateRequest` | `Task` |
| DELETE | `/api/tasks/:id` | — | `Deleted` |
| GET | `/api/task-lists` | query `accountId` | `ListResult<TaskList>` |
| POST | `/api/task-lists` | `TaskListCreateRequest` | `TaskList` (201) |
| PATCH | `/api/task-lists/:id` | `TaskListUpdateRequest` | `TaskList` |
| DELETE | `/api/task-lists/:id` | — | `Deleted` |
| GET | `/api/agent/messages` | query `conversationId` | `AgentMessagesResponse` |
| POST | `/api/agent/messages` | `AgentSendRequest` | `AgentSendResponse` |
| GET | `/api/actions` | `ActionListQuery` | `ListResult<Action>` |
| POST | `/api/actions/:id/approve` | `ActionApproveRequest` | `Action` |
| POST | `/api/actions/:id/reject` | `ActionRejectRequest` | `Action` |
| POST | `/api/actions/:id/cancel` | `{}` | `Action` |
| GET | `/api/connections` | — | `ListResult<Connection>` |
| PATCH | `/api/connections/:id` | `ConnectionUpdateRequest` | `Connection` |
| DELETE | `/api/connections/:id` | — | `ConnectionDeleted` |
| POST | `/api/connections/:id/sync` | `{}` | `Connection` |
| GET | `/api/automations` | — | `ListResult<Automation>` |
| POST | `/api/automations` | `AutomationCreateRequest` | `Automation` (201) |
| PATCH | `/api/automations/:id` | `AutomationUpdateRequest` | `Automation` |
| GET | `/api/files` | `FileListQuery` | `ListResult<DriveFile>` |
| POST | `/api/files/actions` | `FileActionRequest` | `FileActionResult` |
| GET | `/api/contacts` | `ContactListQuery` | `ListResult<Contact>` |
| PATCH | `/api/settings` | `SettingsUpdateRequest` | `SettingsResponse` |
| GET | `/api/activity` | `ActivityListQuery` | `ListResult<ActivityEntry>` |
| POST | `/api/account/delete` | `AccountDeleteRequest` | `AccountDeleteResponse` |

Everything except `/api/health`, `/api/session`, `/api/auth/demo` and `/api/auth/google?mode=login` requires a session and answers `401 unauthenticated` without one.

## 3. Session and sign-in

### `GET /api/session`

Always `200`. `session` is `null` when signed out. `auth` tells the sign-in screen what to offer and is readable without a session.

```json
{
  "data": {
    "session": null,
    "auth": {
      "google": { "available": false, "reason": "Google sign-in is not configured on this deployment." },
      "demo": { "available": true, "reason": null },
      "inviteOnly": true
    }
  }
}
```

### `POST /api/auth/demo`

Creates a fresh, isolated demo workspace seeded with simulated accounts, sets the session cookie, and returns the `Session` (`mode: "demo"`). Each call makes a new sandbox; nothing is shared between demo sessions. `503 not_configured` when `auth.demo.available` is false.

### `GET /api/auth/google`

A top-level navigation, not a fetch. Answers `302` to Google.

| Query | Values | Notes |
| --- | --- | --- |
| `mode` | `login` \| `connect` | `login` signs in (creating the user and workspace on first use). `connect` links another Google account to the current workspace and never switches the session. |
| `returnTo` | same-origin path | Where to land afterwards. Default `/`. Anything that is not a path starting with a single `/` is ignored. |
| `accountId` | `Connection.id` | `connect` only: re-authorise this existing connection. The server passes its email as `login_hint` and rejects a different Google subject. |
| `features` | comma list of `mail,calendar,tasks,contacts,files` | `connect` only: the capability areas to request. Default `mail,calendar,tasks`. |

After the Google round trip the server redirects to `returnTo` with one of:

- `?auth=signed_in` after a login.
- `?auth=connected&accountId=<id>` after linking or re-authorising.
- `?auth_error=<AuthErrorCode>` on failure, optionally with `&auth_email=<google email>` so the message can name the account.

`AuthErrorCode` values: `access_denied`, `not_invited`, `not_configured`, `state_mismatch`, `scope_denied`, `already_linked`, `account_limit`, `admin_restricted`, `session_required`, `server_error`. When Google sign-in is unconfigured the endpoint redirects with `auth_error=not_configured` rather than rendering an error page.

### `POST /api/auth/logout`

Clears the session cookie. `{ "data": { "ok": true } }`. Idempotent.

## 4. Bootstrap and settings

### `GET /api/bootstrap`

One call that paints the shell: `Bootstrap` = `session`, `connections`, `calendars`, `taskLists`, `labels`, `counts`, `capabilities`, `settings`. It reads from the local cache and must not block on Google. The client re-fetches it on window focus, about once a minute, and after mutations that move counts.

`capabilities` drives every "is this available" decision in the UI. Each `Capability` is `{ available, reason }`; `reason` is displayed when `available` is false. In a demo session `googleConnect.available` is false with a reason such as "The sandbox uses simulated accounts. Sign in with Google to link real ones."

### `PATCH /api/settings`

Body is any subset of `Settings` plus optional `calendars: CalendarPreference[]` to change a calendar's `visible` / `includeInAvailability`. Returns the full `settings` and the full `calendars` array.

## 5. Mail

### `GET /api/threads`

Query `ThreadListQuery`: `accountId`, `q`, `folder` (`inbox` default, `unread`, `starred`, `sent`, `all`, `trash`), `labelId`, `cursor`, `limit` (default 40, max 100).

- `unread` means unread threads in the inbox. `all` excludes trash.
- `labelId` filters to one label. A `MailLabel.id` is only unique within its account, so the client always sends the label's `accountId` with it (and `folder=all`).
- `q` accepts plain text and Gmail query syntax. When `q` is present the server searches Google on demand across the selected accounts so results older than the cache window appear.
- Items are sorted by `lastMessageAt` descending, merged across accounts.
- An account that needs reconnecting contributes a `gaps` entry and no items.

### `GET /api/threads/:id`

`ThreadDetail`: the summary fields plus every message in the conversation, oldest first. The server hydrates the full thread from Google when the cache holds only part of it. `bodyHtml` is sanitised server-side with `cid:` images rewritten to `Attachment.downloadUrl`. Opening a thread does **not** mark it read; the client sends `mark_read` explicitly.

`Attachment.downloadUrl` is a same-origin URL the session is authorised to GET (the route is the server's choice), or `null`.

### `POST /api/threads/:id/actions`

Body `ThreadActionRequest`. Returns the updated `ThreadSummary`.

| `action` | Effect |
| --- | --- |
| `archive` / `unarchive` | Remove from / return to the inbox. |
| `mark_read` / `mark_unread` | Whole thread, or one message with `messageId`. |
| `star` / `unstar` | Whole thread, or one message with `messageId`. |
| `trash` / `restore` | Move to trash / bring back. Never a permanent delete. |
| `label` | `addLabelIds` and/or `removeLabelIds`, which must belong to the thread's account. |

These are direct user actions and need no approval step.

### Drafts

Drafts are real Gmail drafts owned by one account.

- `GET /api/drafts` — `ListResult<Draft>`, newest first. Optional `accountId`, `threadId`.
- `POST /api/drafts` — `DraftCreateRequest` → `201 Draft`. The client always sends explicit recipients, subject and body (including quoted text). For `reply`, `reply_all` and `forward` the server sets Gmail's `threadId`, `In-Reply-To` and `References` from `threadId` + `inReplyToMessageId`, and answers `422` if the thread belongs to a different account. `addAttachments` carries base64 content; the decoded total must not exceed `capabilities.limits.attachmentBytesPerMessage` (`413 too_large`).
- `PATCH /api/drafts/:id` — `DraftUpdateRequest` → `Draft`. `version` is required. If the stored version differs (for example the draft was edited in Gmail) the server answers `409 conflict` with `details.current` set to the latest `Draft`, unless `force` is true. Editing a draft whose send is `pending_approval` or `scheduled` moves its action to `needs_review` and the draft back to `draft`.
- `DELETE /api/drafts/:id` → `Deleted`. Cancels any pending send action for it.

How the client fills reply recipients (the server should apply the same rules when the assistant drafts):

- `reply`: To = the message's `replyTo` if present, else `from`. If the message was sent by the user, To = its `to`.
- `reply_all`: as `reply`, plus Cc = the message's `to` + `cc`, minus every address in the account's `email` and `sendAs`, minus anything already in To.
- `forward`: no recipients; body carries a forwarded-message header block.
- Subjects get `Re: ` / `Fwd: ` unless already prefixed.

### `POST /api/drafts/:id/send`

Body `DraftSendRequest` `{ version, intent, scheduleAt? }` → `DraftSendResponse` `{ action, draft }`.

| `intent` | `scheduleAt` | Server behaviour | Returned `action.state` |
| --- | --- | --- | --- |
| `send` | omitted | The click is the approval. Record an approved `send_email` action and execute it. | `succeeded`, or `queued`/`running` if handed to the worker, or `failed`/`needs_review` |
| `send` | future instant | Record an approved action scheduled for that time. | `queued` with `scheduledAt` |
| `preview` | optional | Send nothing. Record a `proposed` action with the exact recipients, identity, body and `contentHash` for later approval. | `proposed` |

`version` must match the stored draft (`409 conflict` with `details.current` otherwise). `scheduleAt` in the past is `422`. `draft` is `null` once Gmail has consumed the draft by sending it. In a demo session the send is simulated and the action still reaches `succeeded`.

## 6. Calendar

### `GET /api/events`

Query `EventListQuery`: `timeMin`, `timeMax` (required, max span 62 days), optional `accountId`, `calendarId` (repeatable), `q`. Returns expanded occurrences (not series masters) that overlap the window, from calendars with `visible: true` unless `calendarId` is given. A shared calendar reachable through two connections appears once. Unreadable calendars go in `gaps` with `resource: "calendar"` and `resourceId` set.

### `POST /api/events`, `PATCH /api/events/:id`, `DELETE /api/events/:id`

- Create: `EventCreateRequest` → `201 CalendarEvent`. `addMeet: true` requests a Meet link; if Google creates it asynchronously, `meetUrl` may be `null` in the response and filled on a later read.
- Update: `EventUpdateRequest` → `CalendarEvent`. Only supplied fields change. Existing conference data is preserved. `scope` picks one occurrence (`this`, default) or the whole `series`. A stale `version` is `409 conflict`.
- Delete: query `scope`, `notify` → `Deleted`. Deleting cancels the event for attendees when the account is the organizer.
- `notify` controls attendee emails. `403 forbidden` when `canEdit` is false.

For all-day events `start`/`end` are dates and `end` is exclusive (a one-day event on the 4th is `start: "2026-10-04", end: "2026-10-05"`).

### `POST /api/events/:id/rsvp`

`EventRsvpRequest` `{ response: "accepted" | "tentative" | "declined", scope?, comment? }` → `CalendarEvent` with `myResponse` updated. `403 forbidden` when `canRsvp` is false.

### `POST /api/availability`

`AvailabilityRequest` → `AvailabilityResult`. The server queries live free/busy for `calendarIds` (default: calendars with `includeInAvailability`), merges busy intervals, applies working hours and buffer when `withinWorkingHours` is not false, and returns up to `limit` slots of `durationMinutes`.

`complete` is `false` whenever any requested calendar could not be read; those calendars are listed in `gaps` and the client labels the slots as unverified. `busy` contains intervals only — no titles.

## 7. Tasks

- `GET /api/tasks` — `TaskListQuery` → `ListResult<Task>` ordered by list, then `position`. `status` defaults to `open`. Subtasks are returned flat with `parentId`.
- `POST /api/tasks` — `TaskCreateRequest` → `201 Task`. `source` stores provenance in the app and appends the source URL to `notes` in Google.
- `PATCH /api/tasks/:id` — `TaskUpdateRequest` → `Task`. `completed: true|false` completes or reopens. `taskListId` moves within the same account. `previousId` reorders. `due` is a date only. `reminderAt` is an app reminder and is not written to Google.
- `DELETE /api/tasks/:id` → `Deleted`.
- `GET /api/task-lists` → `ListResult<TaskList>`; `POST` `{ accountId, title }` → `201 TaskList`; `PATCH /api/task-lists/:id` `{ title }` → `TaskList`; `DELETE /api/task-lists/:id` → `Deleted` (`409 conflict` for an account's default list).

Edits Google refuses on assigned tasks answer `403 forbidden` with an explanatory message.

## 8. Assistant

### `GET /api/agent/messages`

- Without `conversationId`: `{ conversation: null, messages: [], conversations }` — the recent conversations, newest first.
- With `conversationId`: that conversation, its `messages` oldest first, and `conversations`.

### `POST /api/agent/messages`

`AgentSendRequest` `{ conversationId?, text, accountIds, context? }` → `AgentSendResponse` `{ conversation, userMessage, reply }`.

- Not streamed. The request stays open until the run finishes; the server bounds a run to about 90 seconds and the client waits up to 120.
- `accountIds` is the user's selection for this turn. The server intersects it with connections that have `assistantAccess: true` and are owned by the workspace; an empty intersection is `422 validation_failed`. Tools can only reach those accounts — the model never supplies a workspace or credential.
- `reply.text` is the model's actual answer. `reply.tools` is the ordered trace of tool calls that really ran. `reply.sources` are the resources the answer relied on. `reply.actions` are proposed `Action`s (state `proposed`) awaiting approval. The frontend never fabricates any of these.
- `context` lets the user attach the open thread or event; the server validates ownership before use and echoes it as `userMessage.sources`.
- `503 not_configured` when `capabilities.agent.available` is false. A model or tool failure is `502 provider_error`; the user message is still persisted and returned by the next GET.
- Read-only tools and draft preparation may run inside the turn. Sends, invitations, cancellations, deletions and other external changes are returned as proposed actions.

## 9. Actions and approvals

`Action` carries the exact payload in `preview` (a union discriminated by `kind`, equal to `action.kind`) and a `contentHash` over it.

```
proposed ──approve──▶ approved ─▶ queued ─▶ running ─▶ succeeded
    │                     │          │                 └▶ failed
    └──reject──▶ rejected └──cancel──┴──▶ canceled     └▶ needs_review ──approve/cancel──▶ …
```

- `GET /api/actions` — `ActionListQuery`. `status=pending` (proposed + needs_review), `scheduled` (approved + queued + running), `done` (succeeded + failed + canceled + rejected). Newest first.
- `POST /api/actions/:id/approve` — body `{ contentHash }`. The hash must equal the stored one, else `409 conflict` with `details.action` holding the current `Action` so the user can review the new content. Allowed from `proposed` and `needs_review`. Returns the action in its new state; immediate actions may already be `succeeded` or `failed`.
- `POST /api/actions/:id/reject` — body `{ reason? }`. Allowed from `proposed` and `needs_review` → `rejected`.
- `POST /api/actions/:id/cancel` — allowed from `approved` and `queued` → `canceled`. `409 conflict` once the action is `running` or finished; the response message says what actually happened.

Multi-step actions report each step in `steps`. `result.url` links to the created Google resource. A send whose outcome is uncertain is `needs_review`, never silently retried.

## 10. Connections

- `GET /api/connections` → `ListResult<Connection>`. The client polls this while any connection is `syncing`.
- `PATCH /api/connections/:id` — `ConnectionUpdateRequest` (`label`, `group`, `color`, `assistantAccess`, `signature`, `writingPreferences`) → `Connection`.
- `POST /api/connections/:id/sync` — starts a sync and returns the `Connection` immediately, normally with `status: "syncing"`. `409 reconnect_required` if credentials are invalid.
- `DELETE /api/connections/:id` → `ConnectionDeleted` `{ id, canceledActions }`. Revokes the grant where appropriate, cancels pending actions for the connection and removes its cached data. `409 conflict` when it is the sign-in identity and the only connection; the user deletes the account instead.

`Connection.permissions` has one entry per `ResourceKind` with `state` (`granted`, `denied`, `not_requested`, `admin_restricted`), the scopes behind it, and a `detail` sentence for anything but a plain grant. `Connection.sync` has one entry each for `mail`, `calendar`, `tasks`. `status: "reconnect_required"` is repaired by navigating to `/api/auth/google?mode=connect&accountId=<id>`.

## 11. Automations

Three templates: `daily_brief`, `follow_up`, `triage`. At most one automation per template per workspace.

- `GET /api/automations` → `ListResult<Automation>` (only the ones that exist).
- `POST /api/automations` — `AutomationCreateRequest` → `201 Automation`. `409 conflict` if the template already exists.
- `PATCH /api/automations/:id` — `AutomationUpdateRequest` → `Automation`. Disable with `enabled: false`.

`schedule` is `{ time: "HH:mm", days: number[], timezone }`. `follow_up` produces in-app reminders (surfaced in the brief's `waitingOn`); it never sends mail. `triage` produces `proposed` `modify_threads` actions for approval. `503 not_configured` when `capabilities.automations.available` is false.

### `GET /api/brief`

`Brief` for today in `settings.timezone`: `meetings`, `tasks` (due or overdue), `needsReply`, `waitingOn`, and `gaps`. `summary`/`headline` are model-written when the agent is configured (`generatedBy: "model"`), otherwise `null` with `generatedBy: "rules"`. `?refresh=1` rebuilds instead of returning the stored brief. Optional `accountId` limits the brief to the accounts selected in the sidebar.

## 12. Files, contacts, activity, account, health

### `GET /api/files` and `POST /api/files/actions`

Available only when `capabilities.files.available`; otherwise both answer `503 not_configured` (deployment) or `403 permission_missing` (the account has not granted Drive access). `GET` takes `FileListQuery` (`accountId`, `q`, `kind`) and lists files the app is authorised to see, newest first.

`POST` body is `FileActionRequest`, a union on `action`:

| `action` | Fields | Result |
| --- | --- | --- |
| `create` | `accountId`, `kind` (`doc`\|`sheet`\|`slides`), `name` | `file` = the new file |
| `rename` | `fileId`, `name` | `file` = renamed file |
| `copy` | `fileId`, `name?` | `file` = the copy |
| `trash` | `fileId` | `file: null`, `removedFileId` |
| `summarize` | `fileId` | `file`, `summary` (model text; needs `capabilities.agent`) |

### `GET /api/contacts`

`ContactListQuery` `{ q, accountId?, limit? }` → `ListResult<Contact>`. `q` shorter than 2 characters returns no items. With `settings.contactLookup` off, or without the contacts scope, the server still returns `origin: "recent"` suggestions from cached mail headers and no gap. Results are scoped to the requested accounts.

### `GET /api/activity`

`ListResult<ActivityEntry>`, newest first. Titles are redacted: no message bodies.

### `POST /api/account/delete`

Body `{ confirmEmail }`, which must equal `session.user.email` (case-insensitive) or the server answers `422`. Cancels pending work, revokes connections, deletes the workspace's app data, clears the session, and returns `{ deleted: true }`. Google data is untouched. In a demo session it discards the sandbox.

### `GET /api/health`

Unauthenticated. `Health` `{ status, version, time, checks }`. Returns `200` for `ok` and `degraded`, `503` for `down` — in both cases with the normal `{ data }` envelope so monitors and the UI read the same body.

## 13. What the frontend assumes

1. `GET /api/session` never returns 401.
2. Any `401 unauthenticated` from another endpoint means the session ended; the client drops to the sign-in screen.
3. Mutations return the updated resource so the UI can replace its copy without a refetch.
4. Lists include `gaps` rather than hiding failed sources.
5. `Action.preview` is complete enough to render the approval card with no further requests.
6. Nothing is sent, booked, deleted or shared by the assistant without an approved `Action`.
