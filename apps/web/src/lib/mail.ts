import { dedupeAddresses, displayName, formatAddress, fullDateTime } from './format';
import { htmlToText } from './sanitize';
import type { Address, Connection, DraftMode, Message } from './types';

export interface ComposeFields {
  to: Address[];
  cc: Address[];
  bcc: Address[];
  subject: string;
  bodyText: string;
}

function ownAddresses(account: Connection): Set<string> {
  const own = new Set<string>([account.email.toLowerCase()]);
  for (const identity of account.sendAs) own.add(identity.email.toLowerCase());
  return own;
}

function prefixed(subject: string, prefix: 'Re' | 'Fwd'): string {
  const trimmed = subject.trim();
  const pattern = prefix === 'Re' ? /^re:\s*/i : /^(fwd?|fw):\s*/i;
  if (pattern.test(trimmed)) return trimmed;
  return `${prefix}: ${trimmed || '(no subject)'}`;
}

function messageText(message: Message): string {
  if (message.bodyText && message.bodyText.trim()) return message.bodyText.trim();
  if (message.bodyHtml) return htmlToText(message.bodyHtml);
  return message.snippet;
}

function signatureBlock(account: Connection): string {
  const signature = account.signature?.trim();
  return signature ? `\n\n-- \n${signature}` : '';
}

/**
 * Recipients, subject and quoted body for a reply or forward. Addresses are
 * only ever taken from the message's own headers — nothing is guessed.
 */
export function composeFromMessage(mode: Exclude<DraftMode, 'new'>, message: Message, account: Connection): ComposeFields {
  const own = ownAddresses(account);
  const notOwn = (address: Address) => !own.has(address.email.toLowerCase());

  if (mode === 'forward') {
    const header = [
      '---------- Forwarded message ---------',
      `From: ${formatAddress(message.from)}`,
      `Date: ${fullDateTime(message.sentAt)}`,
      `Subject: ${message.subject}`,
      `To: ${message.to.map(formatAddress).join(', ')}`,
      message.cc.length ? `Cc: ${message.cc.map(formatAddress).join(', ')}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
    return {
      to: [],
      cc: [],
      bcc: [],
      subject: prefixed(message.subject, 'Fwd'),
      bodyText: `${signatureBlock(account)}\n\n${header}\n\n${messageText(message)}`,
    };
  }

  // Replying to something the user sent continues the conversation with its recipients.
  const primary = message.outgoing ? message.to : message.replyTo.length ? message.replyTo : [message.from];
  const to = dedupeAddresses(message.outgoing ? primary : primary.filter(notOwn).length ? primary.filter(notOwn) : primary);
  const toKeys = new Set(to.map((address) => address.email.toLowerCase()));
  const cc =
    mode === 'reply_all'
      ? dedupeAddresses([...(message.outgoing ? [] : message.to), ...message.cc]).filter(
          (address) => notOwn(address) && !toKeys.has(address.email.toLowerCase()),
        )
      : [];

  const quoted = messageText(message)
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  const attribution = `On ${fullDateTime(message.sentAt)}, ${displayName(message.from)} <${message.from.email}> wrote:`;

  return {
    to,
    cc,
    bcc: [],
    subject: prefixed(message.subject, 'Re'),
    bodyText: `${signatureBlock(account)}\n\n${attribution}\n${quoted}`,
  };
}

export function blankCompose(account: Connection | undefined): ComposeFields {
  return { to: [], cc: [], bcc: [], subject: '', bodyText: account ? signatureBlock(account) : '' };
}

/** Reads a File as base64 without the `data:` prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Splits a reply body into what the author wrote and the quoted original
 * beneath it, so the editor can keep the quote out of the way.
 */
export function splitQuote(body: string): { head: string; tail: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const attribution = /^On .+ wrote:$/.test(lines[i]!) && (lines[i + 1] ?? '').startsWith('>');
    const forwarded = lines[i]!.startsWith('---------- Forwarded message');
    if (attribution || forwarded || lines[i]!.startsWith('>')) {
      let start = i;
      while (start > 0 && lines[start - 1]!.trim() === '') start -= 1;
      return { head: lines.slice(0, start).join('\n'), tail: lines.slice(start).join('\n') };
    }
  }
  return { head: body, tail: '' };
}
