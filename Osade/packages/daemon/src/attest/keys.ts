import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as rawSign,
  verify as rawVerify,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { osadePaths } from '../paths.js';

/**
 * Tier-1 signing — OSADE-MOSS §M.7.2.
 *
 * **This directory is the only place in Osade that may touch a signing primitive**
 * (lint-enforced), for the same reason `retrieval/**` is the only place a Moss SDK may appear:
 * a signature is a claim about identity, and a claim about identity that can be produced from
 * anywhere is not a claim at all.
 *
 * ed25519, because it needs no parameter choices to get wrong and its keys are short enough to
 * publish in a repository file that humans read.
 *
 * The private key lives at `~/.osade/keys/attest_ed25519`, mode 0600, and is generated on first
 * use. §M.10: **losing it is not a disaster** — old attestations still verify against the
 * published public key, and new ones are simply signed by a new key id. That property is why
 * there is no key backup ceremony here.
 */

export interface KeyPair {
  /** PKCS#8 PEM. Never leaves this module. */
  readonly privatePem: string;
  /** SPKI PEM — the half that gets published in `.osade/attestors.json`. */
  readonly publicPem: string;
  /** `ed25519:<first 16 hex of sha256 over the SPKI DER>`. Stable across restarts. */
  readonly keyId: string;
}

const PRIVATE = 'attest_ed25519';
const PUBLIC = 'attest_ed25519.pub';

/**
 * Loads the install key, generating it on first use.
 *
 * The 0600 chmod is best-effort: on Windows it is a no-op, and failing the whole attestation
 * path because a permission bit could not be set would trade a real capability for a gesture.
 */
export function loadOrCreateKey(env: NodeJS.ProcessEnv = process.env): KeyPair {
  const dir = join(osadePaths(env).root, 'keys');
  const privatePath = join(dir, PRIVATE);
  const publicPath = join(dir, PUBLIC);

  if (existsSync(privatePath)) {
    const privatePem = readFileSync(privatePath, 'utf8');
    const publicPem = existsSync(publicPath)
      ? readFileSync(publicPath, 'utf8')
      : publicFrom(privatePem);
    return { privatePem, publicPem, keyId: keyIdFor(publicPem) };
  }

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

  mkdirSync(dir, { recursive: true });
  writeFileSync(privatePath, privatePem, 'utf8');
  writeFileSync(publicPath, publicPem, 'utf8');
  try {
    chmodSync(privatePath, 0o600);
  } catch {
    // Windows, or a filesystem with no permission bits. Not worth failing over.
  }

  return { privatePem, publicPem, keyId: keyIdFor(publicPem) };
}

/** ed25519 signs the message directly — no digest argument, by design of the algorithm. */
export function sign(message: string, privatePem: string): string {
  const key = createPrivateKey(privatePem);
  return rawSign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/**
 * Verifies a signature against a published public key.
 *
 * Returns false rather than throwing for *every* failure mode — a malformed key, a corrupt
 * signature, the wrong algorithm. A verifier that throws on bad input is a verifier that turns
 * "this attestation is not valid" into a crash, and the caller cannot tell those apart.
 */
export function verify(message: string, signature: string, publicPem: string): boolean {
  try {
    const key = createPublicKey(publicPem);
    return rawVerify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function keyIdFor(publicPem: string): string {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return `ed25519:${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

function publicFrom(privatePem: string): string {
  return createPublicKey(createPrivateKey(privatePem))
    .export({ type: 'spki', format: 'pem' })
    .toString();
}

/**
 * §M.7.2 — the published attestor list, as it appears in `.osade/attestors.json`.
 *
 * Committed to the repository so a verifier needs no service to check a signature: the key that
 * signed is in the repo the PR targets, at a commit anyone can read. That is the whole reason
 * tier 1 needs no new infrastructure.
 */
export interface AttestorFile {
  readonly version: 1;
  readonly attestors: readonly { readonly key_id: string; readonly public_key: string; readonly note?: string }[];
}

export function renderAttestorFile(key: KeyPair, note?: string): string {
  const file: AttestorFile = {
    version: 1,
    attestors: [{ key_id: key.keyId, public_key: key.publicPem.trim(), ...(note ? { note } : {}) }],
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function parseAttestorFile(json: string): AttestorFile | null {
  try {
    const parsed = JSON.parse(json) as AttestorFile;
    return Array.isArray(parsed?.attestors) ? parsed : null;
  } catch {
    return null;
  }
}
