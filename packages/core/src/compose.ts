import sanitizeHtml from 'sanitize-html';
import { formatInTimeZone } from 'date-fns-tz';
import type * as T from './types';

/** Readable text of a message, whichever body Gmail gave us. */
export function messageText(m:T.Message):string {
  if(m.bodyText&&m.bodyText.trim())return m.bodyText.trim();
  if(m.bodyHtml)return sanitizeHtml(m.bodyHtml.replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi,'\n'),{allowedTags:[],allowedAttributes:{}}).replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return m.snippet;
}
const formatAddress=(a:T.Address)=>a.name?.trim()?`${a.name.trim()} <${a.email}>`:a.email;
const dedupe=(list:T.Address[])=>{const seen=new Set<string>();return list.filter(a=>{const k=a.email.trim().toLowerCase();if(!k||seen.has(k))return false;seen.add(k);return true;});};
export const signatureBlock=(account:T.Connection)=>account.signature?.trim()?`\n\n-- \n${account.signature.trim()}`:'';

/**
 * Recipients, subject and quoted tail for a reply. Addresses only ever come
 * from the message's own headers; the mailbox's own identities are removed.
 */
export function replyFields(message:T.Message,account:T.Connection,timezone:string) {
  const own=new Set([account.email,...account.sendAs.map(i=>i.email)].map(e=>e.toLowerCase())),notOwn=(a:T.Address)=>!own.has(a.email.toLowerCase());
  const primary=message.outgoing?message.to:message.replyTo.length?message.replyTo:[message.from];
  const to=dedupe(message.outgoing||!primary.some(notOwn)?primary:primary.filter(notOwn)),toKeys=new Set(to.map(a=>a.email.toLowerCase()));
  const cc=dedupe([...(message.outgoing?[]:message.to),...message.cc]).filter(a=>notOwn(a)&&!toKeys.has(a.email.toLowerCase()));
  const subject=/^re:\s*/i.test(message.subject.trim())?message.subject.trim():`Re: ${message.subject.trim()||'(no subject)'}`;
  const quoted=messageText(message).split('\n').map(line=>line?`> ${line}`:'>').join('\n');
  const tail=`On ${formatInTimeZone(message.sentAt,timezone,"EEE, MMM d, yyyy 'at' h:mm a")}, ${message.from.name?.trim()||message.from.email.split('@')[0]} <${message.from.email}> wrote:\n${quoted}`;
  return {to,cc,subject,tail,mode:(cc.length?'reply_all':'reply') as T.DraftMode};
}
/** The part of a draft body the author wrote: everything above the signature and the quoted original. */
export function ownText(body:string):string {
  const lines=body.replace(/\r\n/g,'\n').split('\n');let end=lines.length;
  for(let i=0;i<lines.length;i++){if(lines[i]==='-- '||lines[i]==='--'||/^On .+ wrote:$/.test(lines[i]!)&&(lines[i+1]||'').startsWith('>')||lines[i]!.startsWith('>')){end=i;break;}}
  return lines.slice(0,end).join('\n').trim();
}
export const assembleReply=(text:string,account:T.Connection,tail:string)=>`${text.trim()}${signatureBlock(account)}\n\n${tail}`;
export { formatAddress };
