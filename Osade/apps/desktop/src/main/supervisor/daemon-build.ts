import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Fingerprint of the daemon entry. Same algorithm as the daemon's /health `build`. */
export function daemonBuildId(entry: string): string {
  return createHash('sha256').update(readFileSync(entry)).digest('hex').slice(0, 16);
}

export function healthMatchesBuild(body: unknown, build: string): boolean {
  if (typeof body !== 'object' || body == null) return false;
  return (body as { build?: unknown }).build === build;
}
