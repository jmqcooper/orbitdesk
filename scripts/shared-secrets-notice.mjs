import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const profile = join(homedir(), '.config/varlock/.env.infisical');
const configured = process.env.INFISICAL_CLIENT_ID
  || (existsSync(profile) && /^\s*INFISICAL_CLIENT_ID=\S/m.test(readFileSync(profile, 'utf8')));

if (!configured && process.env.ORBITDESK_SHARED_SECRETS !== 'off') {
  console.warn('Shared dev secrets are not set up on this machine, so only local env files apply. See docs/SECRETS.md.');
}
