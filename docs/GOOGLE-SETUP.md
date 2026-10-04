# Google account connections

Orbitdesk uses two distinct OAuth flows. Login requests OpenID, email and profile only. Connecting a Google account requests mail, Calendar and Tasks, with Contacts and Files available through additional consent. A login identity does not grant access to its mailbox automatically.

The Google Cloud project created for this beta is `orbitdesk-20261004`. Its Workspace APIs have been enabled. A **Web application** OAuth client still needs to be created in Google Auth Platform. Google's Cloud Console currently requires the account owner's passkey; the authenticated gcloud CLI cannot create a general Workspace web OAuth client through its supported commands.

## Console configuration

1. Sign in to https://console.cloud.google.com/auth/overview?project=orbitdesk-20261004 as the project owner.
2. Set the app name to **Orbitdesk**, support email to `jmqcooper@gmail.com`, and the homepage to `https://web-production-cbebe.up.railway.app`.
3. Set the privacy URL to `/privacy` and terms URL to `/terms` on that domain. Add a developer contact email.
4. Choose an external audience and testing status for the invite-only beta. Add every Google identity beta participants will connect as a test user, not just their login identity.
5. Create a web OAuth client. Authorized JavaScript origin: `https://web-production-cbebe.up.railway.app`. Authorized redirect URI: `https://web-production-cbebe.up.railway.app/api/auth/callback`. Add the matching localhost origin and redirect URI only to a separate development client.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on both Railway app services. Never put the client secret in frontend variables or GitHub.

The login scope set is `openid email profile`. Connection scopes are defined in `packages/core/src/google.ts`. Gmail uses `gmail.modify`, Calendar uses `calendar.events`, `calendar.calendarlist.readonly` and `calendar.freebusy`, Tasks uses `tasks`. Contacts are read-only. Files combines app-created Drive file access, Drive read access, and Docs/Sheets/Slides editing. Consent is incremental and every connected account has its own encrypted refresh token.

OAuth testing has Google-imposed user and token-lifetime limits. A public SaaS launch using restricted Gmail scopes needs the applicable Google verification and security assessment before broad release. Invite-only branding does not itself waive those requirements. Workspace admins can also block grants.

After configuration, verification must include real Google accounts: connect two accounts, synchronize, reply to a real multi-message thread, save/edit a Gmail draft outside Orbitdesk to check conflicts, schedule a send, create an event with attendees, check live free/busy, and create/complete a Google task. These live checks cannot be replaced by the sandbox or mocked API tests.

Sources: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads), [Calendar free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
