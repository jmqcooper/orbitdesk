# Secrets and environment

`.env.schema` is the contract for every process: what each one reads, what is secret and what must be present. It holds no values.

| Where | Values come from | Checked by |
| --- | --- | --- |
| Development machine | Process env, `.env.local`, `.env`, then Infisical | `pnpm dev`, the worker's `dev` script, `pnpm exec varlock load --agent` |
| CI | The job's env | `pnpm build`, `pnpm test` |
| Railway web | Railway service variables | `next start`, which exits before it serves a request |
| Railway worker | Railway service variables | The start script, before the worker runs |
| `pnpm db:migrate`, `pnpm db:seed` | The same as the place they run | `varlock run` |

Infisical serves development machines only. It is off in CI, in Docker builds and on Railway, and the image does not contain `.env.infisical`, so a store outage or an expired identity cannot stop a deployed service.

A production start refuses to boot if a required value is missing or malformed: `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` and, on web, `APP_URL` and `SESSION_SECRET`. A build needs none of them.

## Set up a machine

Machines share one profile, `~/.config/varlock/.env.infisical`, holding only `INFISICAL_CLIENT_ID` and a locally encrypted `INFISICAL_CLIENT_SECRET`. Each repo names its own project in `.env.infisical`. The machine's identity needs Viewer access to the Orbitdesk project.

Without a profile nothing changes: `pnpm dev` says so and uses your local files. Once a profile exists, a refused or unreachable store stops `pnpm dev` and the worker instead of starting them with partial values. To work offline, set `ORBITDESK_SHARED_SECRETS=off`.

`.env` and `.env.local` stay yours and always win over the store. A blank line in them does not hide a store value. The store holds shared development config only: never a provider CLI login or a personal Google credential.

Varlock keeps its private key per user, whatever `HOME` says, and finds the session bus by itself. Never run Varlock under a temporary `HOME` without the `DBUS_SESSION_BUS_ADDRESS` from `tests/no-keyring.ts`, or it can replace the real key.

## Change a value

Add a new variable to `.env.schema` first; the tests fail on a variable the code reads that the schema does not name. Mark it `@sensitive=false` only if it can appear in logs or responses. Values in the store that the schema does not name are ignored.

Do not change `TOKEN_ENCRYPTION_KEY` on a deployment with connected accounts: their stored Google credentials can only be read with the key that encrypted them.

## Read values safely

```sh
pnpm exec varlock load --agent                                  # secrets redacted
pnpm --filter @orbitdesk/worker exec varlock load --agent       # another runtime
pnpm exec varlock explain APP_URL                               # where one value came from
```

`varlock load --format json`, `env` and `shell` print raw values. Leave them for commands that discard the output. Validation errors show the first two characters of a rejected secret, so treat them as logs, not as public text.

## Check a service before a release

This reads a service's variables into a local process, validates them against the schema and prints only the problems. It changes nothing.

```sh
railway run --service web -- sh -c "ORBITDESK_ENV_PROFILE=deployed pnpm --filter @orbitdesk/web exec varlock load --format json >/dev/null"
railway run --service worker -- sh -c "ORBITDESK_ENV_PROFILE=deployed APP_ROLE=worker pnpm --filter @orbitdesk/worker exec varlock load --format json >/dev/null"
```

## Scanning

`pnpm install` turns on `.githooks/pre-commit`. The hook copies the staged files out of the Git index into a private folder, scans that copy for this machine's secret values, and removes it, so it checks what the commit will hold and not the working copy. It prints one fixed line and never the match. It needs the store when a profile exists, so commit with `ORBITDESK_SHARED_SECRETS=off` when offline; that scan covers local values only.

The hook resolves the values once and scans for exactly those, including every runtime's secrets, the machine identity and any `.env` inside a package, which core and Prisma read directly. For Prisma's package files it also scans values after `${VAR}` expansion under both client generation's root environment and the database command's `#db` selection, while keeping literal values for Node callers. It stops the commit if `.env.schema` is missing or declares nothing, or if a local value breaks it. `pnpm exec varlock load --agent` names the value.

Commit from a normal terminal. Inside the credential proxy Varlock only has placeholders, so the hook refuses any commit with staged content, clean or not. It will not fetch real values there, and there is no scan bypass.

A `.env` copied from `.env.example` repeats that file's values, so a commit touching the example fails the scan until your `.env` holds different ones.

The Next build fails if a secret's value reaches `.next/static` or a prerendered page.

## Run an agent through the credential proxy

```sh
pnpm agent:proxy -- claude
```

The agent gets a placeholder or nothing for each secret. When it calls a host listed under a `@proxy` rule in `.env.schema`, Varlock swaps in the real value on that connection. `pnpm exec varlock proxy rules` lists what each secret becomes. Only OpenRouter has a rule, so Claude Code and Codex keep their own sign-in.

- Same user, same machine: this raises the bar, and only a sandbox makes it a boundary.
- Strict egress stays off. It would send subscription traffic through TLS interception.
- A placeholder cannot reach Postgres or vouch for a commit, so start `pnpm dev`, the worker and `pnpm db:migrate`, and commit, from a normal terminal beside the agent.
- It wraps a terminal launch. A session started by T3 Code or another host app is not wrapped.
