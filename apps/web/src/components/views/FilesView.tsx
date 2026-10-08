'use client';

import clsx from 'clsx';
import { Copy, File as FileIcon, FileSpreadsheet, FileText, Folder, FolderOpen, Image as ImageIcon, MoreHorizontal, Pencil, Plus, Presentation, Search, Sparkles, Trash2, type LucideIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { canAct, hasPermission } from '@/lib/accounts';
import { api, ApiRequestError, toApiError } from '@/lib/api';
import { listTime, plural, safeHref } from '@/lib/format';
import { useDebounced, useNow, useResource, useShortcuts } from '@/lib/hooks';
import type { DriveFile, FileKind, Id } from '@/lib/types';
import { AccountDot, GapNotice, useApp } from '../AppContext';
import { AccountFilter } from '../Shell';
import { Button, ConfirmDialog, Dialog, EmptyState, ErrorState, Field, IconButton, Menu, Notice, SkeletonRows, Spinner } from '../ui';

const KIND_ICON: Record<FileKind, LucideIcon> = {
  doc: FileText,
  sheet: FileSpreadsheet,
  slides: Presentation,
  pdf: FileIcon,
  image: ImageIcon,
  folder: Folder,
  other: FileIcon,
};

const FILTERS: Array<{ id: FileKind | ''; label: string }> = [
  { id: '', label: 'All' },
  { id: 'doc', label: 'Docs' },
  { id: 'sheet', label: 'Sheets' },
  { id: 'slides', label: 'Slides' },
];

type Creatable = 'doc' | 'sheet' | 'slides';
const CREATABLE: Record<Creatable, string> = { doc: 'Doc', sheet: 'Sheet', slides: 'Slides' };

export function FilesView() {
  const { boot, account, scopeParam, scopeKey, toast, reportError, ask, openSettings } = useApp();
  const capability = boot.capabilities.files;
  const now = useNow();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 350);
  const [kind, setKind] = useState<FileKind | ''>('');
  const files = useResource(capability.available ? `files:${scopeKey}:${kind}:${q}` : null, (signal) =>
    api.files({ accountId: scopeParam, q: q || undefined, kind: kind || undefined, limit: 50 }, { signal }),
  );

  const [creating, setCreating] = useState<Creatable | null>(null);
  const [renaming, setRenaming] = useState<DriveFile | null>(null);
  const [trashing, setTrashing] = useState<DriveFile | null>(null);
  const [rowBusy, setRowBusy] = useState<Id | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useShortcuts((event) => {
    if (event.key === '/') {
      event.preventDefault();
      searchRef.current?.focus();
    }
  });

  const fileAccounts = boot.connections.filter((c) => canAct(c, 'files') && (!scopeParam || scopeParam.includes(c.id)));
  const missing = boot.connections.filter((c) => !hasPermission(c, 'files') && (!scopeParam || scopeParam.includes(c.id)));

  if (!capability.available) {
    return (
      <div className="mail">
        <header className="bar">
          <span className="bar__title">Files</span>
        </header>
        <div className="scroll">
          <EmptyState
            icon={<FolderOpen size={24} />}
            title="No account has shared its Drive yet"
            action={
              <Button variant="primary" size="sm" onClick={() => openSettings('accounts')}>
                Grant Drive access
              </Button>
            }
          >
            Docs, Sheets and Slides appear here once an account allows it. The agent can then read and summarise them.
          </EmptyState>
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
      } else files.reload();
    } catch (err) {
      reportError(err, 'Could not copy the file');
    } finally {
      setRowBusy(null);
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
      reportError(err, 'Could not trash the file');
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
    <div className="mail">
      <header className="bar">
        <div className="searchbar">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            className="searchbar__input"
            type="search"
            aria-label="Search files"
            placeholder="Search files"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setText('');
                event.currentTarget.blur();
              }
            }}
          />
          {files.refreshing && <Spinner size={14} />}
        </div>
        <div className="seg" role="group" aria-label="File type">
          {FILTERS.map((filter) => (
            <button key={filter.id || 'all'} type="button" className={clsx('seg__btn', kind === filter.id && 'is-active')} aria-pressed={kind === filter.id} onClick={() => setKind(filter.id)}>
              {filter.label}
            </button>
          ))}
        </div>
        <AccountFilter />
        <Menu
          label="New file"
          disabled={fileAccounts.length === 0}
          button={<Plus size={17} />}
          items={(Object.keys(CREATABLE) as Creatable[]).map((id) => ({ label: `New ${CREATABLE[id]}`, icon: (() => {
            const Icon = KIND_ICON[id];
            return <Icon size={15} />;
          })(), onSelect: () => setCreating(id) }))}
        />
      </header>

      <div className="scroll">
        <div className="column">
          {files.data && <GapNotice gaps={files.data.gaps} />}
          {missing.length > 0 && fileAccounts.length > 0 && !q && (
            <p className="quietnote">
              {plural(missing.length, 'account')} {missing.length === 1 ? 'has' : 'have'} not shared Drive.{' '}
              <button type="button" className="link-btn" onClick={() => openSettings('accounts')}>
                Grant access
              </button>
            </p>
          )}
          {files.loading && <SkeletonRows count={7} />}
          {files.error && !files.data && <ErrorState error={files.error} onRetry={files.reload} />}
          {files.data && items.length === 0 && (
            <EmptyState icon={q ? <Search size={22} /> : <FolderOpen size={22} />} title={q ? 'No files match' : 'No files yet'}>
              {q ? 'Search looks at file names in the selected accounts.' : 'Create a Doc, Sheet or Slides deck with the plus button.'}
            </EmptyState>
          )}
          {items.length > 0 && (
            <ul className="rows" aria-label="Files">
              {items.map((file) => {
                const Icon = KIND_ICON[file.kind] ?? FileIcon;
                const href = safeHref(file.url);
                const readable = file.kind === 'doc' || file.kind === 'sheet' || file.kind === 'slides';
                const main = (
                  <>
                    <AccountDot account={account(file.accountId)} size={7} />
                    <span className="row__from row__from--file">
                      <Icon size={15} aria-hidden="true" />
                    </span>
                    <span className="row__text">
                      <span className="row__subject">{file.name || '(untitled)'}</span>
                      <span className="row__summary">
                        {account(file.accountId)?.label}
                        {file.shared ? ' · shared' : ''}
                      </span>
                    </span>
                    <span className="row__marks" />
                    <time className="row__time num" dateTime={file.modifiedAt}>
                      {listTime(file.modifiedAt, now)}
                    </time>
                  </>
                );
                return (
                  <li key={file.id} className="row row--file">
                    {href ? (
                      <a className="row__main" href={href} target="_blank" rel="noopener noreferrer" title="Open in Google">
                        {main}
                      </a>
                    ) : (
                      <span className="row__main">{main}</span>
                    )}
                    <div className="row__actions">
                      {rowBusy === file.id ? (
                        <Spinner size={14} />
                      ) : (
                        <>
                          {readable && boot.capabilities.agent.available && (
                            <IconButton
                              label="Summarise with the agent"
                              onClick={() =>
                                ask({
                                  text: `Summarise “${file.name}”: the gist, decisions, and next steps.`,
                                  context: [{ kind: 'file', id: file.id, accountId: file.accountId, title: file.name, snippet: null, url: file.url, occurredAt: file.modifiedAt }],
                                  send: true,
                                })
                              }
                            >
                              <Sparkles size={15} />
                            </IconButton>
                          )}
                          <Menu
                            label={`Actions for ${file.name}`}
                            button={<MoreHorizontal size={15} />}
                            items={[
                              { label: 'Rename', icon: <Pencil size={14} />, onSelect: () => setRenaming(file) },
                              { label: 'Make a copy', icon: <Copy size={14} />, onSelect: () => void copy(file) },
                              { label: 'Move to trash', icon: <Trash2 size={14} />, danger: true, onSelect: () => setTrashing(file) },
                            ]}
                          />
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {files.data?.nextCursor && (
            <div className="more">
              <Button size="sm" variant="ghost" busy={moreBusy} onClick={loadMore}>
                Load more
              </Button>
            </div>
          )}
        </div>
      </div>

      {creating && (
        <NameDialog
          title={`New ${CREATABLE[creating]}`}
          confirmLabel="Create"
          accounts={fileAccounts.map((c) => ({ id: c.id, label: `${c.label} — ${c.email}` }))}
          defaultAccountId={fileAccounts.find((c) => c.id === boot.settings.defaultAccountId)?.id ?? fileAccounts[0]?.id}
          onClose={() => setCreating(null)}
          onSubmit={async (name, accountId) => {
            const result = await api.fileAction({ action: 'create', accountId: accountId!, kind: creating, name });
            if (result.file) {
              const created = result.file;
              files.mutate((current) => ({ ...current, items: [created, ...current.items] }));
              const href = safeHref(created.url);
              toast({ tone: 'ok', message: `Created “${created.name}”.`, action: href ? { label: 'Open', run: () => window.open(href, '_blank', 'noopener') } : undefined });
            } else files.reload();
          }}
        />
      )}

      {renaming && (
        <NameDialog
          title="Rename"
          confirmLabel="Rename"
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const result = await api.fileAction({ action: 'rename', fileId: renaming.id, name });
            if (result.file) {
              const renamed = result.file;
              files.mutate((current) => ({ ...current, items: current.items.map((item) => (item.id === renamed.id ? renamed : item)) }));
            } else files.reload();
          }}
        />
      )}

      {trashing && (
        <ConfirmDialog title="Move to trash?" confirmLabel="Move to trash" danger busy={trashBusy} onClose={() => setTrashing(null)} onConfirm={trash}>
          <p>
            “{trashing.name}” goes to the Drive trash of {account(trashing.accountId)?.email ?? 'its account'}. You can restore it from Google Drive.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

function NameDialog({
  title,
  confirmLabel,
  initialName = '',
  accounts,
  defaultAccountId,
  onClose,
  onSubmit,
}: {
  title: string;
  confirmLabel: string;
  initialName?: string;
  accounts?: Array<{ id: Id; label: string }>;
  defaultAccountId?: Id;
  onClose: () => void;
  onSubmit: (name: string, accountId: Id | undefined) => Promise<void>;
}) {
  const [name, setName] = useState(initialName);
  const [accountId, setAccountId] = useState<Id | undefined>(defaultAccountId);
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
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          <input className="input" type="text" value={name} onChange={(event) => setName(event.target.value)} data-autofocus />
        </Field>
        {accounts && accounts.length > 1 && (
          <Field label="Account">
            <select className="input" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
              {accounts.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {error && <Notice tone="danger">{error.message}</Notice>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
