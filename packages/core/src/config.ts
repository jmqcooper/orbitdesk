import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
// Local development only. Railway injects environment variables directly.
if (process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL) {
  for (const candidate of ['.env', '../../.env']) {
    const path = resolve(/* turbopackIgnore: true */ process.cwd(), candidate);
    if (existsSync(/* turbopackIgnore: true */ path)) { process.loadEnvFile(path); break; }
  }
}
export const appUrl = () => process.env.APP_URL || 'http://localhost:3100';
export const configuredGoogle = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const configuredAI = () => process.env.AI_PROVIDER==='vertex'?Boolean(process.env.GOOGLE_VERTEX_PROJECT&&(process.env.GOOGLE_VERTEX_CREDENTIALS||process.env.GOOGLE_APPLICATION_CREDENTIALS)):process.env.AI_PROVIDER==='anthropic'?Boolean(process.env.ANTHROPIC_API_KEY):Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY);
export const allowDemo = () => process.env.ENABLE_DEMO !== 'false';
export function requireSecret(name: string) {
  const value = process.env[name];
  if (!value || value.length < 32) throw new Error(`${name} must be configured with at least 32 characters`);
  return value;
}
