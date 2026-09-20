import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { osadePaths } from '../paths.js';

/**
 * Where the daemon listens — OSADE-MOSS §M.6.1.
 *
 * ARCH §5.5 said loopback only. F2 needs teammates on other machines, so this is the one place
 * that posture changes, and it changes with a replacement guarantee rather than a loosening:
 *
 * **INVARIANT M1: the daemon refuses to bind a non-loopback address unless member auth and TLS
 * are both enabled. There is no flag combination that exposes an unauthenticated or plaintext
 * listener.** Not "warns", not "defaults to off" — a misconfigured boot is a fatal boot. The
 * failure mode being prevented is a laptop on conference wifi serving an unauthenticated API
 * that can start processes on the host, and a warning in a log nobody reads is not a control.
 */

export type ListenMode = 'loopback' | 'lan';

export const LOOPBACK = '127.0.0.1';

export interface ListenConfig {
  readonly mode: ListenMode;
  readonly port: number;
  /** F2 member auth. Meaningless on loopback; mandatory off it. */
  readonly auth: boolean;
  readonly tls: boolean;
}

export class ListenPostureError extends Error {
  constructor(message: string) {
    super(`refusing to start: ${message}`);
    this.name = 'ListenPostureError';
  }
}

/**
 * Asserts M1 and returns the address to bind.
 *
 * Throws rather than falling back to loopback. Silently binding somewhere other than where the
 * operator asked is its own kind of surprise — they would believe teammates can connect, and
 * discover otherwise at the worst moment.
 */
export function resolveBindAddress(config: ListenConfig): string {
  if (config.mode === 'loopback') return LOOPBACK;

  const missing: string[] = [];
  if (!config.auth) missing.push('member authentication');
  if (!config.tls) missing.push('TLS');
  if (missing.length > 0) {
    throw new ListenPostureError(
      `server.listen is "lan" but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not enabled. ` +
        `A non-loopback listener without both would expose this machine's daemon — and it can start processes here. ` +
        `Enable them, or set server.listen to "loopback" (OSADE-MOSS M1).`,
    );
  }
  return '0.0.0.0';
}

export interface TlsMaterial {
  readonly cert: string;
  readonly key: string;
  /** sha256 of the DER certificate, as a colon-free hex string. Pinned by joining clients. */
  readonly fingerprint: string;
}

/**
 * §M.6.1 — the self-signed certificate LAN mode uses.
 *
 * Self-signed and pinned on first use rather than a CA chain, because there is no name to
 * certify: the daemon is reachable at whatever address the laptop happens to have. The join
 * code carries the fingerprint, so a teammate pins the exact certificate rather than trusting
 * an issuer. The recommended alternative for remote teams is a Tailscale or WireGuard address,
 * which this same mechanism supports unchanged.
 *
 * Generation is deliberately **not** implemented here in terms of a TLS library: Node cannot
 * mint an X.509 certificate from its standard library, so LAN mode requires the operator to
 * supply `cert.pem` and `key.pem`. That is a real limitation, and it is reported as one rather
 * than papered over with a plaintext fallback — which M1 forbids anyway.
 */
export function loadTls(env: NodeJS.ProcessEnv = process.env): TlsMaterial | null {
  const dir = join(osadePaths(env).root, 'tls');
  const certPath = join(dir, 'cert.pem');
  const keyPath = join(dir, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;

  const cert = readFileSync(certPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  return { cert, key, fingerprint: fingerprintOf(cert) };
}

export function tlsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(osadePaths(env).root, 'tls');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** sha256 over the certificate's DER bytes — what a joining client pins. */
export function fingerprintOf(certPem: string): string {
  const body = certPem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  // A fingerprint is a hash, not a claim about identity, so it sits outside the §M.7.2
  // signing seam — which restricts signing and key material, not hashing.
  return createHash('sha256').update(Buffer.from(body, 'base64')).digest('hex');
}

export interface JoinCode {
  readonly host: string;
  readonly port: number;
  readonly fingerprint: string;
  readonly nonce: string;
}

/**
 * §M.6.1 — `osade share` prints this; `osade join` consumes it.
 *
 * One opaque string rather than three flags, because a teammate pasting two of three values
 * correctly produces a confusing failure rather than an obvious one.
 */
export function encodeJoinCode(code: JoinCode): string {
  return Buffer.from(JSON.stringify(code), 'utf8').toString('base64url');
}

export function decodeJoinCode(encoded: string): JoinCode | null {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as JoinCode;
    if (!parsed.host || !parsed.port || !parsed.fingerprint) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Writes a join code beside the TLS material, so `osade share` has something to print. */
export function writeJoinCode(code: JoinCode, env: NodeJS.ProcessEnv = process.env): string {
  const encoded = encodeJoinCode(code);
  writeFileSync(join(tlsDir(env), 'join-code.txt'), `${encoded}\n`, 'utf8');
  return encoded;
}
