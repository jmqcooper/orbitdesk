import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const NO_SESSION_BUS = '/nonexistent/orbitdesk-no-session-bus';

// Varlock's helper keeps its private key per user, whatever HOME says, and finds the
// user's bus by itself. Every fixture runs with this bus or it can replace the real key.
export const NO_KEYRING_ENV = { DBUS_SESSION_BUS_ADDRESS: `unix:path=${NO_SESSION_BUS}` };

/** The only env a fixture may run Varlock with: nothing inherited but PATH. */
export function sealedEnv(home: string, values: Record<string, string> = {}): NodeJS.ProcessEnv {
  if (home === homedir()) throw new Error('A fixture must not use the real home directory.');
  if (existsSync(NO_SESSION_BUS)) throw new Error('The fixture session bus must not exist.');
  return { ...values, ...NO_KEYRING_ENV, HOME: home, PATH: process.env.PATH, VARLOCK_TELEMETRY_DISABLED: 'true' };
}
