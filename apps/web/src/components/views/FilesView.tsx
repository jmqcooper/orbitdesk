'use client';

import clsx from 'clsx';
import {
  Copy,
  ExternalLink,
  File as FileIcon,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  MoreHorizontal,
  Pencil,
  Plus,
  Presentation,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { canAct, hasPermission } from '@/lib/accounts';
import { api, ApiRequestError, googleAuthUrl, toApiError } from '@/lib/api';
import { displayName, formatBytes, plural, relativeTime, safeHref } from '@/lib/format';
import { useDebounced, useResource } from '@/lib/hooks';
import type { DriveFile, FileKind, Id } from '@/lib/types';
import { AccountBadge, GapNotice, useApp } from '../AppContext';
import { Markdown } from '../assistant/Markdown';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  LoadingBlock,
  Menu,
  Notice,
  SkeletonRows,
  Spinner,
  StaleNotice,
  ViewHeader,
} from '../ui';

const KIND_META: Record<FileKind, { icon: LucideIcon; label: string }> = {
  doc: { icon: FileText, label: 'Doc' },
  sheet: { icon: FileSpreadsheet, label: 'Sheet' },
  slides: { icon: Presentation, label: 'Slides' },
  pdf: { icon: FileIcon, label: 'PDF' },
  image: { icon: ImageIcon, label: 'Image' },
  folder: { icon: Folder, label: 'Folder' },
  other: { icon: FileIcon, label: 'File' },
};

const FILTERS: Array<{ id: FileKind | ''; label: string }> = [
  { id: '', label: 'All' },
  { id: 'doc', label: 'Docs' },
  { id: 'sheet', label: 'Sheets' },
  { id: 'slides', label: 'Slides' },
  { id: 'pdf', label: 'PDFs' },
];

type Creatable = 'doc' | 'sheet' | 'slides';

export function FilesView() {
  const { boot, scopeParam, scopeKey, toast, reportError, navigate } = useApp();
  const capability = boot.capabilities.files;
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 350);
  const [kind, setKind] = useState<FileKind | ''>('');
  const key = `files:${scopeKey}:${kind}:${q}`;
  const files = useResource(capability.available ? key : null, (signal) =>
    api.files({ accountId: scopeParam, q: q || undefined, kind: kind || undefined, limit: 50 }, { signal }),
  );

  const [creating, setCreating] = useState<Creatable | null>(null);
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [trashing, setTrashing] = useState<DriveFile | null>(null);
  const [summary, setSummary] = useState<{ file: DriveFile; text: string | null; error: ApiRequestError | null } | null>(null);
  const [rowBusy, setRowBusy] = useState<Id | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);

  const fileAccounts = boot.connections.filter((c) => canAct(c, 'files') && (!scopeParam || scopeParam.includes(c.id)));
  const missing = boot.connections.filter((c) => !hasPermission(c, 'files') && (!scopeParam || scopeParam.includes(c.id)));

  if (!capability.available) {
    return (
      <div className="view view--narrow">
        <ViewHeader kicker="Files" title="Drive, Docs, Sheets and Slides" />
        <EmptyState
          icon={<FolderOpen size={24} />}
          title="Files are not available here"
          action={
            <Button onClick={() => navigate('#/settings/data')}>
              See system status
            </Button>
          }
        >
          {capability.reason ??
            'This deployment has not enabled the Drive integration. Mail, calendar and tasks work without it.'}
        </EmptyState>
        <div className="helpbox">
          <h2 className="helpbox__title">What this view does once it is enabled</h2>
          <ul>
            <li>Lists the files each account has let Orbitdesk see — files you pick, and files it creates for you.</li>
            <li>Creates a Doc, Sheet or Slides deck in the account you choose, and renames, copies or trashes files.</li>
            <li>Asks the assistant for a summary of a selected document.</li>
          </ul>
          <p>
            Access uses Google’s per-file permission (<code>drive.file</code>), so Orbitdesk never sees your whole Drive.
          </p>
        </div>
      </div>
    );
  }

  const copy = async (file: DriveFile) => {
    setRowBusy(file.id);
    try {
      const result = await api.fileAction({ action: 'copy', fileId: file.id });
      if (result.file) {
        const created = result.file;
        files.mutate((current) => ({ ...current, items: [created, ...current.items] }));
        toast({ tone: 'ok', message: `Copied as “${created.name}”.` });
      } else {
        files.reload();
      }
    } catch (err) {
      reportError(err, 'Could not copy the file');
    } finally {
      setRowBusy(null);
    }
  };

  const summarize = async (file: DriveFile) => {
    setSummary({ file, text: null, error: null });
    try {
      const result = await api.fileAction({ action: 'summarize', fileId: file.id });
      setSummary({ file, text: result.summary ?? '', error: null });
    } catch (err) {
      setSummary({ file, text: null, error: toApiError(err) });
    }
  };

  const trash = async () => {
    if (!trashing) return;
    setTrashBusy(true);
    try {
      const result = await api.fileAction({ action: 'trash', fileId: trashing.id });
      const removed = result.removedFileId ?? trashing.id;
      files.mutate((current) => ({ ...current, items: current.items.filter((item) => item.id !== removed) }));
      toast({ message: `Moved “${trashing.name}” to the Drive trash.` });
      setTrashing(null);
    } catch (err) {
      reportError(err, 'Could not move the file to trash');
    } finally {
      setTrashBusy(false);
    }
  };

  const loadMore = async () => {
    const cursor = files.data?.nextCursor;
    if (!cursor) return;
    setMoreBusy(true);
    try {
      const page = await api.files({ accountId: scopeParam, q: q || undefined, kind: kind || undefined, limit: 50, cursor });
      files.mutate((current) => ({
        items: [...current.items, ...page.items.filter((item) => !current.items.some((c) => c.id === item.id))],
        nextCursor: page.nextCursor,
        gaps: [...current.gaps, ...page.gaps],
      }));
    } catch (err) {
      reportError(err, 'Could not load more files');
    } finally {
      setMoreBusy(false);
    }
  };

  const items = files.data?.items ?? [];

  return (
    <div className="view view--files">
      <ViewHeader
        kicker={`Files · ${plural(fileAccounts.length, 'account')} with Drive access`}
        title="Files"
        aside={
          <Menu
            label="Create a file"
            buttonClassName="btn btn--primary"
            disabled={fileAccounts.length === 0}
            button={
              <>
                <Plus size={15} aria-hidden="true" />
                <span>New</span>
              </>
            }
            items={[
              { label: 'Google Doc', icon: <FileText size={15} />, onSelect: () => setCreating('doc') },
              { label: 'Google Sheet', icon: <FileSpreadsheet size={15} />, onSelect: () => setCreating('sheet') },
              { label: 'Google Slides', icon: <Presentation size={15} />, onSelect: () => setCreating('slides') },
            ]}
          />
        }
      >
        Search Drive files across the accounts you selected. File access and editing depend on the permissions granted by each account.
      </ViewHeader>

      <div className="filebar">
        <div className="searchfield" role="search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            className="searchfield__input"
            aria-label="Search files"
            placeholder="Search authorized files"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {text && (
            <button type="button" className="searchfield__clear" aria-label="Clear search" onClick={() => setText('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="seg" role="group" aria-label="File type">
          {FILTERS.map((filter) => (
            <button
              key={filter.id || 'all'}
              type="button"
              className={clsx('seg__btn', kind === filter.id && 'is-active')}
              aria-pressed={kind === filter.id}
              onClick={() => setKind(filter.id)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        {files.refreshing && <Spinner size={14} label="Refreshing" />}
        <IconButton label="Refresh" onClick={files.reload}>
          <RotateCw size={16} />
        </IconButton>
      </div>

      {missing.length > 0 && (
        <Notice
          tone="info"
          action={
            <a className="link-btn" href="#/connections">
              Manage permissions
            </a>
          }
        >
          {missing.length === 1 ? `${missing[0]!.label} has` : `${missing.length} accounts have`} not granted Drive access, so{' '}
          {missing.length === 1 ? 'its' : 'their'} files are not listed.
        </Notice>
      )}
      {files.data && <GapNotice gaps={files.data.gaps} />}
      {files.error && files.data && <StaleNotice error={files.error} onRetry={files.reload} />}
      {files.loading && <SkeletonRows count={8} />}
      {files.error && !files.data && <ErrorState error={files.error} onRetry={files.reload} />}

      {files.data && items.length === 0 && (
        <EmptyState icon={<FolderOpen size={22} />} title={q || kind ? 'No files match' : 'No files yet'}>
          {q || kind
            ? 'Only files these accounts have authorized are searched.'
            : 'Create a document with “New”, or open a file with Orbitdesk from Google Drive to make it appear here.'}
        </EmptyState>
      )}

      {items.length > 0 && (
        <div className="ftable" role="table" aria-label="Files">
          <div className="ftable__head" role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Account</span>
            <span role="columnheader">Owner</span>
            <span role="columnheader">Modified</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {items.map((file) => {
            const meta = KIND_META[file.kind] ?? KIND_META.other;
            const Icon = meta.icon;
            const href = safeHref(file.url);
            return (
              <div key={file.id} className="ftable__row" role="row">
                <span className="ftable__name" role="cell">
                  <span className={clsx('ficon', `ficon--${file.kind}`)} aria-hidden="true">
                    <Icon size={16} />
                  </span>
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="ftable__link">
                      {file.name}
                    </a>
                  ) : (
                    <span className="ftable__link">{file.name}</span>
                  )}
                  <span className="ftable__kind">
                    {meta.label}
                    {file.size ? ` · ${formatBytes(file.size)}` : ''}
                    {file.shared ? ' · shared' : ''}
                  </span>
                </span>
                <span role="cell">
                  <AccountBadge accountId={file.accountId} />
                </span>
                <span role="cell" className="ftable__muted">
                  {file.owner ? displayName(file.owner) : '—'}
                </span>
                <span role="cell" className="ftable__muted">
                  {relativeTime(file.modifiedAt)}
                </span>
                <span role="cell" className="ftable__actions">
                  {rowBusy === file.id ? (
                    <Spinner size={15} />
                  ) : (
                    <Menu
                      label={`Actions for ${file.name}`}
                      button={<MoreHorizontal size={16} />}
                      items={[
                        ...(href
                          ? [{ label: 'Open in Google', icon: <ExternalLink size={14} />, onSelect: () => window.open(href, '_blank', 'noopener') }]
                          : []),
                        {
                          label: boot.capabilities.agent.available ? 'Summarize' : 'Summarize (assistant unavailable)',
                          icon: <Sparkles size={14} />,
                          disabled: !boot.capabilities.agent.available || file.kind === 'folder' || file.kind === 'image',
                          onSelect: () => void summarize(file),
                        },
                        { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setRenaming(file) },
                        { label: 'Make a copy', icon: <Copy size={14} />, disabled: file.kind === 'folder', onSelect: () => void copy(file) },
                        'divider' as const,
                        { label: 'Move to trash', icon: <Trash2 size={14} />, danger: true, onSelect: () => setTrashing(file) },
                      ]}
                    />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {files.data?.nextCursor && (
        <div className="inbox__more">
          <Button busy={moreBusy} onClick={loadMore}>
            Load more files
          </Button>
        </div>
      )}

      {creating && (
        <NameDialog
          title={`New ${creating === 'doc' ? 'Google Doc' : creating === 'sheet' ? 'Google Sheet' : 'Google Slides deck'}`}
          confirmLabel="Create"
          initialName=""
          accounts={fileAccounts.map((c) => ({ id: c.id, label: `${c.label} — ${c.email}` }))}
          onClose={() => setCreating(null)}
          onSubmit={async (name, accountId) => {
            const result = await api.fileAction({ action: 'create', accountId: accountId!, kind: creating, name });
            if (result.file) {
              const created = result.file;
              files.mutate((current) => ({ ...current, items: [created, ...current.items] }));
              const href = safeHref(created.url);
              toast({
                tone: 'ok',
                message: `Created “${created.name}”.`,
                action: href ? { label: 'Open', run: () => window.open(href, '_blank', 'noopener') } : undefined,
              });
            } else {
              files.reload();
            }
          }}
        />
      )}

      {renaming && (
        <NameDialog
          title="Rename file"
          confirmLabel="Rename"
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const result = await api.fileAction({ action: 'rename', fileId: renaming.id, name });
            const renamed = result.file;
            if (renamed) files.mutate((current) => ({ ...current, items: current.items.map((item) => (item.id === renamed.id ? renamed : item)) }));
            else files.reload();
          }}
        />
      )}

      {trashing && (
        <ConfirmDialog
          title="Move to trash?"
          confirmLabel="Move to trash"
          danger
          busy={trashBusy}
          onClose={() => setTrashing(null)}
          onConfirm={trash}
        >
          <p>
            “{trashing.name}” moves to the Google Drive trash of the account below. It can be restored from Drive for 30
            days.
          </p>
          <p>
            <AccountBadge accountId={trashing.accountId} showEmail />
          </p>
        </ConfirmDialog>
      )}

      {summary && (
        <Dialog
          title={summary.file.name}
          size="lg"
          onClose={() => setSummary(null)}
          kicker={
            <>
              Summary by the assistant · <AccountBadge accountId={summary.file.accountId} />
            </>
          }
          footer={
            <>
              {safeHref(summary.file.url) && (
                <a className="btn btn--ghost dialog__foot-left" href={safeHref(summary.file.url)!} target="_blank" rel="noopener noreferrer">
                  <ExternalLink size={14} aria-hidden="true" />
                  <span>Open the file</span>
                </a>
              )}
              <Button variant="primary" onClick={() => setSummary(null)}>
                Done
              </Button>
            </>
          }
        >
          {summary.error ? (
            <ErrorState compact error={summary.error} onRetry={() => void summarize(summary.file)} />
          ) : summary.text === null ? (
            <LoadingBlock label="Reading the file and writing a summary" />
          ) : summary.text ? (
            <Markdown text={summary.text} />
          ) : (
            <p className="prose-sm">The assistant returned an empty summary for this file.</p>
          )}
        </Dialog>
      )}

      {fileAccounts.length === 0 && boot.capabilities.googleConnect.available && boot.connections[0] && (
        <p className="files__grant">
          No selected account has Drive access.{' '}
          <a className="link-btn" href={googleAuthUrl('connect', { accountId: boot.connections[0].id, features: ['files'] })}>
            Grant it for {boot.connections[0].label}
          </a>
        </p>
      )}
    </div>
  );
}

function NameDialog({
  title,
  confirmLabel,
  initialName,
  accounts,
  onClose,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  initialName: string;
  accounts?: Array<{ id: Id; label: string }>;
  onClose: () => void;
  onSubmit: (name: string, accountId: Id | undefined) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [accountId, setAccountId] = useState<Id | undefined>(accounts?.[0]?.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const submit = async () => {
    if (!name.trim() || (accounts && !accountId)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim(), accountId);
      onClose();
    } catch (err) {
      setError(toApiError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={title}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={submit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <input className="input" type="text" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
        </Field>
        {accounts && (
          <Field label="Create in" hint="The file is created in this account’s Drive.">
            <select className="input" value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && (
          <Notice tone="danger">
            {error.message} <span className="mono-note">({error.code})</span>
          </Notice>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
