import type { Calendar, Connection, ResourceKind } from './types';

/** Whether the connection has the Google permission for a feature area. */
export function hasPermission(connection: Connection, resource: ResourceKind): boolean {
  const entry = connection.permissions.find((permission) => permission.resource === resource);
  return entry?.state === 'granted';
}

/** A connection that can act right now: permission granted and credentials usable. */
export function canAct(connection: Connection, resource: ResourceKind): boolean {
  return hasPermission(connection, resource) && connection.status !== 'reconnect_required';
}

export function needsAttention(connection: Connection): boolean {
  return connection.status === 'reconnect_required' || connection.status === 'error';
}

export function canWriteCalendar(calendar: Calendar): boolean {
  return calendar.accessRole === 'owner' || calendar.accessRole === 'writer';
}

export function identitiesOf(connection: Connection): Array<{ email: string; name: string | null; isDefault: boolean }> {
  if (connection.sendAs.length) return connection.sendAs;
  return [{ email: connection.email, name: connection.name, isDefault: true }];
}

export function defaultIdentity(connection: Connection): string {
  const identities = identitiesOf(connection);
  return (identities.find((identity) => identity.isDefault) ?? identities[0]!).email;
}
