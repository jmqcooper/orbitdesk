'use client';

import clsx from 'clsx';
import { TriangleAlert, Check, RotateCw, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import type { ApiRequestError } from '@/lib/api';
import { useDismiss } from '@/lib/hooks';

/* ---------------- Orbit mark ---------------- */

export function OrbitMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={clsx('orbit-mark', className)}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="16" cy="16" rx="13.2" ry="6.1" transform="rotate(-28 16 16)" stroke="currentColor" strokeWidth="1.5" />
      <ellipse cx="16" cy="16" rx="13.2" ry="6.1" transform="rotate(32 16 16)" stroke="currentColor" strokeWidth="1.5" opacity="0.42" />
      <circle cx="16" cy="16" r="3.4" fill="currentColor" />
      <circle cx="27.4" cy="9.6" r="2.5" fill="var(--accent)" />
    </svg>
  );
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" style={{ width: size, height: size }} role={label ? 'status' : undefined} aria-label={label}>
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.2" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/* ---------------- Buttons ---------------- */

type ButtonVariant = 'primary' | 'accent' | 'outline' | 'ghost' | 'danger';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  busy?: boolean;
}

export function Button({ variant = 'outline', size = 'md', icon, busy, children, className, disabled, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={clsx('btn', `btn--${variant}`, size === 'sm' && 'btn--sm', className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner size={14} /> : icon}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  busy?: boolean;
}

export function IconButton({ label, active, busy, children, className, disabled, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={clsx('icon-btn', active && 'is-active', className)}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Spinner size={15} /> : children}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/* ---------------- Dialog ---------------- */

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Subtitle rendered under the title. */
  kicker?: ReactNode;
  className?: string;
  /** Render only `children` (no header or footer); `title` becomes the accessible name. */
  bare?: boolean;
}

/**
 * Modal built on the native <dialog>: the browser provides the focus trap, the
 * inert background and Escape. Mount it to open; unmount to close.
 */
export function Dialog({ title, onClose, children, footer, size = 'md', kicker, className, bare }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    // showModal() focuses the first control (the close button). A dialog can name a better
    // starting point with `data-autofocus`; React's autoFocus runs before the dialog is open.
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      // Removing a dialog does not restore focus on its own.
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={clsx('dialog', `dialog--${size}`, className)}
      aria-labelledby={bare ? undefined : titleId}
      aria-label={bare ? title : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      onMouseDown={(event) => {
        if (event.target === ref.current) onCloseRef.current();
      }}
    >
      {bare ? (
        <div className="dialog__box">{children}</div>
      ) : (
      <div className="dialog__box">
        <header className="dialog__head">
          <div>
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            {kicker && <div className="dialog__kicker">{kicker}</div>}
          </div>
          <IconButton label="Close" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__foot">{footer}</footer>}
      </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
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
          <Button variant={danger ? 'danger' : 'primary'} busy={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="prose-sm">{children}</div>
    </Dialog>
  );
}

/* ---------------- Popover and menu ---------------- */

interface PopoverProps {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  className?: string;
  panelClassName?: string;
}

export function Popover({ open, onClose, trigger, children, align = 'start', side = 'bottom', className, panelClassName }: PopoverProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, open, onClose);
  return (
    <span ref={ref} className={clsx('pop', className)}>
      {trigger}
      {open && (
        <div className={clsx('pop__panel', `pop__panel--${align}`, `pop__panel--${side}`, panelClassName)}>{children}</div>
      )}
    </span>
  );
}

export interface MenuItem {
  key?: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  label: string;
  button: ReactNode;
  items: Array<MenuItem | 'divider'>;
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  buttonClassName?: string;
  disabled?: boolean;
}

export function Menu({ label, button, items, align = 'end', side = 'bottom', buttonClassName, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next = index;
    if (event.key === 'ArrowDown') next = (index + 1) % buttons.length;
    if (event.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    buttons[next]?.focus();
  };

  return (
    <Popover
      open={open}
      onClose={() => close(true)}
      align={align}
      side={side}
      panelClassName="menu"
      trigger={
        <button
          ref={buttonRef}
          type="button"
          className={buttonClassName ?? 'icon-btn'}
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((value) => !value)}
        >
          {button}
        </button>
      }
    >
      <div ref={listRef} role="menu" aria-label={label} onKeyDown={onKeyDown}>
        {items.map((item, index) =>
          item === 'divider' ? (
            <div key={`divider-${index}`} className="menu__divider" role="separator" />
          ) : (
            <button
              key={item.key ?? item.label}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className={clsx('menu__item', item.danger && 'menu__item--danger')}
              disabled={item.disabled}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              <span className="menu__icon">{item.checked ? <Check size={15} /> : item.icon}</span>
              <span className="menu__label">{item.label}</span>
              {item.hint && <span className="menu__hint">{item.hint}</span>}
            </button>
          ),
        )}
      </div>
    </Popover>
  );
}

/* ---------------- Form bits ---------------- */

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
  describedBy,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      className={clsx('toggle', checked && 'is-on')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('field', className)}>
      <span className="field__label">{label}</span>
      {children}
      {error ? (
        <span className="field__error" role="alert">
          {error}
        </span>
      ) : (
        hint && <span className="field__hint">{hint}</span>
      )}
    </label>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number | null;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className,
}: {
  tabs: Array<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={clsx('tabs', className)} role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === value}
          className={clsx('tabs__tab', tab.id === value && 'is-active')}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count ? <span className="tabs__count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function DayPicker({
  value,
  onChange,
  label,
  disabled,
}: {
  value: number[];
  onChange: (days: number[]) => void;
  label: string;
  disabled?: boolean;
}) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="daypick" role="group" aria-label={label}>
      {order.map((day) => {
        const on = value.includes(day);
        return (
          <button
            key={day}
            type="button"
            className={clsx('daypick__day', on && 'is-on')}
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onChange(on ? value.filter((d) => d !== day) : [...value, day].sort((a, b) => a - b))}
          >
            {names[day]}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- States ---------------- */

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

export function Pill({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={clsx('pill', `pill--${tone}`)} title={title}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={clsx('empty', compact && 'empty--compact')}>
      {icon && <div className="empty__icon">{icon}</div>}
      <h3 className="empty__title">{title}</h3>
      {children && <p className="empty__text">{children}</p>}
      {action && <div className="empty__action">{action}</div>}
    </div>
  );
}

const ERROR_TITLES: Record<string, string> = {
  network: 'Can’t reach the server',
  timeout: 'The server took too long',
  not_implemented: 'Not available on this server yet',
  not_configured: 'Not configured on this deployment',
  reconnect_required: 'This account needs reconnecting',
  permission_missing: 'Permission not granted',
  demo_restricted: 'Not available in the sandbox',
  rate_limited: 'Rate limit reached',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  provider_error: 'Google or the model provider returned an error',
};

export function errorTitle(error: ApiRequestError): string {
  return ERROR_TITLES[error.code] ?? 'Something went wrong';
}

export function ErrorState({
  error,
  onRetry,
  compact,
  children,
}: {
  error: ApiRequestError;
  onRetry?: () => void;
  compact?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={clsx('errstate', compact && 'errstate--compact')} role="alert">
      <TriangleAlert size={compact ? 16 : 20} aria-hidden="true" />
      <div className="errstate__body">
        <strong className="errstate__title">{errorTitle(error)}</strong>
        <p className="errstate__msg">{error.message}</p>
        <p className="errstate__code">
          {error.code}
          {error.status ? ` · HTTP ${error.status}` : ''}
          {error.path ? ` · ${error.path}` : ''}
        </p>
        {children}
      </div>
      {onRetry && (
        <Button size="sm" icon={<RotateCw size={14} />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Shown above still-visible data when a background refresh failed. */
export function StaleNotice({ error, onRetry }: { error: ApiRequestError; onRetry: () => void }) {
  return (
    <div className="notice notice--warn" role="status">
      <TriangleAlert size={15} aria-hidden="true" />
      <span>
        Couldn’t refresh — showing the last loaded data. {error.message}
      </span>
      <button type="button" className="link-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export function Notice({
  tone = 'info',
  icon,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'danger' | 'ok';
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={clsx('notice', `notice--${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon}
      <span className="notice__text">{children}</span>
      {action}
    </div>
  );
}

export function SkeletonRows({ count = 8, tall }: { count?: number; tall?: boolean }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={clsx('skeleton__row', tall && 'skeleton__row--tall')}>
          <span className="skeleton__bar" style={{ width: `${18 + ((index * 7) % 14)}%` }} />
          <span className="skeleton__bar" style={{ width: `${44 + ((index * 11) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading-block" role="status">
      <Spinner size={18} />
      <span>{label}</span>
    </div>
  );
}

/** Page heading used by every view: mono kicker, serif title, optional actions. */
export function ViewHeader({
  kicker,
  title,
  children,
  aside,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="view-head">
      <div className="view-head__main">
        {kicker && <p className="kicker">{kicker}</p>}
        <h1 className="view-head__title">{title}</h1>
        {children && <div className="view-head__sub">{children}</div>}
      </div>
      {aside && <div className="view-head__aside">{aside}</div>}
    </header>
  );
}
