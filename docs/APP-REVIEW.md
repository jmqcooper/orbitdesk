# Practical MVP review

Reviewed by GPT-6 Astra on 6 October 2026 at commit `5b64469`. This was a source review with one pure HTML-sanitizer probe, not a new live browser or Google-account test. No source, deployment or owner data was changed by the reviewer. The existing live checks are in [VERIFICATION.md](VERIFICATION.md).

| Priority | Finding | Smallest useful change |
| --- | --- | --- |
| P1 | Editing a recurring occurrence as “Every event in the series” can erase the master's recurrence and move its dates. Occurrences lack the master's recurrence array, so the form initializes Repeat to none and sends `recurrence: null`. | Load the master for series edits, preserve recurrence by default and patch only deliberately changed fields. Add a title-only edit regression from a later occurrence. |
| P1 | Incoming HTML sanitization removes every image, so “Show images” cannot recover image-only tickets, QR codes or newsletters. A pure probe confirmed removal, including alternative text. | Preserve safe image metadata, keep remote loading opt-in and support inline attachment images. |
| P2 | Refreshing or closing a browser tab before the 1.6-second draft autosave can lose recent text. Failed/offline saves have no page-exit recovery. | Warn while dirty or saving; add a small local recovery copy for failed saves. |
| P2 | The draft list requests 60 rows without search or continuation, leaving older drafts inaccessible. | Render load-more using the existing `nextCursor`. |
| P2 | Deleting a parent task hides descendants in the UI but deletes only the parent cache row. Reload can promote remaining subtasks to roots until sync; sandbox rows persist. | Remove/reconcile descendant cache rows after successful deletion and mention subtasks in confirmation. |
| P2 | Inbox cleanup is one conversation at a time, with no multi-select or bulk actions. | Add visible-row selection and bulk archive/read/trash, reporting per-account outcomes. |

Source evidence: recurring edits in [EventDialog.tsx](../apps/web/src/components/calendar/EventDialog.tsx) around lines 452 and 585 and [workspace.ts](../packages/core/src/workspace.ts) around lines 116–125; images in [google.ts](../packages/core/src/google.ts), [security.ts](../packages/core/src/security.ts) and [MessageBody.tsx](../apps/web/src/components/mail/MessageBody.tsx); draft autosave in [Composer.tsx](../apps/web/src/components/mail/Composer.tsx) around line 298; draft continuation and bulk actions in [InboxView.tsx](../apps/web/src/components/views/InboxView.tsx) around lines 112, 355 and 494; subtask deletion in [TasksView.tsx](../apps/web/src/components/views/TasksView.tsx) around lines 156 and 284 and `workspace.ts` around line 147. Line numbers refer to the reviewed commit.

Recommended next work: fix recurring-series edits, make real email images readable, then complete a controlled two-account mail/calendar round trip before widening the beta. Second-account access, real reply/scheduled delivery, invitations, external draft conflicts, Contacts/Files grants and native-phone behavior remain release checks, not established bugs. Google publishing is tracked separately in [GOOGLE-SETUP.md](GOOGLE-SETUP.md).
