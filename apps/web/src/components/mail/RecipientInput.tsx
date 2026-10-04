'use client';

import clsx from 'clsx';
import { X } from 'lucide-react';
import { useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { dedupeAddresses, displayName, parseAddresses, sameEmail } from '@/lib/format';
import { useDebounced, useResource } from '@/lib/hooks';
import type { Address, Id } from '@/lib/types';

interface RecipientInputProps {
  /** Accessible name, e.g. "To". */
  label: string;
  value: Address[];
  onChange: (next: Address[]) => void;
  /** Suggestions are scoped to this account. */
  accountId: Id | null;
  autoFocus?: boolean;
  placeholder?: string;
}

/**
 * Address chips with contact suggestions from GET /api/contacts. Anything the
 * user types is only accepted once it parses as an email address.
 */
export function RecipientInput({ label, value, onChange, accountId, autoFocus, placeholder }: RecipientInputProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const errorId = useId();

  const query = useDebounced(text.trim(), 180);
  const lookup = useResource(
    focused && query.length >= 2 && accountId ? `contacts:${accountId}:${query}` : null,
    (signal) => api.contacts({ q: query, accountId: accountId ?? undefined, limit: 8 }, { signal }),
  );
  const suggestions = (lookup.data?.items ?? []).filter(
    (contact) => !value.some((address) => sameEmail(address.email, contact.email)),
  );
  const open = focused && text.trim().length >= 2 && (suggestions.length > 0 || lookup.error !== null);
  const activeIndex = Math.min(active, Math.max(suggestions.length - 1, 0));

  const add = (addresses: Address[]) => {
    if (addresses.length) onChange(dedupeAddresses([...value, ...addresses]));
  };

  /** Accept what parses; leave the rest in the box and say why. */
  const commit = (raw: string): boolean => {
    if (!raw.trim()) {
      setInvalid(null);
      return true;
    }
    const { valid, invalid: rejected } = parseAddresses(raw);
    add(valid);
    if (rejected.length) {
      setText(rejected.join(', '));
      setInvalid(`“${rejected[0]}” is not a complete email address.`);
      return false;
    }
    setText('');
    setInvalid(null);
    return true;
  };

  const pick = (address: Address) => {
    add([address]);
    setText('');
    setInvalid(null);
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && open && suggestions.length) {
      event.preventDefault();
      setActive((activeIndex + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp' && open && suggestions.length) {
      event.preventDefault();
      setActive((activeIndex - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === 'Enter' || event.key === ',' || event.key === ';' || (event.key === 'Tab' && text.trim())) {
      const suggestion = open && event.key !== ',' && event.key !== ';' ? suggestions[activeIndex] : undefined;
      if (suggestion) {
        event.preventDefault();
        pick({ name: suggestion.name, email: suggestion.email });
      } else if (text.trim()) {
        const accepted = commit(text);
        if (event.key !== 'Tab' || !accepted) event.preventDefault();
      } else if (event.key !== 'Enter' && event.key !== 'Tab') {
        event.preventDefault();
      }
    } else if (event.key === 'Backspace' && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (event.key === 'Escape' && open) {
      // Close the suggestions only; do not let Escape close an enclosing dialog.
      event.preventDefault();
      event.stopPropagation();
      setText('');
      setInvalid(null);
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[,;\n]/.test(pasted) && !pasted.includes('@')) return;
    event.preventDefault();
    commit(`${text}${pasted}`);
  };

  return (
    <div className={clsx('recip', focused && 'is-focused', invalid && 'is-invalid')} onClick={() => inputRef.current?.focus()}>
      <ul className="recip__chips" aria-label={`${label} recipients`}>
        {value.map((address) => (
          <li key={address.email} className="chip" title={address.email}>
            <span className="chip__text">{address.name ? displayName(address) : address.email}</span>
            <button
              type="button"
              className="chip__x"
              aria-label={`Remove ${address.email}`}
              onClick={(event) => {
                event.stopPropagation();
                onChange(value.filter((item) => !sameEmail(item.email, address.email)));
              }}
            >
              <X size={12} />
            </button>
          </li>
        ))}
        <li className="recip__input-wrap">
          <input
            ref={inputRef}
            className="recip__input"
            type="text"
            inputMode="email"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            role="combobox"
            aria-label={label}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && suggestions.length ? `${listId}-${activeIndex}` : undefined}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? errorId : undefined}
            autoFocus={autoFocus}
            placeholder={value.length ? undefined : placeholder}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setActive(0);
              if (invalid) setInvalid(null);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              commit(text);
            }}
          />
        </li>
      </ul>

      {open && (
        <div className="recip__list" id={listId} role="listbox" aria-label={`${label} suggestions`}>
          {suggestions.map((contact, index) => (
            <div
              key={`${contact.id}-${contact.email}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className={clsx('recip__option', index === activeIndex && 'is-active')}
              // Keep focus in the input so the blur handler does not commit half-typed text.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick({ name: contact.name, email: contact.email })}
              onMouseEnter={() => setActive(index)}
            >
              <span className="recip__option-name">{contact.name ?? contact.email}</span>
              {contact.name && <span className="recip__option-email">{contact.email}</span>}
              <span className="recip__option-origin">{contact.origin === 'contacts' ? 'Contacts' : 'Recent'}</span>
            </div>
          ))}
          {lookup.error && suggestions.length === 0 && (
            <div className="recip__note" role="status">
              Suggestions are unavailable ({lookup.error.message}). You can still type a full address.
            </div>
          )}
        </div>
      )}

      {invalid && (
        <p className="recip__error" id={errorId} role="alert">
          {invalid}
        </p>
      )}
    </div>
  );
}
