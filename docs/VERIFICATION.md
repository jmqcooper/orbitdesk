# Verification record

Verified on 4 and 6 October 2026. [Hosted app](https://web-production-cbebe.up.railway.app) · [GitHub CI](https://github.com/jmqcooper/orbitdesk/actions).

## Automated checks

`pnpm typecheck`, `pnpm test` and `pnpm build` pass. The 36 integration checks use a real Postgres database. The 6 October local suite also passed in a fresh temporary database, which was removed afterward. They cover session and origin enforcement, workspace isolation, scoped account selection, Gmail-style sandbox search, exact-account brief caching, task CRUD, reply account routing, MIME reply headers/Bcc/attachments, stale drafts, approval races, replay protection, durable scheduling, uncertain provider outcomes, approved document edits, calendar dates/DST, encrypted credentials, HTML sanitization, paginated Gmail history and mail retention. New quota checks verify read backoff, bounded retries, no automatic send retry, distinct permission denials and independent per-service sync results. An actual queued-job check verifies the extended one-hour lifetime for initial mailbox imports. Search checks verify bounded Google result pagination, current provider folder membership despite stale cached labels, cache reuse and hydration of uncached older conversations.

Provider tests exercise the actual Google adapter against mocked Google responses. They verify outbound payloads and failure behavior; they are not evidence of live Gmail access.

## Live browser checks on Railway

The collaborative browser was used to perform these actions through the interface:

- Open an isolated sandbox containing 12 accounts and 8 calendars.
- Open a multi-message conversation, mark it read, create a reply-all from its original account, and autosave the draft. Reply-all excluded the account owner.
- Queue that exact message for approval, inspect its recipients/body, approve it, and see successful sandbox delivery in History.
- Ask the live model to find Alex Morgan’s Studio email, read it, and prepare a follow-up task linked to that email. The run made four successful tool calls. Approve the task and verify it appears in Studio with the source link.
- Create, edit and delete a calendar event; find open times across eight calendars.
- Recheck availability before booking. An edited time overlapping an existing event was blocked without a create request; a free time passed the same check and saved.
- Create and complete a task.
- Create, rename and trash a document.
- Schedule a sandbox email for a near-future time. Verify it moves from Queued to Done through the deployed Railway worker without another send request.
- Rebuild the morning brief with the live model. Check that its meeting times match the Calendar view in Europe/Amsterdam.
- Schedule a daily brief for 04:29 Europe/Amsterdam. The Railway worker completed it, saved a four-tool, read-only conversation and updated Today with the new brief. Turn the test automation off afterward.
- Disable assistant access for one account and verify its assistant selector is disabled. Restore access and verify the next brief includes all 12 accounts.
- Check the 390-pixel phone layout: document width matches the viewport, account navigation opens, and the account list scrolls independently of its footer. Check the search and Compose controls at 320 pixels too; both remain inside the viewport.

The hosted assistant also passed direct live Vertex AI probes. The runtime uses Gemini; Claude Opus 5.5 with extra-high reasoning designed the API contract and frontend using the requested Claude CLI.

The phone check used the desktop browser at a 390-pixel viewport. Native device verification was unavailable: the device host reported no iOS simulators, and Android SDK command-line tools were missing.

## Deployment

Railway runs separate web, worker and persistent Postgres services. Both app services deploy from public GitHub main. Database migrations run before web activation. The public health endpoint reports database and worker as healthy and the model as configured. OAuth configuration is reported separately.

## Owner-account verification on 6 October

Google sign-in and Workspace consent were completed in Google Chrome for the owner account. Both Railway services have the web OAuth credentials, and the health endpoint reports OAuth configured. Real Google Tasks create/complete/delete and Calendar self-only event create/delete passed. A Gmail draft was created, edited, saved, reopened with the changed body and deleted. A real notification conversation was opened and a reply draft saved; its Gmail thread ID, From identity, In-Reply-To and References were verified against the original message before discarding it. Temporary test objects were removed; no email was sent or attendee invited.

Live free/busy passed across eight personal and shared calendars. The two public holiday calendars did not expose free/busy; the app correctly reported incomplete availability when they were selected, and returned complete results when they were excluded. The live assistant made two read-only tool calls against the connected account and correctly reported its calendar names and open task count, without reading mail bodies or proposing changes.

The initial Gmail cache hit a 403 `rateLimitExceeded` response from Google's 6,000-unit per-user minute quota. The adapter previously treated every 403 as a permission denial, and one service failure also made successful Tasks sync look unreadable. The deployed fix paces background mail reads, backs off rate-limited reads without replaying mutations, and reports service sync results independently.

The quota-paced initial import also exceeded pg-boss's default fifteen-minute job lifetime. Sync jobs now have a one-hour lifetime so this mailbox can finish its initial import before the queue schedules a retry.

The initial Gmail import completed at 19:15 UTC with 927 cached threads and a committed Gmail history cursor. Mail, Calendar and Tasks all reported successful sync with no errors. The real inbox populated in Chrome after refresh.

A broad Google search exposed unnecessary downloads of cached conversations and scans of the complete search history before returning the first screen. Search now reads only enough Google results for the requested page, applies folder and label filters at Google, uses Google's IDs for membership, reuses synced previews, loads uncached conversations with bounded concurrency and fetches the full current conversation when opened.

The 6 October sandbox browser checks were recorded. They covered a reply-all from its original account, simulated delivery into the same thread, a live assistant reading only the selected Studio account and proposing a source-linked task, explicit approval before task creation, cross-calendar availability and conflict rejection. The local recording is eight minutes at original speed; a two-minute 4x version is available with the thread's artifacts. It contains simulated account data.

## Remaining live verification

The beta currently has one verified real Google account. A second real account, delivery of real threaded replies and scheduled sends, attendee invitations, external draft conflicts and Contacts/Files grants remain separate live release checks. [Google setup](GOOGLE-SETUP.md) contains the callback URL, scope definitions and beta configuration.

Public SaaS launch still requires Google approval for the requested scopes, billing and broader operational validation. Chat, Forms, Keep, Admin and organization-wide delegation are outside this beta.
