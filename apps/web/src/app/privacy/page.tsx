import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage, type LegalSection } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'What Orbitdesk reads from your Google accounts, what it stores, what is sent to a model provider, and how to delete it.',
};

const sections: LegalSection[] = [
  {
    id: 'what-we-access',
    title: 'What Orbitdesk accesses',
    body: (
      <>
        <p>
          Orbitdesk only reads a Google account after you link it through Google’s own consent screen. Each account is
          linked separately, and each capability is requested only when you turn it on.
        </p>
        <table>
          <thead>
            <tr>
              <th scope="col">Capability</th>
              <th scope="col">Google permission</th>
              <th scope="col">Used for</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Sign-in</td>
              <td>
                <code>openid</code>, <code>email</code>, <code>profile</code>
              </td>
              <td>Identifying you and showing the verified address of each account.</td>
            </tr>
            <tr>
              <td>Mail</td>
              <td>
                <code>gmail.modify</code>
              </td>
              <td>
                Listing and reading conversations, drafts, labels, archive and trash, and sending the messages you
                approve. Orbitdesk does not request permanent-delete access.
              </td>
            </tr>
            <tr>
              <td>Calendar</td>
              <td>
                <code>calendar.events</code>, <code>calendar.calendarlist.readonly</code>,{' '}
                <code>calendar.freebusy</code>
              </td>
              <td>Showing events, checking availability, and creating or changing events you approve.</td>
            </tr>
            <tr>
              <td>Tasks</td>
              <td>
                <code>tasks</code>
              </td>
              <td>Showing and editing your task lists and tasks.</td>
            </tr>
            <tr>
              <td>Contacts (optional)</td>
              <td>
                <code>contacts.readonly</code>
              </td>
              <td>Suggesting recipients while you type. Never written to.</td>
            </tr>
            <tr>
              <td>Files (optional)</td>
              <td>
                <code>drive.file</code>, <code>drive.readonly</code>, <code>documents</code>, <code>spreadsheets</code>, <code>presentations</code>
              </td>
              <td>Searching and reading Drive files, creating files, and editing Docs, Sheets and Slides after you approve. Drive metadata changes are limited by the granted scopes and Google file permissions.</td>
            </tr>
          </tbody>
        </table>
        <p>
          Connections &amp; settings shows, per account, exactly which permissions were granted, denied or blocked by a
          Workspace administrator.
        </p>
      </>
    ),
  },
  {
    id: 'what-we-store',
    title: 'What is stored, and for how long',
    body: (
      <>
        <p>Google stays the source of truth. Orbitdesk keeps a working copy so the app is fast and actions are durable:</p>
        <ul>
          <li>
            <strong>Mail cache.</strong> Headers, labels and bodies of recent mail (30 days by default). Older mail is
            fetched from Google on demand. The worker purges expired mail hourly, except conversations needed by working drafts or pending approvals.
          </li>
          <li>
            <strong>Calendar and task cache.</strong> Events in the ranges you view and your task lists.
          </li>
          <li>
            <strong>Attachments.</strong> Uploaded attachments are placed in a Gmail draft in your mailbox and kept in the working draft and exact send snapshot stored by Orbitdesk.
          </li>
          <li>
            <strong>Actions and approvals.</strong> The exact content you approved, its hash, and the outcome, so a
            scheduled send can be verified before it runs.
          </li>
          <li>
            <strong>Activity log.</strong> A redacted record of what happened (90 days by default). It contains titles
            and outcomes, never message bodies.
          </li>
          <li>
            <strong>Credentials.</strong> Google refresh tokens, encrypted at the application layer with keys held
            outside the database.
          </li>
        </ul>
        <p>
          Assistant conversations, drafts and approval records remain until you delete the workspace. Demo workspaces are deleted after one day. The current defaults are shown under Connections &amp; settings → Data &amp; privacy.
        </p>
      </>
    ),
  },
  {
    id: 'assistant',
    title: 'The assistant and model providers',
    body: (
      <>
        <p>
          When you ask the assistant something, Orbitdesk sends the parts of your mail, events and tasks needed to answer
          that request to the model provider configured for the deployment. It sends only content from the accounts you
          selected for that question.
        </p>
        <ul>
          <li>This hosted beta uses Vertex AI on a billed project, whose service does not train general-purpose models on your content. Self-hosted operators must choose an appropriate provider agreement.</li>
          <li>
            Email, attachments and documents are treated as data. Text inside them cannot grant permissions, widen the
            set of accounts, or instruct the assistant to send information elsewhere.
          </li>
          <li>
            The assistant cannot send, invite, cancel or delete on its own. Those actions are shown to you with their
            exact content and wait for approval.
          </li>
        </ul>
        <p>If no model provider is configured, the assistant is unavailable and no content is sent to one.</p>
      </>
    ),
  },
  {
    id: 'google-policy',
    title: 'Google API Services User Data Policy',
    body: (
      <p>
        Orbitdesk’s use and transfer of information received from Google APIs adheres to the{' '}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements. Google user data is used only to provide the features you see in the
        app, is not sold, and is not used for advertising.
      </p>
    ),
  },
  {
    id: 'sharing',
    title: 'Who it is shared with',
    body: (
      <ul>
        <li>
          <strong>Google</strong>, to carry out the reads and the actions you approve.
        </li>
        <li>
          <strong>The model provider</strong> configured for the deployment, for assistant requests only.
        </li>
        <li>
          <strong>The hosting provider</strong> that runs the application and its database.
        </li>
      </ul>
    ),
  },
  {
    id: 'tracking',
    title: 'Tracking and remote content',
    body: (
      <p>
        Remote images in email are removed by the server. Email links remain clickable, so following a sender’s link can still reveal activity to that sender.
        Email HTML is sanitised and displayed in an isolated frame where scripts cannot run. Orbitdesk does not record
        the content of your mail as analytics.
      </p>
    ),
  },
  {
    id: 'demo',
    title: 'The sandbox demo',
    body: (
      <p>
        The demo creates an isolated workspace of simulated accounts and messages. It does not connect to Google, does
        not deliver email, and is not shared with other visitors. Anything typed into the demo assistant is sent to the
        configured model provider like any other assistant request.
      </p>
    ),
  },
  {
    id: 'your-controls',
    title: 'Your controls',
    body: (
      <ul>
        <li>
          <strong>Limit the assistant.</strong> Choose per account whether the assistant may read it, and per question
          which accounts it uses.
        </li>
        <li>
          <strong>Disconnect an account.</strong> This revokes Orbitdesk’s access where Google allows, cancels pending
          actions for it, and removes its cached data.
        </li>
        <li>
          <strong>Delete everything.</strong> Connections &amp; settings → Data &amp; privacy deletes your workspace and
          all Orbitdesk data. Your Gmail, Calendar and Tasks data in Google is not affected. Backups expire on the
          operator’s documented schedule.
        </li>
        <li>
          You can also remove access at any time from your{' '}
          <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">
            Google Account permissions
          </a>
          .
        </li>
      </ul>
    ),
  },
  {
    id: 'contact',
    title: 'Questions',
    body: (
      <p>
        Orbitdesk is open source, so the behaviour described here can be checked against the code. For privacy
        questions about a particular deployment, contact whoever operates it. See also the <Link href="/terms">terms</Link>.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      kicker="Privacy"
      title="Privacy policy"
      updated="October 4, 2026"
      sections={sections}
      intro={
        <p>
          Orbitdesk brings several Google accounts into one workspace. That only works if it is clear what the app can
          see, what it keeps, and what it does on your behalf. This page describes each of those plainly.
        </p>
      }
    />
  );
}
