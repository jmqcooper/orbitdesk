# Google account connections

Orbitdesk uses two distinct OAuth flows. Login requests OpenID, email and profile only. Connecting a Google account requests mail, Calendar and Tasks, with Contacts and Files available through additional consent. A login identity does not grant access to its mailbox automatically.

The hosted beta was configured on 6 October 2026 in Google Cloud project `orbitdesk-20261004`. The web OAuth client is named **Orbitdesk Railway production**. Its credentials are installed on both Railway app services. The external audience was published with **In production** status on the same day, and the owner signed in and renewed Gmail, Calendar and Tasks consent afterward. Orbitdesk's separate `BETA_EMAILS` allowlist still limits login to invited accounts. Contacts and Files require additional consent.

## Console configuration

1. Sign in to https://console.cloud.google.com/auth/overview?project=orbitdesk-20261004 as the project owner.
2. Set the app name to **Orbitdesk**, support email to `jmqcooper@gmail.com`, and the homepage to `https://web-production-cbebe.up.railway.app`.
3. Set the privacy URL to `/privacy` and terms URL to `/terms` on that domain. Add a developer contact email.
4. Choose an external audience. The hosted client is published with **In production** status. Keep separate development clients in a Testing project and add every Google identity participants will connect as a test user there, not just their login identity.
5. Create a web OAuth client. Authorized JavaScript origin: `https://web-production-cbebe.up.railway.app`. Authorized redirect URI: `https://web-production-cbebe.up.railway.app/api/auth/callback`. Add the matching localhost origin and redirect URI only to a separate development client.
6. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on both Railway app services. Never put the client secret in frontend variables or GitHub.

The login scope set is `openid email profile`. Connection scopes are defined in `packages/core/src/google.ts`. Gmail uses `gmail.modify`, Calendar uses `calendar.events`, `calendar.calendarlist.readonly` and `calendar.freebusy`, Tasks uses `tasks`. Contacts are read-only. Files combines app-created Drive file access, Drive read access, and Docs/Sheets/Slides editing. Consent is incremental and every connected account has its own encrypted refresh token.

Google's Testing status limits access to listed test users and expires Workspace grants and refresh tokens after seven days. The hosted client has left Testing, and the owner's consent was renewed after publishing. Production does not mean Google has verified the app: Workspace consent still displays an unverified-app warning, and Google caps unapproved sensitive/restricted scope grants at 100 users. See [Google's audience rules](https://support.google.com/cloud/answer/15549945?hl=en). Workspace admins can also block grants, and users can revoke them.

Branding verification was attempted after publishing. Google's automated review flagged that the homepage was not registered to the owner in Search Console. The deployment now serves the owner verification file at `/googlef20021edb120537e.html`. Google's console instructs waiting 24 hours after verifying ownership before retrying branding. Branding must be verified and published before submitting data access verification. A broad public release using restricted Gmail scopes also needs the applicable scope review, consent/workflow demonstration video and security assessment. See [Google's restricted-scope verification process](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

The owner-account checks include Google login and connection, successful initial Gmail import, saving/editing/reopening/deleting a real Gmail draft, verifying a real reply draft's thread headers, creating/deleting a self-only calendar event, and creating/completing/deleting a Google task. No real email was sent during these checks. See the [verification record](VERIFICATION.md).

Broader release checks still include a second real account, a live reply and scheduled send to a controlled recipient, externally edited Gmail draft conflicts, an attendee invitation and additional Contacts/Files consent. These checks cannot be replaced by sandbox or mocked API tests.

The first large mail sync exposed Gmail's per-minute quota. Background thread and draft reads are now paced, initial imports have a one-hour queue job lifetime, rate-limited reads use bounded exponential backoff, and mutations are never automatically replayed. Google quota denials are distinguished from permission denials. [Google's quota table](https://developers.google.com/workspace/gmail/api/reference/quota) and [error guide](https://developers.google.com/workspace/gmail/api/guides/handle-errors) explain the limits and 403 quota responses.

Sources: [Google web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [Gmail threading](https://developers.google.com/workspace/gmail/api/guides/threads), [Calendar free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query).
