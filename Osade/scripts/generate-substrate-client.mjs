#!/usr/bin/env node
/**
 * Generates the typed substrate client from the PINNED schema.
 *
 * OSADE.md §4.1 — INVARIANT: `vendor/runtime/<version>-p<protocol>/api-schema.json` is the only
 * permitted codegen source. `backend/` is reference reading for behaviour and is never read
 * here. Method names are never hand-written; everything below is derived from the schema.
 *
 * Output: packages/daemon/src/substrate/generated/{types.ts,methods.ts,pin.ts,index.ts}
 *
 * Usage: node scripts/generate-substrate-client.mjs [--check]
 *        --check  fail if the generated output would change (for CI)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'packages/daemon/src/substrate/generated');
const CHECK_ONLY = process.argv.includes('--check');

/** The five top-level schemas in substrate's bundle, and the TS module each becomes. */
const SCHEMA_KEYS = [
  'request',
  'success_response',
  'error_response',
  'event',
  'subscription_event',
];

function findPin() {
  const vendorDir = join(ROOT, 'vendor/runtime');
  if (!existsSync(vendorDir)) {
    throw new Error(`no vendored substrate at ${vendorDir} — see OSADE.md §4.1`);
  }
  const targets = readdirSync(vendorDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (targets.length === 0) throw new Error(`no pinned the substrate target in ${vendorDir}`);
  if (targets.length > 1) {
    throw new Error(
      `multiple pinned the substrate targets (${targets.join(', ')}); exactly one must be pinned`,
    );
  }
  const dir = join(vendorDir, targets[0]);
  return {
    key: targets[0],
    dir,
    schema: JSON.parse(readFileSync(join(dir, 'api-schema.json'), 'utf8')),
    pin: JSON.parse(readFileSync(join(dir, 'pin.json'), 'utf8')),
  };
}

/**
 * Type names in Osade's vocabulary; values left exactly as the schema has them.
 *
 * PascalCase type names are Osade's to choose — nothing reads them off the wire — so the upstream
 * project's name is taken out of any that carry it. Lowercase words are left alone: string
 * literal values and snake_case field names *are* the wire, and a client that spells them
 * differently does not work. Case is the whole discriminator, so the replacement is
 * case-sensitive and needs no word boundaries.
 *
 * The word comes from pin.json's record of the upstream repository rather than being written
 * here, so the pin stays the one place that says where the runtime came from.
 *
 * The "referenced by `undefined`'s JSON-Schema via the definition …" comments that
 * json-schema-to-typescript emits carry nothing — the schema has no title for them to name —
 * and are dropped.
 */
const PROVENANCE_COMMENT =
  /^ \* This interface was referenced by `[^`]*`'s JSON-Schema\n \* via the `definition` "[^"]*"\.\n/gm;

/** The upstream project's name: the last segment of the repository the pin records. */
function projectName(pin) {
  const segments = new URL(pin.license.upstream_repository).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1];
}

/**
 * The prefix of the runtime's own environment variables, as the pin records it.
 *
 * This is the pinned *binary's* input contract, so it is read from `binary.env_prefix` and is
 * deliberately NOT derived from `license.upstream_repository`: that field carries Osade's
 * rebranded identity, while the shipped executable still reads its original names. Deriving one
 * from the other spawns a runtime that silently ignores every socket override it is handed.
 */
function envPrefix(pin) {
  const prefix = pin.binary?.env_prefix;
  if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(prefix)) {
    throw new Error(
      `pin.json: binary.env_prefix must be an uppercase identifier, got ${JSON.stringify(prefix)}`,
    );
  }
  return prefix;
}

function osadeNames(ts, pin) {
  const segments = new URL(pin.license.upstream_repository).pathname.split('/').filter(Boolean);
  const project = segments[segments.length - 1];
  const typeWord = project[0].toUpperCase() + project.slice(1);
  return ts
    .replace(PROVENANCE_COMMENT, '')
    .replace(/^\/\*\*\n \*\/\n/gm, '')
    .replace(/\n \*\n \*\//g, '\n */')
    .split(typeWord)
    .join('Substrate');
}

function localiseRefs(node, schemaKey) {
  if (Array.isArray(node)) return node.map((n) => localiseRefs(n, schemaKey));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v.replace(`#/schemas/${schemaKey}/$defs/`, '#/$defs/');
      } else {
        out[k] = localiseRefs(v, schemaKey);
      }
    }
    return out;
  }
  return node;
}

function pascal(key) {
  return key
    .split('_')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

/** Walk request.oneOf collecting {method, paramsRef} — the authoritative method list. */
function extractMethods(requestSchema) {
  const variants = requestSchema.oneOf ?? requestSchema.anyOf ?? [];
  const methods = [];
  for (const v of variants) {
    const method = v?.properties?.method?.const;
    if (typeof method !== 'string') continue;
    const ref = v?.properties?.params?.$ref;
    const params = typeof ref === 'string' ? ref.split('/').pop() : null;
    methods.push({ method, params });
  }
  methods.sort((a, b) => a.method.localeCompare(b.method));
  return methods;
}

const BANNER = (pinKey) => `/**
 * GENERATED — DO NOT EDIT.
 *
 * Source: vendor/runtime/${pinKey}/api-schema.json
 * Regenerate: pnpm substrate:codegen
 *
 * OSADE.md §4.1 — the pinned schema is the only codegen source. Never hand-write a substrate
 * method name, and never derive one from backend/.
 */
`;

async function main() {
  const { key, schema, pin } = findPin();
  const methods = extractMethods(schema.schemas.request);

  if (methods.length !== pin.substrate.method_count) {
    throw new Error(
      `pin.json says ${pin.substrate.method_count} methods, schema has ${methods.length}`,
    );
  }

  // ---- types/<schema>.ts --------------------------------------------------
  // One module per top-level schema. They must not be concatenated: the substrate's five bundles
  // share `$defs` names (AgentStatus, ReadSource, EventData, …) with different shapes, so a
  // single file collides on every one of them.
  const files = {};
  for (const schemaKey of SCHEMA_KEYS) {
    const raw = schema.schemas[schemaKey];
    if (!raw) continue;
    const localised = localiseRefs(raw, schemaKey);
    localised.title = pascal(schemaKey);
    const ts = await compile(localised, pascal(schemaKey), {
      bannerComment: '',
      additionalProperties: false,
      declareExternallyReferenced: true,
      unreachableDefinitions: true,
      style: { singleQuote: true, printWidth: 100 },
    });
    files[`types/${schemaKey}.ts`] = BANNER(key) + '\n/* eslint-disable */\n\n' + osadeNames(ts, pin);
  }

  const types =
    BANNER(key) +
    SCHEMA_KEYS.filter((k) => schema.schemas[k])
      .map((k) => `export * as ${pascal(k)} from './types/${k}.js';`)
      .join('\n') +
    '\n';

  // ---- methods.ts ---------------------------------------------------------
  const methodNames = methods.map((m) => `  | '${m.method}'`).join('\n');
  const paramsEntries = methods
    .map((m) => `  '${m.method}': ${m.params ? `T.${m.params}` : 'Record<string, never>'};`)
    .join('\n');

  const methodsTs =
    BANNER(key) +
    `import type * as T from './types/request.js';

/** Every method name in the pinned schema. Derived, never typed by hand. */
export type SubstrateMethod =
${methodNames};

/** Method name → params type, from the request schema's oneOf. */
export interface SubstrateMethodParams {
${paramsEntries}
}

/** Runtime list, for the drift check and for tests. */
export const SUBSTRATE_METHODS: readonly SubstrateMethod[] = Object.freeze([
${methods.map((m) => `  '${m.method}',`).join('\n')}
]) as readonly SubstrateMethod[];
`;

  // ---- pin.ts -------------------------------------------------------------
  const pinTs =
    BANNER(key) +
    `/** Identity of the pinned substrate target. The version string is NOT a contract (§4.1). */
export const SUBSTRATE_PIN = Object.freeze({
  key: ${JSON.stringify(pin.identity.key)},
  version: ${JSON.stringify(pin.substrate.version)},
  protocol: ${pin.substrate.protocol},
  schemaVersion: ${pin.substrate.schema_version},
  methodCount: ${methods.length},
  /** The prefix of the runtime's own environment variables, e.g. \`<prefix>_SOCKET_PATH\`. */
  envPrefix: ${JSON.stringify(envPrefix(pin))},
});
`;

  const indexTs =
    BANNER(key) +
    `export * from './methods.js';
export * from './pin.js';
export * as SubstrateSchema from './types.js';
`;

  files['types.ts'] = types;
  files['methods.ts'] = methodsTs;
  files['pin.ts'] = pinTs;
  files['index.ts'] = indexTs;

  if (CHECK_ONLY) {
    let drifted = [];
    for (const [name, content] of Object.entries(files)) {
      const path = join(OUT_DIR, name);
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
      if (existing !== content) drifted.push(name);
    }
    if (drifted.length) {
      console.error(
        `generated substrate client is stale: ${drifted.join(', ')}\nrun: pnpm substrate:codegen`,
      );
      process.exit(1);
    }
    console.log(`the substrate client is current (${key}, ${methods.length} methods)`);
    return;
  }

  mkdirSync(join(OUT_DIR, 'types'), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(OUT_DIR, name), content);
  }
  console.log(
    `generated ${Object.keys(files).length} files from ${key} — ${methods.length} methods`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
