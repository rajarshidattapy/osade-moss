import { describe, expect, it } from 'vitest';

import {
  decodeJoinCode,
  encodeJoinCode,
  fingerprintOf,
  ListenPostureError,
  LOOPBACK,
  resolveBindAddress,
} from '../../src/server/listen.js';

/**
 * INVARIANT M1 — OSADE-MOSS §M.6.1, §M.9.3.
 *
 * ARCH §5.5 said loopback only. F2 changes that posture, and §M.6.1 is explicit that it changes
 * *with a replacement guarantee*: **there is no flag combination that exposes an
 * unauthenticated or plaintext listener.**
 *
 * §M.6.8 criterion 5 is the third test here: starting with `listen: 'lan'` and auth disabled is
 * a fatal boot error. Fatal, not a warning — the thing being prevented is a laptop on
 * conference wifi serving an API that can start processes on the host, and a line in a log
 * nobody reads is not a control.
 */

describe('M1 — loopback needs nothing', () => {
  it('binds 127.0.0.1 regardless of auth or TLS', () => {
    for (const auth of [true, false]) {
      for (const tls of [true, false]) {
        expect(resolveBindAddress({ mode: 'loopback', port: 0, auth, tls })).toBe(LOOPBACK);
      }
    }
  });
});

describe('M1 — LAN needs both, or it refuses to start', () => {
  it('binds when auth and TLS are both on', () => {
    expect(resolveBindAddress({ mode: 'lan', port: 0, auth: true, tls: true })).toBe('0.0.0.0');
  });

  it('§M.6.8 criterion 5 — refuses with auth disabled', () => {
    expect(() => resolveBindAddress({ mode: 'lan', port: 0, auth: false, tls: true })).toThrow(
      ListenPostureError,
    );
    expect(() => resolveBindAddress({ mode: 'lan', port: 0, auth: false, tls: true })).toThrow(
      /member authentication/,
    );
  });

  it('refuses with TLS disabled', () => {
    expect(() => resolveBindAddress({ mode: 'lan', port: 0, auth: true, tls: false })).toThrow(
      /TLS/,
    );
  });

  it('refuses with neither, and names both', () => {
    try {
      resolveBindAddress({ mode: 'lan', port: 0, auth: false, tls: false });
      throw new Error('should have refused');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('member authentication');
      expect(message).toContain('TLS');
      // The error has to say what to do, not just what is wrong.
      expect(message).toContain('loopback');
    }
  });

  it('never silently falls back to loopback', () => {
    // Binding somewhere other than where the operator asked is its own surprise: they would
    // believe teammates can connect and find out otherwise at the worst moment.
    expect(() => resolveBindAddress({ mode: 'lan', port: 0, auth: false, tls: false })).toThrow();
  });
});

describe('§M.6.1 — the join code', () => {
  it('round-trips', () => {
    const code = { host: '192.168.1.14', port: 4711, fingerprint: 'ab'.repeat(32), nonce: 'x9' };
    expect(decodeJoinCode(encodeJoinCode(code))).toEqual(code);
  });

  it('rejects rubbish rather than returning a half-built code', () => {
    expect(decodeJoinCode('not base64url at all !!')).toBeNull();
    expect(decodeJoinCode(Buffer.from('{"host":"x"}').toString('base64url'))).toBeNull();
  });

  it('fingerprints the certificate, not the PEM text', () => {
    const der = Buffer.from('a fake certificate body').toString('base64');
    const pem = `-----BEGIN CERTIFICATE-----\n${der}\n-----END CERTIFICATE-----\n`;
    // Re-wrapping the base64 must not change the fingerprint, or a client that normalised
    // line endings would fail to match a certificate it had correctly pinned.
    const rewrapped = `-----BEGIN CERTIFICATE-----\n${der.slice(0, 8)}\n${der.slice(8)}\n-----END CERTIFICATE-----`;
    expect(fingerprintOf(pem)).toBe(fingerprintOf(rewrapped));
    expect(fingerprintOf(pem)).toHaveLength(64);
  });
});
