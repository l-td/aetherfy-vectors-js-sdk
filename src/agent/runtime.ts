/**
 * What every control-plane call of this helper reads off the machine: its
 * environment, and the User-Agent it announces.
 *
 * A module of its own because more than one module calls the control plane
 * (index.ts for spawn/result/wait, connections.ts for connection tokens), and
 * importing these back from index.ts, which re-exports those modules, would be
 * a circular import.
 */

import { NotRunningOnAgent } from './errors';
import { USER_AGENT_PREFIX } from './http';
import { SDK_VERSION } from '../version';

export function userAgent(): string {
  return `${USER_AGENT_PREFIX}${SDK_VERSION}`;
}

export function requireEnv(
  variable: string,
  purpose: string,
  remedy?: string
): string {
  const value = process.env[variable];
  if (!value) throw new NotRunningOnAgent(variable, purpose, remedy);
  return value;
}
