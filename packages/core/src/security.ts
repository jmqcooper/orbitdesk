import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { requireSecret } from './config';
import sanitizeHtml from 'sanitize-html';
export class AppError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const randomToken = (size = 32) => randomBytes(size).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.entries(value as Record<string, unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
}
export const hashPayload = (value: unknown) => sha256(canonical(value));
function encryptionKey() {
  const key = Buffer.from(requireSecret('TOKEN_ENCRYPTION_KEY'), 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  cipher.setAAD(Buffer.from('orbitdesk-credentials-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decrypt<T>(value: string): T {
  const [version,iv,tag,data] = value.split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new AppError('CREDENTIAL_ERROR', 'This account needs to be reconnected.', 409);
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv,'base64url'));
  cipher.setAAD(Buffer.from('orbitdesk-credentials-v1'));
  cipher.setAuthTag(Buffer.from(tag,'base64url'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64url')),cipher.final()]).toString());
}
export function constantEqual(a: string, b: string) {
  const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y);
}
export const safeHtml = (value: string) => sanitizeHtml(value, {
  allowedTags: ['p','div','span','br','strong','b','em','i','u','ul','ol','li','blockquote','pre','code','a','table','thead','tbody','tr','td','th','hr','h1','h2','h3','h4'],
  allowedAttributes: { a:['href','title'] }, allowedSchemes:['https','http','mailto'],
  transformTags: { a: sanitizeHtml.simpleTransform('a', { rel:'noopener noreferrer', target:'_blank' }) },
});
export function safeProviderError(error: unknown) {
  const e = error as { code?: number | string; response?: {status?:number}; message?:string };
  const status = e.response?.status || (typeof e.code==='number' ? e.code:0);
  if (status===401 || /invalid_grant/i.test(e.message || '')) return new AppError('reconnect_required','Google access expired or was revoked. Reconnect this account.',409);
  if (status===403) return new AppError('permission_missing','Google did not allow this operation. Check this account’s granted permissions and organization policy.',403);
  if (status===429) return new AppError('rate_limited','Google temporarily limited this account. Try again shortly.',429);
  if (status===404) return new AppError('not_found','The item no longer exists or this account cannot access it.',404);
  if (status===409 || status===412) return new AppError('conflict','This item changed in Google. Refresh it before applying your changes.',409);
  return new AppError('provider_error','The provider could not confirm this operation. Review its status before retrying.',502);
}

