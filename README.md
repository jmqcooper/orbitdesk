# Orbitdesk

Your inbox, already handled. Orbitdesk brings the mail, calendars, tasks and files of every Google account you have into one place. An agent sorts new mail into three lanes and writes the replies in your voice; you read, tweak and send.

**[Open the app](https://web-production-cbebe.up.railway.app)** · **[Full product scope](MVP-SCOPE.md)** · **[API contract](docs/API-CONTRACT.md)** · **[Verification record](docs/VERIFICATION.md)**

The public sandbox creates a separate workspace for every visitor, with 12 simulated accounts and 8 calendars. It opens already sorted, with sample drafts prepared, so the flow is visible at once; anything you ask the agent there runs on the real model. Sandbox sends and Google changes are simulated and never affect real accounts.

![A conversation in Orbitdesk with the agent's summary and a prepared reply](docs/images/orbitdesk.png)

## How it works

- **Three lanes instead of one inbox.** New mail is sorted into *Reply* (someone is waiting on you), *FYI* (worth reading) and *Other* (bulk and automated), each with a one-line summary. Mail you sent that still expects an answer is tracked under *Waiting on others*.
- **The draft is already there.** Every conversation in *Reply* gets a real Gmail draft in its own account, written in your voice. Open it, press `⌘↵`, and you are in the next one. Tell the agent what to change in a few words, or write it yourself.
- **One agent, everywhere.** `⌘J` opens the agent beside whatever you are looking at: today's meetings and due tasks, anything waiting for your OK, and a chat that can search mail, check calendars, read Docs and prepare changes.
- **Nothing leaves without you.** The agent sorts and drafts on its own. Sending, inviting, cancelling and deleting always wait for your click.
- **Keyboard first.** `J`/`K` to move, `↵` to open, `E` to archive, `Tab` for the next lane, `⌘K` for everything else. Press `?` for the full list.

Setup is two screens: connect your Google accounts, then paste a voice guide or persona prompt (or just describe yourself).

## Features

- Account-specific permissions, sending identities, signatures, writing preferences and agent access.
- Sorted inbox, full conversations, replies, reply-all, forwarding, drafts, attachments, archive, labels, stars and trash.
- Immediate or scheduled sends bound to an immutable draft snapshot. A changed draft requires a new decision.
- Calendar agenda/week view, event editing, all-day dates, attendees, Meet links, RSVP and availability across calendars.
- Task lists, tasks, completion, deadlines and source links.
- Drive search, create/copy/rename/trash and summaries. Assistant tools also read Docs, Sheets and Slides and propose document edits.
- A tool-calling agent with actual tool traces, source references, conversations and approval cards.
- Background sorting and reply drafting after every sync, plus optional morning briefs and follow-up drafts. Automated external changes always need review.
- Durable Postgres actions, a pg-boss worker, atomic execution claims, heartbeat and uncertain-outcome handling.
- Isolated sessions, encrypted Google credentials, workspace-scoped resources, validation, HTML sanitization, usage limits and account deletion.

The hosted beta has Google sign-in enabled. Gmail, Calendar and Tasks have been connected and tested with the owner account. Google OAuth is published with **In production** status; Orbitdesk still limits sign-in to invited accounts. Google branding and scope verification are pending, so Workspace consent still displays an unverified-app warning and has Google's 100-user cap. See [Google setup](docs/GOOGLE-SETUP.md). The public sandbox remains available without a Google account. Chat, Forms, Keep, Admin Console and organization-wide delegation are outside this release. Google Meet is supported through Calendar conferences; meeting recordings and transcripts are not included.

## Run locally

Requires Node 24, pnpm 11 and Docker.

```sh
cp .env.example .env
pnpm install
docker compose up -d
pnpm db:generate
pnpm db:migrate
```

Set `SESSION_SECRET` to a random string of at least 32 characters and `TOKEN_ENCRYPTION_KEY` to a base64-encoded 32-byte random key. For example, `openssl rand -base64 32` produces an encryption key. Add an OpenRouter key to turn the agent on.

Start the two processes in separate terminals:

```sh
pnpm dev
pnpm --filter @orbitdesk/worker dev
```

Open http://localhost:3100 and choose the sandbox, or configure Google OAuth and sign in. Development loads the root `.env`; do not commit that file.

## Models

Every model call goes through [OpenRouter](https://openrouter.ai), with two roles:

| Role | Default | Used for |
| --- | --- | --- |
| Fast | `typesafe/jev-router` | Quick classifications and yes/no decisions: which lane a conversation belongs in, whether a sent message still expects a reply, whether it holds a task. |
| Agent | `z-ai/glm-5.3-flash` | Multi-step tool work: drafting replies, the agent panel, briefs, summaries. |

Set `OPENROUTER_API_KEY`. Override the models with `AI_FAST_MODEL` and `AI_AGENT_MODEL`; any OpenRouter model that supports structured output (fast) and tool calling (agent) works. Without a key the agent is simply off: the app still works as a multi-account client and nothing is sent to a model.

Mail is private. OpenRouter forwards each request to an upstream provider, whose data terms then apply. Set `OPENROUTER_DATA_COLLECTION=deny` (or the equivalent setting on your OpenRouter account) to route only to providers that do not retain or train on prompts, and confirm both models still resolve under that policy before relying on it.

What is sent, and when:

- **Sorting** runs after each sync for accounts that allow the agent: sender, subject and up to about 1,600 characters of the latest message per new conversation, in batches of ten.
- **Drafting** runs for conversations in *Reply* whose latest message is under a week old: that conversation's recent messages. Older ones get a draft when you ask. A background draft may check free/busy and nothing else; it cannot read other mail. A draft you ask for can also search mail and read events.
- **The agent panel** sends what its tools read for your question.

Both background jobs can be switched off in Settings › Agent. Recipients of a prepared reply always come from the message headers, never from the model.

`MAX_AGENT_RUNS_PER_DAY` defaults to 100 per real workspace; `MAX_TRIAGE_PER_DAY` (600 conversations) and `MAX_AUTO_DRAFTS_PER_DAY` (50) cap the background work. Demo workspaces get 10 runs each, and `DEMO_RUNS_PER_DAY` caps all public demo runs at 100 per UTC day. These counts include failed attempts. Demo data expires after one day.

## Deploy on Railway

Create three services in one project: **Postgres**, **web** and **worker**. Connect web and worker to this repository; both use the root Dockerfile.

Set these on both app services:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://YOUR-WEB-DOMAIN
NODE_ENV=production
PORT=3100
ENABLE_DEMO=true
BETA_EMAILS=you@example.com
SESSION_SECRET=YOUR_RANDOM_SECRET
TOKEN_ENCRYPTION_KEY=YOUR_BASE64_KEY
```

Add `OPENROUTER_API_KEY` and Google OAuth configuration using Railway secrets. Set `APP_ROLE=web` on web and `APP_ROLE=worker` on worker. Give web the pre-deploy command `pnpm db:migrate` and healthcheck `/api/health`. Deploy web first, then worker. Keep both services awake for scheduled work. Expose only web; Postgres and worker stay on the private network.

The worker runs TypeScript through `tsx`. The web app uses a production Next.js build. The Dockerfile installs locked dependencies and runs Prisma generation, the frontend build and worker type checking. Persistent state is in Postgres; containers require no persistent volume.

`/api/health` reports database, worker, OAuth configuration and model configuration independently. Missing OAuth does not hide the sandbox. A stale worker is shown as unavailable for schedules and background sorting; the inbox then offers a *Sort now* button instead.

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
```

Tests require a migrated Postgres database and test/development session and encryption secrets. Integration checks cover tenant isolation, approval races, replay protection, stale drafts, scheduled recovery, calendar dates/DST, encrypted credentials, paginated Gmail history, and the sorting and drafting agent against a mocked OpenRouter endpoint. CI provisions an isolated Postgres service and runs the same checks.

The API layer lives in `packages/core`; `apps/web` renders its shared contract; `apps/worker` runs durable work. External Google calls are made only server-side. The model cannot supply a workspace id, credential, arbitrary HTTP endpoint or approval.

## Open source

MIT licensed. Postiz inspired the connection-adapter, scheduling and review patterns. This is an independent implementation and contains no copied Postiz code. The API contract and frontend were designed with Claude Opus 5.5 using extra-high reasoning; the backend and verification were built with Codex.

The next SaaS milestones are Google verification, billing, invitations/team roles, provider webhooks and broader Workspace integrations. The current application has per-user workspace isolation, but it is not a finished enterprise Workspace suite.
