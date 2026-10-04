# Verification record

Verified on 4 October 2026. [Hosted app](https://web-production-cbebe.up.railway.app) · [GitHub CI](https://github.com/jmqcooper/orbitdesk/actions).

## Automated checks

`pnpm typecheck`, `pnpm test` and `pnpm build` pass. The 25 integration checks use a real Postgres database. They cover session and origin enforcement, workspace isolation, scoped account selection, Gmail-style sandbox search, exact-account brief caching, task CRUD, reply account routing, MIME reply headers/Bcc/attachments, stale drafts, approval races, replay protection, durable scheduling, uncertain provider outcomes, approved document edits, calendar dates/DST, encrypted credentials, HTML sanitization, paginated Gmail history and mail retention.

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

## Remaining live verification

Real Google OAuth is not configured. Google Cloud Console requires the owner’s passkey before a web OAuth client can be created. The Workspace APIs are enabled in the beta project, but the authenticated gcloud CLI cannot perform this web-client setup through its supported commands.

After that identity challenge, the client credentials must be installed in Railway and live checks must be run against two real Google accounts. Sandbox sends never deliver real mail. [Google setup](GOOGLE-SETUP.md) contains the exact project, callback URL, scopes, beta configuration and live-test checklist.

Public SaaS launch still requires Google approval for the requested scopes, billing and broader operational validation. Chat, Forms, Keep, Admin and organization-wide delegation are outside this beta.
