import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * OSADE.md §20.1 — the lint rules are invariants, so they get tested like invariants.
 *
 * Flat config *replaces* a rule's options rather than merging them, so a config block naming
 * `no-restricted-syntax` a second time silently discards the first block's selectors. That
 * failure is invisible: the file lints clean and the invariant is simply gone. Each rule below
 * is therefore proved to fire against a snippet that violates it, in the scope it governs.
 */

const eslint = new ESLint({ cwd: new URL('../../../..', import.meta.url).pathname.slice(1) });

async function messagesFor(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath, warnIgnored: false });
  return results.flatMap((r) => r.messages.map((m) => `${m.ruleId}: ${m.message}`));
}

const DOMAIN = 'packages/daemon/src/domain/probe.ts';
const DB = 'packages/daemon/src/db/probe.ts';
const RENDERER = 'apps/desktop/src/renderer/probe.ts';

describe('§20.1 lint boundaries actually fire', () => {
  it('§4.2 — the generated substrate client is off-limits outside daemon/src/substrate/**', async () => {
    const messages = await messagesFor(DOMAIN, "import '../substrate/generated/index.js';\n");
    expect(messages.join('\n')).toContain('§4.2');
  });

  it('§4.2 — raw socket access is off-limits outside daemon/src/substrate/**', async () => {
    const messages = await messagesFor(DOMAIN, "import net from 'node:net';\nexport const x = net;\n");
    expect(messages.join('\n')).toContain('raw socket access');
  });

  it('§11 — Octokit is off-limits outside daemon/src/scm/**', async () => {
    const messages = await messagesFor(DOMAIN, "import { Octokit } from 'octokit';\nexport const x = Octokit;\n");
    expect(messages.join('\n')).toContain('§11');
  });

  it('§20.1 — process.env destructuring', async () => {
    const messages = await messagesFor(DOMAIN, 'const { HOME } = process.env;\nexport const x = HOME;\n');
    expect(messages.join('\n')).toContain('§20.1');
  });

  it('§20.1 — importing argv as a binding from node:process', async () => {
    // The bug this caught: a runner that rewrites argv reassigns `process.argv`, so a binding
    // captured at import time still holds the pre-rewrite array — script path and all.
    const messages = await messagesFor(
      DOMAIN,
      ["import { argv } from 'node:process';", 'export const x = argv;', ''].join('\n'),
    );
    expect(messages.join('\n')).toContain('§20.1');
  });

  it('§20.1 — importing env as a binding, bare specifier included', async () => {
    const messages = await messagesFor(
      DOMAIN,
      ["import { env } from 'process';", 'export const x = env;', ''].join('\n'),
    );
    expect(messages.join('\n')).toContain('§20.1');
  });

  it('§20.1 — but reading process.argv at the use site is fine', async () => {
    const messages = await messagesFor(DOMAIN, 'export const x = process.argv.slice(2);\n');
    expect(messages.join('\n')).not.toContain('§20.1');
  });

  it('§17 — a raw __orchestrator__ literal', async () => {
    const messages = await messagesFor(DOMAIN, "export const id = '__orchestrator__:r1';\n");
    expect(messages.join('\n')).toContain('§17');
  });

  it('§20.1 — console in the daemon outside cli.ts', async () => {
    const messages = await messagesFor(DOMAIN, "export function f() { console.log('x'); }\n");
    expect(messages.join('\n')).toContain('no-console');
  });

  it('§20.1 — process.exit in the daemon outside cli.ts', async () => {
    const messages = await messagesFor(DOMAIN, 'export function f() { process.exit(1); }\n');
    expect(messages.join('\n')).toContain('§20.1');
  });

  it('§6 — a status property in the db layer', async () => {
    const messages = await messagesFor(DB, "export const row = { status: 'implementing' };\n");
    expect(messages.join('\n')).toContain('§6');
  });

  it('§5.4 — a direct websocket emit outside the broadcaster', async () => {
    const messages = await messagesFor(
      DOMAIN,
      'export function f(socket: { send(s: string): void }) { socket.send("x"); }\n',
    );
    expect(messages.join('\n')).toContain('§5.4');
  });

  it('§18.1 — the renderer importing daemon internals', async () => {
    const messages = await messagesFor(RENDERER, "import '@osade/daemon';\n");
    expect(messages.join('\n')).toContain('§18.1');
  });

  it('§20.1 — no any', async () => {
    const messages = await messagesFor(DOMAIN, 'export const x: any = 1;\n');
    expect(messages.join('\n')).toContain('no-explicit-any');
  });
});

describe('OSADE-MOSS §M.9.3 boundaries actually fire', () => {
  const MOSS_IMPORT = ["import { MossClient } from '@moss-js/moss';", 'export const x = MossClient;', ''].join(
    '\n',
  );
  const UPSERT = [
    'export async function f(port: { upsert(a: string, b: unknown[]): Promise<void> }) {',
    "  await port.upsert('turns', []);",
    '}',
    '',
  ].join('\n');
  const REMOVE = [
    'export async function f(port: { remove(a: string, b: string[]): Promise<void> }) {',
    "  await port.remove('turns', ['x']);",
    '}',
    '',
  ].join('\n');

  it('§M.1.2 — a Moss SDK is off-limits outside daemon/src/retrieval/**', async () => {
    expect((await messagesFor(DOMAIN, MOSS_IMPORT)).join('\n')).toContain('§M.1.2');
  });

  it('§M.1.2 — the frozen @moss-dev package is restricted too', async () => {
    const code = MOSS_IMPORT.replace('@moss-js/moss', '@moss-dev/moss');
    expect((await messagesFor(DOMAIN, code)).join('\n')).toContain('§M.1.2');
  });

  it('R1 — writing to the index from outside the indexer', async () => {
    expect((await messagesFor(DOMAIN, UPSERT)).join('\n')).toContain('§M.1.4 R1');
  });

  it('R1 — removing from the index from outside the indexer', async () => {
    expect((await messagesFor(DOMAIN, REMOVE)).join('\n')).toContain('§M.1.4 R1');
  });

  it('retrieval/** may import a Moss SDK — it is the one seam', async () => {
    const messages = await messagesFor('packages/daemon/src/retrieval/probe.ts', MOSS_IMPORT);
    expect(messages.join('\n')).not.toContain('§M.1.2');
  });

  const PARSER_IMPORT = [
    "import { Parser } from 'web-tree-sitter';",
    'export const x = Parser;',
    '',
  ].join('\n');

  it('§M.5.4 — a tree-sitter parser is off-limits outside knowledge/code/**', async () => {
    expect((await messagesFor(DOMAIN, PARSER_IMPORT)).join('\n')).toContain('§M.5.4');
  });

  it('§M.5.4 — the grammar package is restricted too', async () => {
    const code = PARSER_IMPORT.replace('web-tree-sitter', '@vscode/tree-sitter-wasm');
    expect((await messagesFor(DOMAIN, code)).join('\n')).toContain('§M.5.4');
  });

  it('knowledge/code/** may import a parser — it is the one seam', async () => {
    const messages = await messagesFor(
      'packages/daemon/src/knowledge/code/probe.ts',
      PARSER_IMPORT,
    );
    expect(messages.join('\n')).not.toContain('§M.5.4');
  });

  it("the indexer may write to the index — it is R1's one writer", async () => {
    const messages = await messagesFor('packages/daemon/src/retrieval/indexer.ts', UPSERT);
    expect(messages.join('\n')).not.toContain('§M.1.4 R1');
  });
});

describe('the scopes that are deliberately exempt stay exempt', () => {
  it('cli.ts may use console and process.exit — it is the one entry point', async () => {
    const messages = await messagesFor(
      'packages/daemon/src/cli.ts',
      "export function f() { console.log('x'); process.exit(0); }\n",
    );
    expect(messages.join('\n')).not.toContain('no-console');
    expect(messages.join('\n')).not.toContain('§20.1');
  });

  it('the CDC broadcaster may emit — that is its job', async () => {
    const messages = await messagesFor(
      'packages/daemon/src/server/cdc-broadcaster.ts',
      'export function f(socket: { send(s: string): void }) { socket.send("x"); }\n',
    );
    expect(messages.join('\n')).not.toContain('§5.4');
  });
});
